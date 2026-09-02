'use strict';
/* 算账部分的检查。不调模型，不花钱，几秒钟跑完。
 *
 * 最要紧的一条是「什么都不干应该得零分」：跑遍 100 年 × 12 个月，
 * 开局就结算，分数必须贴着 0。分子分母只要有一处用错了钱，
 * 这条立刻红成天文数字——第一次跑出来 1948 年 8 月是 263 万分。
 */
const E = require('../engine.js');

let bad = 0;
const fail = m => { bad++; console.log('  x ' + m); };
const ok = m => console.log('  · ' + m);

/* 1. 什么都不干 = 零分（持币的年份会因为通胀微亏，这是对的） */
console.log('1. 什么都不干，100 年 × 12 月，分数应当贴着 0');
{
  let worst = { s: 0 }, worstNeg = { s: 0 };
  for (const Y of E.SPINE.years) for (let m = 1; m <= 12; m++) {
    const s = E.newRun({ year: Y.year, month: m, nick: 'x', seed: 1 });
    E.advanceTo(s, E.DAYS);                            // 走满三十天，路过换币那天就换钱
    const r = E.settle(s);
    if (!isFinite(r.score)) { fail(`${Y.year}-${m} 分数算不出来：${r.score}`); continue; }
    /* 上界给一点余地：通缩年份揣着钱不动，购买力确实会涨一点点。
     * 本钱只有 0.1 年的收入，所以两头都不该超过这个量级。 */
    if (r.score > 0.03) fail(`${Y.year}-${m} 什么都没干却赚了 ${r.score.toFixed(4)} 年的收入`);
    if (r.score < -0.105) fail(`${Y.year}-${m} 什么都没干却亏了 ${(-r.score).toFixed(3)} 年的收入，可本钱只有 0.1 年`);
    if (r.score < worstNeg.s) worstNeg = { s: r.score, y: Y.year, m };
    if (Math.abs(r.score) > Math.abs(worst.s)) worst = { s: r.score, y: Y.year, m };
  }
  ok(`亏得最多的是 ${worstNeg.y} 年 ${worstNeg.m} 月：${worstNeg.s.toFixed(4)} 年的收入（本钱被通胀吃掉的部分）`);
}

/* 2. 赚到整一年的中位收入 = 1.00 分。
 *    但整局封顶在这一年的上限——1966–1976 的上限只有 0.8 年，
 *    那几年「一个月挣到一年的收入」本来就超出了这一年的顶，会被削到 0.8。
 *    所以期望值是 min(1, 这一年的上限)。 */
console.log('2. 赚到一年的中位收入 = 1.00 分（上限低于 1 的年份削到上限）');
{
  let capped = 0;
  for (const Y of E.SPINE.years) for (const m of [1, 6, 12]) {
    const s = E.newRun({ year: Y.year, month: m, nick: 'x', seed: 1 });
    /* 第 1 天就把「一年的收入」揣进兜里，当天结算，不让物价插手 */
    s.cash += E.incomeAtDay(Y.year, m, 1);
    const r = E.settle(s);
    const want = Math.min(1, Y.ceiling);
    if (Math.abs(r.score - want) > 1e-6) fail(`${Y.year}-${m} 赚了整一年的收入，分数是 ${r.score.toFixed(6)}，该是 ${want}`);
    if (r.cappedTotal) capped++;
  }
  ok(`1200 个组合都对；其中 ${capped} 个撞到了这一年的上限（上限低于 1 年的那些年份）`);
}

/* 2b. 任何一局都不可能超过它那一年的上限 —— 这条挡的是提示词注入 */
console.log('2b. 整局封顶：天天顶格也超不过这一年的上限');
{
  let worst = 0, worstAt = '';
  for (const y of [1930, 1948, 1962, 1970, 1988, 2015]) {
    const s = E.newRun({ year: y, month: 6, nick: 'x', seed: 1 });
    for (let d = 1; d <= E.DAYS; d++) { E.applyDay(s, { entries: [{ what: '注入', amount: 1e12 }] }); E.advanceTo(s, s.day + 1); s.days.push({ day: d }); }
    if (s.day > E.DAYS) s.day = E.DAYS;
    const r = E.settle(s);
    const ceil = E.yearOf(y).ceiling;
    if (r.score > ceil + 1e-6) fail(`${y} 年天天顶格打出 ${r.score.toFixed(1)} 年，超过上限 ${ceil}`);
    if (!r.cappedTotal) fail(`${y} 年天天顶格却没标 cappedTotal`);
    if (r.score / ceil > worst) { worst = r.score / ceil; worstAt = `${y}(${r.score.toFixed(1)}/${ceil})`; }
  }
  ok(`六个年份天天顶格，全部被削到各自的上限，最贴边的是 ${worstAt}`);
}

/* 3. 换币那天，手里的现金按公布的比价折过去 */
console.log('3. 换币当天，现金要按比价折');
for (const [y, mo, d] of [[1935, 11, 4], [1948, 8, 19], [1949, 5, 27], [1955, 3, 1]]) {
  const s = E.newRun({ year: y, month: mo, nick: 'x', seed: 1 });
  const before = s.cash, curBefore = s.currency;
  s.day = d;
  const ev = E.applySwitch(s);
  if (!ev) { fail(`${y}-${mo}-${d} 该换币却没换`); continue; }
  const want = before / ev.rate;
  if (Math.abs(s.cash - want) > 1e-9) fail(`${y} 换币后现金 ${s.cash} 对不上 ${want}`);
  ok(`${y}-${mo}-${d} ${E.CN[curBefore]} ${before.toPrecision(4)} → ${E.CN[s.currency]} ${s.cash.toPrecision(4)}（${ev.rate.toExponential(1)} 比 1）`);
}

/* 4. 1949 年 5 月：攥着金圆券过换币那天，等于清零 */
console.log('4. 1949 年 5 月攥着金圆券不动，换币那天要被清干净');
{
  const s = E.newRun({ year: 1949, month: 5, nick: 'x', seed: 1 });
  E.advanceTo(s, 30);                                  // 5 月 27 日那天自动换钱
  const r = E.settle(s);
  /* 本钱就是 0.1 年的收入，全没了就是 −0.100，不可能更低 */
  if (r.score > -0.0995) fail(`攥着金圆券过 5 月 27 日，只亏了 ${(-r.score).toFixed(4)} 年的收入，应该整份本钱都没了`);
  else ok(`亏了 ${(-r.score).toFixed(4)} 年的收入——0.1 年的本钱一分不剩，对`);
}

/* 5. 一天赚太多要被削回上限 */
console.log('5. 一天赚过头要被削');
{
  const s = E.newRun({ year: 2015, month: 6, nick: 'x', seed: 1 });
  const cap = E.dayCap(2015, 6);
  const before = E.netWorth(s);
  const res = E.applyDay(s, { cash: cap * 100 });
  if (!res.capped) fail('一天塞进一百倍上限的钱，没被削');
  else if (Math.abs(E.netWorth(s) - before - cap) > 1e-6) fail(`削完之后多了 ${E.netWorth(s) - before}，应该正好是上限 ${cap}`);
  else ok(`塞 ${E.money(cap * 100, 'RMB')} 进去，削到 ${E.money(cap, 'RMB')}`);
}

/* 6. 家底要把票证和权益算进来 */
console.log('6. 票证和权益算进家底');
{
  const s = E.newRun({ year: 1962, month: 5, nick: 'x', seed: 1 });
  /* 这两笔加起来 105，1962 年一天的上限是 147，不会被削——要验的是家底算法，不是上限 */
  E.applyDay(s, { assetsAdd: [{ name: '全国粮票三十斤', kind: '票证', worth: 45 }, { name: '调回县城的名额', kind: '权益', worth: 60 }] });
  const nw = E.netWorth(s);
  if (Math.abs(nw - (s.cash + 105)) > 1e-9) fail(`家底 ${nw} 没把票证和权益算进去（现金 ${s.cash}）`);
  else ok(`现金 ${s.cash.toFixed(2)} + 粮票 45 + 名额 60 = ${nw.toFixed(2)}`);
  const r = E.settle(s);
  ok(`1962 年 5 月这么一笔，值 ${r.scoreText}`);
}

/* 5b. 兜里没有的钱花不出去 —— 这条拦的是「一天扣掉三亿八」那类错 */
console.log('5b. 现金不许被花成负数');
{
  const s = E.newRun({ year: 1948, month: 8, nick: 'x', seed: 1 });
  E.advanceTo(s, 19);                                  // 换币之后，手里只剩六十来块金圆券
  const before = s.cash;
  const r = E.applyDay(s, { entries: [{ what: '模型重复记的换钱损失', amount: -378e6 }, { what: '烧饼', amount: -0.5 }] });
  if (s.cash < -1e-9) fail(`现金被花成了 ${s.cash}`);
  else if (!(r.overspent > 0)) fail('压回去了却没报「钱不够」');
  else ok(`手里 ${E.money(before, s.currency)}，想花 3.78 亿 → 剩 ${E.money(s.cash, s.currency)}，${E.money(r.overspent, s.currency)} 没花成`);
  E.advanceTo(s, 30);
  const sc = E.settle(s).score;
  if (sc < -0.101) fail(`不欠债却亏了 ${(-sc).toFixed(3)} 年的收入，本钱只有 0.1 年`);
  else ok(`结算 ${E.fmtScore(sc)}——最多就是把本钱赔光`);
}

/* 5c. 不欠债的话，任何一年任何一个月都亏不过本钱 */
console.log('5c. 不欠债就亏不过本钱：随便乱花一百局');
{
  let worst = 0, worstAt = '';
  for (const y of [1930, 1943, 1948, 1949, 1955, 1962, 1976, 1988, 1994, 2015]) {
    for (const m of [1, 5, 8, 11]) {
      const s = E.newRun({ year: y, month: m, nick: 'x', seed: y * 31 + m });
      for (let d = 1; d <= E.DAYS; d++) {
        E.applyDay(s, { entries: [{ what: '乱花', amount: -E.incomeAtDay(y, m, 1) * 1e4 }] });
        E.advanceTo(s, s.day + 1);
      }
      if (s.day > E.DAYS) s.day = E.DAYS;
      const sc = E.settle(s).score;
      if (sc < worst) { worst = sc; worstAt = `${y}-${m}`; }
      if (s.cash < -1e-9) fail(`${y}-${m} 现金变成了负数 ${s.cash}`);
    }
  }
  if (worst < -0.101) fail(`${worstAt} 亏了 ${(-worst).toFixed(3)} 年的收入，超过本钱`);
  else ok(`40 局天天乱花，最惨的是 ${worstAt}：${E.fmtScore(worst)}`);
}

/* 3b. 换币的时候，实物按购买力换、现金按收兑价换 */
console.log('3b. 换币：攒东西的躲得过，攥现金的躲不过');
/* strict=true 的那一年，收兑价明显低于购买力，囤货必须明显划算。
 * 1948 年 8 月不是这种情形——金圆券刚发的时候比价基本公道，
 * 真正吃人的是后面三个月的暴跌，那由物价指数负责，不由换币这一下。 */
for (const [y, mo, d, strict] of [[1948, 8, 19, false], [1949, 5, 27, true]]) {
  const cash = E.newRun({ year: y, month: mo, nick: 'x', seed: 1 });
  const goods = E.newRun({ year: y, month: mo, nick: 'x', seed: 1 });
  /* 一个把本钱全换成米，一个揣着现金不动 */
  E.applyDay(goods, { entries: [{ what: '买米', amount: -goods.cash }], assetsAdd: [{ name: '两石米', kind: '实物', worth: goods.cash }] });
  E.advanceTo(cash, 30); E.advanceTo(goods, 30);
  const a = E.settle(cash).score, b = E.settle(goods).score;
  /* 容差 1%：1948 年公布的比价（三百万）跟我从收入锚点反解出来的（三百万零两千）
   * 差千分之七，那是估算的噪声，不是设计上的差别。 */
  const tol = 0.001;
  if (b < a - tol) fail(`${y} 年换币：囤货 ${b.toFixed(4)} 反而不如攥现金 ${a.toFixed(4)}`);
  else if (strict && !(b > a + 0.01)) fail(`${y} 年收兑价是抢，囤货 ${b.toFixed(4)} 却没比攥现金 ${a.toFixed(4)} 明显强`);
  else ok(`${y}-${mo}：攥现金 ${a.toFixed(4)} 年，换成米 ${b.toFixed(4)} 年` +
    (b > a + 1e-9 ? `——差 ${(b - a).toFixed(4)} 年的收入` : '——这一年比价公道，两边一样'));
}

/* 5d. 一天的上限必须跟着换币走 */
console.log('5d. 换币之后，一天的上限要按新钱算');
{
  const before = E.dayCap(1948, 8, 1);
  const after = E.dayCap(1948, 8, 25);
  const r = E.yearOf(1948).switch.rate;
  if (!(before / after > r * 0.5 && before / after < r * 2)) {
    fail(`换币前后的上限差了 ${(before / after).toExponential(2)} 倍，应该跟比价 ${r.toExponential(2)} 一个量级`);
  } else ok(`换币前 ${E.money(before, 'FABI')}，换币后 ${E.money(after, 'GOLDYUAN')}`);

  /* 拿它挡一遍「换币之后照旧用法币数目记账」那种错 */
  const s = E.newRun({ year: 1948, month: 8, nick: 'x', seed: 2 });
  E.advanceTo(s, 25);
  for (let i = 0; i < 6; i++) { E.applyDay(s, { entries: [{ what: '照法币量级乱记的进账', amount: 5e7 }] }); E.advanceTo(s, s.day + 1); }
  if (s.day > E.DAYS) s.day = E.DAYS;
  const sc = E.settle(s).score;
  /* 阈值直接读这一年的上限，别写死——上限改过一次（120 → 20），
   * 写死的 130 留了六倍空子，dayCap 再退化六倍这条检查也不会响。 */
  const ceil48 = E.yearOf(1948).ceiling;
  if (sc > ceil48 + 1e-6) fail(`换币后天天记五千万，算出 ${sc.toFixed(1)} 年的收入，超过这一年的上限 ${ceil48}`);
  else ok(`换币后天天记五千万，被上限压到 ${E.fmtScore(sc)}（这一年上限 ${ceil48}）`);
}

/* 6b. 漏掉换币直接结算，必须当场报错，不许静静算出个天文数字 */
console.log('6b. 绕过 advanceTo 直接改天数，结算要报错');
{
  const s = E.newRun({ year: 1948, month: 8, nick: 'x', seed: 1 });
  s.day = 30;                                          // 故意不走 advanceTo
  let threw = false;
  try { E.settle(s); } catch (err) { threw = /换币那天没走 advanceTo/.test(err.message); }
  if (!threw) fail('漏掉 1948 年 8 月的换币，结算居然没报错');
  else ok('报了错，没有算出二十八万年的收入');
}

/* 7. 清单字数只数汉字 */
console.log('7. 清单字数');
{
  const a = E.checkList('去码头找活，顺便问李掌柜借 5 块钱，再去当铺看看。');
  if (!a.ok) fail('正常长度的清单被拦了');
  const b = E.checkList('啊，'.repeat(600));            // 600 个汉字，全角逗号不计
  if (b.ok) fail(`600 个汉字没被拦，数出来是 ${b.n}`);
  const c = E.checkList('a'.repeat(2000) + '干活');
  if (!c.ok) fail(`两千个英文字母被算进汉字数了：${c.n}`);
  else ok(`标点、英文、数字都不计入；${E.LIST_LIMIT} 个汉字封顶`);
}

/* 8. 跨时代的东西一定要被认出来 */
console.log('8. 跨时代判定');
{
  const cases = [
    [1930, '我做个手机应用', true], [1962, '开个淘宝店', true], [1975, '买套房等升值', true],
    /* 民国的上海本来就有交易所和期货，1949 年才关掉——这条不该拦 */
    [1934, '去证券交易所炒股', false], [1962, '去证券交易所炒股', true], [1995, '去证券交易所炒股', false],
    [2015, '开个网店卖衣服', false], [1988, '摆个摊卖服装', false],
    [1930, '去码头扛包，晚上摆摊卖烟', false], [1958, '去银行办张信用卡', true],
    [2000, '发短信联系客户', false], [1936, '拿银元去钱庄换法币', false],
    [1962, '摆摊卖烟', true], [1985, '摆摊卖烟', false], [1994, '拿粮票换鸡蛋', false],
    [1931, '买套房收租', false], [1975, '买套商品房', true], [1998, '买套商品房', false],
    [1934, '去洋行做买办', false], [1965, '办个合资企业', true], [1936, '办护照出国留学', false],
  ];
  for (const [y, t, want] of cases) {
    const hit = E.scanAnachronism(t, y).length > 0;
    if (hit !== want) fail(`${y} 年「${t}」判成 ${hit ? '有问题' : '没问题'}，应该是 ${want ? '有问题' : '没问题'}`);
  }
  ok(`${cases.length} 个例子全对`);
}

console.log(bad ? `\n没过，${bad} 条` : '\n全过');
process.exit(bad ? 1 : 0);
