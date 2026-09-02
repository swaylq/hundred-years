'use strict';
/* 算账部分的检查。不调模型，不花钱，几秒钟跑完。
 *
 * 最要紧的一条是「什么都不干应该得零分」：跑遍 100 年 × 12 个月，
 * 开局就结算，分数必须贴着 0。分子分母只要有一处用错了钱，
 * 这条立刻红成天文数字——第一次跑出来 1948 年 8 月是 263 万分。
 *
 * 一局是二十四个月。换币算在那个月的月初：走进 1948 年 8 月，
 * 手里的法币当场折成金圆券，这个月整月按新钱记。
 */
const E = require('../engine.js');

let bad = 0;
const fail = m => { bad++; console.log('  x ' + m); };
const ok = m => console.log('  · ' + m);

/** 从某年某月起走满二十四个月，每个月都记一笔（不写 months 的话整局封顶没法按走过的年份算） */
function walk(year, month, each) {
  const s = E.newRun({ year, month, nick: 'x', seed: year * 31 + month });
  const events = [];
  for (let i = 1; i <= E.MONTHS; i++) {
    if (each) each(s, i);
    s.months.push({ n: s.n, year: s.year, month: s.month });
    if (i < E.MONTHS) events.push(...E.advanceTo(s, i + 1));
    else { const ev = E.closeOut(s); if (ev) events.push(ev); }
  }
  return { s, events };
}

/* 1. 什么都不干 = 零分（持币的年份会因为通胀微亏，这是对的） */
console.log('1. 什么都不干，100 年 × 12 月，分数应当贴着 0');
{
  let worst = { s: 0 }, worstNeg = { s: 0 }, n = 0;
  for (const Y of E.SPINE.years) for (let m = 1; m <= 12; m++) {
    if (!E.startable(Y.year, m)) continue;
    n++;
    const { s } = walk(Y.year, m);
    const r = E.settle(s);
    if (!isFinite(r.score)) { fail(`${Y.year}-${m} 分数算不出来：${r.score}`); continue; }
    /* 上界给一点余地：通缩年份揣着钱不动，购买力确实会涨一点点。
     * 本钱只有 0.1 年的收入，所以两头都不该超过这个量级。 */
    if (r.score > 0.05) fail(`${Y.year}-${m} 什么都没干却赚了 ${r.score.toFixed(4)} 年的收入`);
    if (r.score < -0.105) fail(`${Y.year}-${m} 什么都没干却亏了 ${(-r.score).toFixed(3)} 年的收入，可本钱只有 0.1 年`);
    if (r.score < worstNeg.s) worstNeg = { s: r.score, y: Y.year, m };
    if (Math.abs(r.score) > Math.abs(worst.s)) worst = { s: r.score, y: Y.year, m };
  }
  ok(`${n} 个开局都跑了；亏得最多的是 ${worstNeg.y} 年 ${worstNeg.m} 月：${worstNeg.s.toFixed(4)} 年的收入（本钱被通胀吃掉的部分）`);
}

/* 2. 开局就把一年的收入揣进兜里，当月结算 = 1.00 分 */
console.log('2. 揣着一年的收入当月结算 = 1.00 分');
{
  let n = 0;
  for (const Y of E.SPINE.years) for (const m of [1, 6, 12]) {
    if (!E.startable(Y.year, m)) continue;
    const s = E.newRun({ year: Y.year, month: m, nick: 'x', seed: 1 });
    s.cash += E.incomeOf(Y.year, m);
    s.months.push({ n: 1, year: Y.year, month: m });
    const r = E.settle(s);
    if (Math.abs(r.score - 1) > 1e-6) fail(`${Y.year}-${m} 揣了整一年的收入，分数是 ${r.score.toFixed(6)}，该是 1`);
    n++;
  }
  ok(`${n} 个组合都对`);
}

/* 2b. 任何一局都不可能超过整局的上限 —— 这条挡的是提示词注入 */
console.log('2b. 整局封顶：月月顶格也超不过「平均每月上限 × 6」');
{
  let worst = 0, worstAt = '';
  for (const y of [1930, 1948, 1962, 1970, 1988, 2015]) {
    const { s } = walk(y, 6, st => E.applyMonth(st, { entries: [{ what: '注入', amount: 1e13 }] }));
    const r = E.settle(s);
    if (r.score > r.ceiling + 1e-6) fail(`${y} 年月月顶格打出 ${r.score.toFixed(1)} 年，超过整局上限 ${r.ceiling.toFixed(1)}`);
    if (r.capHits < E.MONTHS) fail(`${y} 年月月顶格，削顶只记了 ${r.capHits} 次，该是 ${E.MONTHS} 次`);
    const ratio = r.score / r.ceiling;
    if (ratio > worst) { worst = ratio; worstAt = `${y}(${r.score.toFixed(1)}/${r.ceiling.toFixed(1)})`; }
  }
  ok(`六个年份月月顶格，全部压在各自的上限之内，最贴边的是 ${worstAt}`);
}

/* 3. 换币的月份整月按旧钱过，月底那一下现金按公布的比价折过去 */
console.log('3. 换币那个月过完，现金要按比价折');
for (const [y, mo] of [[1935, 11], [1948, 8], [1949, 5], [1955, 3]]) {
  const sw = E.yearOf(y).switch;
  /* 换币那天是 1 号的（1955-03-01），这个月一天旧钱都没有：从上个月开局，
     走进这个月的时候就折。其余的月中换币，整月按旧钱过，月底才折。 */
  const day1 = sw.day <= 1;
  const from = day1 ? (mo === 1 ? { year: y - 1, month: 12 } : { year: y, month: mo - 1 }) : { year: y, month: mo };
  const s = E.newRun({ year: from.year, month: from.month, nick: 'x', seed: 1 });
  const before = s.cash, curBefore = s.currency;
  if (curBefore !== sw.from) fail(`${from.year}-${from.month} 开局手里该是${E.CN[sw.from]}，实际${E.CN[curBefore]}`);
  const ev = E.advanceTo(s, 2);
  if (!ev.length) { fail(`${y}-${mo} 该换币却没换`); continue; }
  const want = before / ev[0].rate;
  if (Math.abs(s.cash - want) > 1e-9) fail(`${y} 换币后现金 ${s.cash} 对不上 ${want}`);
  else ok(`${y}-${mo} ${E.CN[curBefore]} ${before.toPrecision(4)} → ${E.CN[s.currency]} ${s.cash.toPrecision(4)}（${ev[0].rate.toExponential(1)} 比 1）`);
}

/* 4. 1949 年 5 月：攥着金圆券过完那个月，等于清零 */
console.log('4. 攥着金圆券过完 1949 年 5 月，要被清干净');
{
  const s = E.newRun({ year: 1949, month: 5, nick: 'x', seed: 1 });
  s.months.push({ n: 1, year: 1949, month: 5 });
  E.advanceTo(s, 2);
  s.months.push({ n: 2, year: s.year, month: s.month });
  const r = E.settle(s);
  /* 本钱就是 0.1 年的收入，全没了就是 −0.100，不可能更低 */
  if (r.score > -0.0995) fail(`攥着金圆券走进 5 月，只亏了 ${(-r.score).toFixed(4)} 年的收入，应该整份本钱都没了`);
  else ok(`亏了 ${(-r.score).toFixed(4)} 年的收入——0.1 年的本钱一分不剩，对`);
}

/* 4b. 二十四个月里连撞两次换钱 —— 一局最多就是两次，这条路以前从来没走过 */
console.log('4b. 1947 年 6 月开局：一局之内换两次钱');
{
  const { s, events } = walk(1947, 6);
  if (events.length !== 2) fail(`1947-06 开局该撞两次换钱，实际 ${events.length} 次`);
  if (!(s.year === 1949 && s.month === 5)) fail(`走完二十四个月该停在 1949 年 5 月，实际 ${s.year}-${s.month}`);
  if (s.currency !== 'RMB1') fail(`收工手里该是人民币（旧），实际 ${E.CN[s.currency]}`);
  let threw = null;
  try { E.settle(s); } catch (e) { threw = e.message; }
  if (threw) fail('连换两次钱之后结算报错：' + threw);
  else {
    const r = E.settle(s);
    if (!(r.score < -0.0995)) fail(`攥着钱穿过两次换币，只亏了 ${(-r.score).toFixed(4)} 年，该把本钱赔光`);
    else ok(`两次换钱（${events.map(e => e.cur).map(c => E.CN[c]).join(' → ')}），结算 ${r.scoreText}`);
  }
  /* 同一段日子，换成实物的那一个必须明显强过攥现金的 */
  const g = walk(1947, 6, (st, i) => {
    if (i === 1) E.applyMonth(st, { entries: [{ what: '买米', amount: -st.cash }], assetsAdd: [{ name: '米', kind: '实物', worth: st.cash }] });
  });
  const a = E.settle(s).score, b = E.settle(g.s).score;
  if (!(b > a + 0.05)) fail(`穿过两次换币，囤货 ${b.toFixed(4)} 没比攥现金 ${a.toFixed(4)} 明显强`);
  else if (Math.abs(b) > 0.02) fail(`囤货穿过两次换币应当基本保值，却是 ${b.toFixed(4)} 年`);
  else ok(`攥现金 ${a.toFixed(4)} 年（赔光），换成米 ${b.toFixed(4)} 年（保住了）`);
}

/* 5. 一个月赚太多要被削回上限 */
console.log('5. 一个月赚过头要被削');
{
  const s = E.newRun({ year: 2015, month: 6, nick: 'x', seed: 1 });
  const cap = E.monthCap(2015, 6);
  const before = E.netWorth(s);
  const res = E.applyMonth(s, { cash: cap * 100 });
  if (!res.capped) fail('一个月塞进一百倍上限的钱，没被削');
  else if (Math.abs(E.netWorth(s) - before - cap) > 1e-6) fail(`削完之后多了 ${E.netWorth(s) - before}，应该正好是上限 ${cap}`);
  else ok(`塞 ${E.money(cap * 100, 'RMB')} 进去，削到 ${E.money(cap, 'RMB')}`);
}

/* 6. 家底要把票证和权益算进来 */
console.log('6. 票证和权益算进家底');
{
  const s = E.newRun({ year: 1962, month: 5, nick: 'x', seed: 1 });
  /* 这两笔加起来 105，1962 年一个月的上限是七百多，不会被削——要验的是家底算法，不是上限 */
  E.applyMonth(s, { assetsAdd: [{ name: '全国粮票三十斤', kind: '票证', worth: 45 }, { name: '调回县城的名额', kind: '权益', worth: 60 }] });
  const nw = E.netWorth(s);
  if (Math.abs(nw - (s.cash + 105)) > 1e-9) fail(`家底 ${nw} 没把票证和权益算进去（现金 ${s.cash}）`);
  else ok(`现金 ${s.cash.toFixed(2)} + 粮票 45 + 名额 60 = ${nw.toFixed(2)}`);
  s.months.push({ n: 1, year: 1962, month: 5 });
  ok(`1962 年 5 月这么一笔，值 ${E.settle(s).scoreText}`);
}

/* 5b. 兜里没有的钱花不出去 —— 这条拦的是「一个月扣掉三亿八」那类错 */
console.log('5b. 现金不许被花成负数');
{
  const s = E.newRun({ year: 1948, month: 8, nick: 'x', seed: 1 });   // 月初就已经是金圆券
  const before = s.cash;
  const r = E.applyMonth(s, { entries: [{ what: '模型重复记的换钱损失', amount: -378e6 }, { what: '烧饼', amount: -0.5 }] });
  if (s.cash < -1e-9) fail(`现金被花成了 ${s.cash}`);
  else if (!(r.overspent > 0)) fail('压回去了却没报「钱不够」');
  else ok(`手里 ${E.money(before, s.currency)}，想花 3.78 亿 → 剩 ${E.money(s.cash, s.currency)}，${E.money(r.overspent, s.currency)} 没花成`);
  s.months.push({ n: 1, year: 1948, month: 8 });
  const sc = E.settle(s).score;
  if (sc < -0.101) fail(`不欠债却亏了 ${(-sc).toFixed(3)} 年的收入，本钱只有 0.1 年`);
  else ok(`结算 ${E.fmtScore(sc)}——最多就是把本钱赔光`);
}

/* 5c. 不欠债的话，任何一年任何一个月都亏不过本钱 */
console.log('5c. 不欠债就亏不过本钱：随便乱花四十局');
{
  let worst = 0, worstAt = '';
  for (const y of [1930, 1943, 1948, 1949, 1955, 1962, 1976, 1988, 1994, 2015]) {
    for (const m of [1, 5, 8, 11]) {
      const { s } = walk(y, m, st => E.applyMonth(st, { entries: [{ what: '乱花', amount: -E.incomeOf(st.year, st.month) * 1e4 }] }));
      const sc = E.settle(s).score;
      if (sc < worst) { worst = sc; worstAt = `${y}-${m}`; }
      if (s.cash < -1e-9) fail(`${y}-${m} 现金变成了负数 ${s.cash}`);
    }
  }
  if (worst < -0.101) fail(`${worstAt} 亏了 ${(-worst).toFixed(3)} 年的收入，超过本钱`);
  else ok(`40 局月月乱花，最惨的是 ${worstAt}：${E.fmtScore(worst)}`);
}

/* 3b. 换币的时候，实物按购买力换、现金按收兑价换 */
console.log('3b. 换币：攒东西的躲得过，攥现金的躲不过');
/* strict=true 的那一年，收兑价明显低于购买力，囤货必须明显划算。
 * 1948 年 8 月不是这种情形——金圆券刚发的时候比价基本公道，
 * 真正吃人的是后面三个月的暴跌，那由物价指数负责，不由换币这一下。 */
for (const [y, mo, strict] of [[1948, 8, false], [1949, 5, true]]) {
  const cash = E.newRun({ year: y, month: mo, nick: 'x', seed: 1 });
  const goods = E.newRun({ year: y, month: mo, nick: 'x', seed: 1 });
  E.applyMonth(goods, { entries: [{ what: '买米', amount: -goods.cash }], assetsAdd: [{ name: '两石米', kind: '实物', worth: goods.cash }] });
  for (const st of [cash, goods]) {
    st.months.push({ n: 1, year: st.year, month: st.month });
    E.advanceTo(st, 2);
    st.months.push({ n: 2, year: st.year, month: st.month });
  }
  const a = E.settle(cash).score, b = E.settle(goods).score;
  /* 容差 1‰：1948 年公布的比价（三百万）跟我从收入锚点反解出来的（三百万零两千）
   * 差千分之七，那是估算的噪声，不是设计上的差别。 */
  const tol = 0.001;
  if (b < a - tol) fail(`${y} 年换币：囤货 ${b.toFixed(4)} 反而不如攥现金 ${a.toFixed(4)}`);
  else if (strict && !(b > a + 0.01)) fail(`${y} 年收兑价是抢，囤货 ${b.toFixed(4)} 却没比攥现金 ${a.toFixed(4)} 明显强`);
  else ok(`${y}-${mo}：攥现金 ${a.toFixed(4)} 年，换成米 ${b.toFixed(4)} 年` +
    (b > a + 1e-9 ? `——差 ${(b - a).toFixed(4)} 年的收入` : '——这一年比价公道，两边一样'));
}

/* 5d. 一个月的上限必须跟着换币走 */
console.log('5d. 换币之后，一个月的上限要按新钱算');
{
  const before = E.monthCap(1948, 8);          // 换币那个月整月按法币过
  const after = E.monthCap(1948, 9);           // 下个月起是金圆券
  const r = E.yearOf(1948).switch.rate;
  if (!(before / after > r * 0.5 && before / after < r * 2)) {
    fail(`换币前后的上限差了 ${(before / after).toExponential(2)} 倍，应该跟比价 ${r.toExponential(2)} 一个量级`);
  } else ok(`换币前 ${E.money(before, 'FABI')}，换币后 ${E.money(after, 'GOLDYUAN')}`);

  /* 拿它挡一遍「换币之后照旧用法币数目记账」那种错 */
  const { s } = walk(1948, 8, st => E.applyMonth(st, { entries: [{ what: '照法币量级乱记的进账', amount: 5e7 }] }));
  const r2 = E.settle(s);
  if (r2.score > r2.ceiling + 1e-6) fail(`换币后月月记五千万，算出 ${r2.score.toFixed(1)} 年的收入，超过整局上限 ${r2.ceiling.toFixed(1)}`);
  else ok(`换币后月月记五千万，被上限压到 ${E.fmtScore(r2.score)}（整局上限 ${r2.ceiling.toFixed(1)}）`);
}

/* 6b. 绕过 advanceTo 直接改月份，结算要当场报错，不许静静算出个天文数字 */
console.log('6b. 绕过 advanceTo 直接改月份，结算要报错');
{
  const s = E.newRun({ year: 1948, month: 8, nick: 'x', seed: 1 });
  s.month = 9; s.n = 2;                                // 故意不走 advanceTo，换币就漏了
  s.months.push({ n: 1, year: 1948, month: 8 });
  let threw = false;
  try { E.settle(s); } catch (err) { threw = /没走 advanceTo/.test(err.message); }
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

/* 7b. 二十四个月要走得完：最晚只能从 2024 年 1 月开局 */
console.log('7b. 开局月份的边界');
{
  const cases = [[2023, 12, true], [2024, 1, true], [2024, 2, false], [2025, 1, false], [1926, 1, true]];
  for (const [y, m, want] of cases) {
    if (E.startable(y, m) !== want) fail(`${y}-${m} 能不能开局判成了 ${!want}`);
  }
  const last = E.SPINE.years[E.SPINE.years.length - 1].year;
  ok(`年卡到 ${last} 年 12 月为止，最晚从 2024 年 1 月开局`);
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

/* 9. 一整个月的账写小了几个数量级，要被认出来补回去。
 *    真事：1948 年 3 月那一局，正文写「交了五百万的保护费」，账上记的是 −500。
 *    提示词的尺子写成「3266.00 万法币」，模型照着写下 3500 当成完整数目。 */
console.log('9. 整月的账塌了一个数量级，要补回来');
{
  const slipped = { entries: [
    { what: '购买三十石大米货款', amount: -1800 }, { what: '巡捕房保护费', amount: -500 },
    { what: '大米分销所得货款', amount: 3500 }, { what: '雇佣卸货工人劳务费', amount: -80 },
  ], assetsAdd: [{ name: '仓里的米', worth: 1800 }], debtsAdd: [{ who: '老黄', amount: 200 }] };
  const r = E.fixScale({ year: 1948, month: 3 }, slipped);
  if (!r || r.k !== 1e4) fail(`1948-3 该补四个零，实际 ${r ? r.k : '一个没补'}`);
  else if (slipped.entries[1].amount !== -5000000) fail(`保护费补完该是 −5000000，实际 ${slipped.entries[1].amount}`);
  else if (slipped.assetsAdd[0].worth !== 18000000 || slipped.debtsAdd[0].amount !== 2000000)
    fail('东西和欠债跟分录是一次写出来的，得一起补');
  else ok('1948-3 那一屏：正文的「五百万」跟账上的 500 对不上，补四个零之后对上了');

  /* 量级本来就对的月份，一分钱都不许动 */
  let moved = 0;
  for (const [y, m, amts] of [[1948, 3, [12000000, -1500000]], [1962, 5, [42, -3]],
                              [1930, 10, [30, -12]], [1995, 7, [1800, -600]]]) {
    const d = { entries: amts.map((a, i) => ({ what: 'x' + i, amount: a })) };
    if (E.fixScale({ year: y, month: m }, d)) moved++;
  }
  if (moved) fail(`${moved} 个量级正常的月份被误改了`);
  else ok('四个量级正常的月份一分钱没动（1962 年月薪 42 元这种小数目也没被当成写错）');
}

/* 10. 一张账单上只许有一个单位 */
console.log('10. 整张账单一个单位');
{
  /* 判据挑写法，不挑数值：把每个钱数的「小数位数 + 单位词」抽出来，全账单必须只有一种。
     光比单位词是漏的——「1800 法币」和「80.00 法币」单位一样，写法还是两种。 */
  const shapes = line => [...String(line).matchAll(/(-?\d+)(\.(\d+))? ((?:万亿|亿|万)?法币)/g)]
    .map(m => `${m[3] ? m[3].length : 0} 位小数的${m[4]}`);
  const oneShape = (name, ents) => {
    const line = E.tallyLine(ents, 'FABI');
    const kinds = [...new Set(shapes(line))];
    if (kinds.length !== 1) fail(`${name}：同一张账单上出现了 ${kinds.join(' / ')} —— ${line}`);
    else ok(`${name}：整张写成「${kinds[0]}」 —— ${line.slice(0, 30)}…`);
  };
  oneShape('截图那一屏（1800 / 80 / 3500）', [{ what: 'a', amount: -1800 }, { what: 'b', amount: -80 }, { what: 'c', amount: 3500 }]);
  oneShape('6.8 亿跟 800 万排在一起', [{ what: 'a', amount: 680000000 }, { what: 'b', amount: -8000000 }]);
  oneShape('几十块的小月份', [{ what: 'a', amount: 42 }, { what: 'b', amount: -3.5 }]);
}

/* 11. 一整个月一笔出账都没有 —— 房租和伙食被记成了进账 */
console.log('11. 一笔出账都没有的月份，负号要补回去');
{
  /* 1926 年 11 月那一屏的原样：六笔全绿，连房租都是收的 */
  const d = { entries: [
    { what: '码头扛包工钱', amount: 12 }, { what: '协助客商整理库存抽成', amount: 4 },
    { what: '一个月伙食费', amount: 3.8 }, { what: '一个月房租', amount: 3 },
    { what: '买煤油及火柴', amount: 0.5 }, { what: '给码头管事的小茶钱', amount: 0.5 },
  ] };
  const r = E.fixSigns(d);
  const sum = d.entries.reduce((t, e) => t + e.amount, 0);
  const 挣 = d.entries.filter(e => e.amount > 0).map(e => e.what);
  if (!r || r.flipped.length !== 4) fail(`该翻四笔，实际翻了 ${r ? r.flipped.length : 0} 笔`);
  else if (挣.length !== 2) fail(`工钱和抽成不该被翻：还剩 ${挣.join('、')}`);
  else if (Math.abs(sum - 8.2) > 1e-9) fail(`翻完净进该是 8.2，实际 ${sum}`);
  else ok(`伙食、房租、买煤油、茶钱翻成出账，工钱和抽成不动；净进从 23.8 变成 ${sum.toFixed(2)}`);

  /* 只要这个月已经有一笔出账，就说明模型知道规矩，一笔都不许动 */
  const 有出账 = { entries: [
    { what: '卖布所得', amount: 100 }, { what: '一个月房租', amount: -3 }, { what: '一个月伙食费', amount: 4 },
  ] };
  if (E.fixSigns(有出账)) fail('这个月已经记了出账，不该再翻别的');
  else ok('月里已经有出账的，一笔都不动（模型知道规矩，那笔多半真是收回来的）');

  /* 名字看不出在花钱的，不许瞎翻 */
  const 看不出 = { entries: [
    { what: '维修水泵的酬劳', amount: 30 }, { what: '收回押金', amount: 20 }, { what: '卖废铜', amount: 8 },
  ] };
  if (E.fixSigns(看不出)) fail('三笔都是进账，不该翻');
  else ok('名字里看不出在花钱的，一笔不翻');
}

/* 12. 印在页面上的「为什么这个月没经过大模型」只能是写死的中文句子。
 *     静态扫源码，不开浏览器：这句话挂在「调模型失败」那条分支上，
 *     走查跑的那条路根本不走它，扫渲染出来的页面永远是绿的。 */
console.log('12. 服务商回的原话不许印到页面上');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const 赋值 = [...src.matchAll(/out\.why\s*=\s*([^;\n]+)/g)].map(m => m[1].trim());
  if (!赋值.length) fail('没找到 out.why 的赋值，这条检查是不是失效了');
  const 带变量 = 赋值.filter(v => /\b(err|error|e)\b|String\(/.test(v));
  if (带变量.length) fail(`out.why 里掺了服务商回的原话：${带变量.join(' / ').slice(0, 120)}`);
  else ok(`${赋值.length} 处 out.why 全是写死的中文句子，异常原话只进服务端日志`);
}

/* 13. 主角设定：五十个汉字封顶，明摆着的超人写法顶回去 */
console.log('13. 主角设定的闸');
{
  const 该收 = [
    '做事踏实，嘴笨，认死理，不会来事',
    '记性好，算账快，脸皮薄，不好意思讨价还价',
    '胆子大，敢赌，跟谁都聊得来，就是坐不住',
    '', '   ',
  ];
  const 该退 = [
    ['会一身好武功，能以一敌百', '武功'],
    ['过目不忘，账本看一眼就记住', '过目不忘'],
    ['我是穿越来的，脑子里带着系统', '穿越'],
    ['家里是本地首富，继承了万贯家产', '安家底'],
    ['很'.repeat(51), '超字数'],
  ];
  let 错 = [];
  for (const t of 该收) if (!E.checkPersona(t).ok) 错.push(`「${t.slice(0, 12)}」本该收下`);
  for (const [t, why] of 该退) if (E.checkPersona(t).ok) 错.push(`「${t.slice(0, 12)}」（${why}）本该顶回去`);
  /* 顶回去的那几条，回话要说清楚该改哪儿，不能只回一句「不行」 */
  for (const [t] of 该退) {
    const r = E.checkPersona(t);
    if (!r.ok && (!r.say || r.say.length < 8)) 错.push(`顶回「${t.slice(0, 10)}」时没说清楚为什么`);
  }
  if (错.length) 错.forEach(fail);
  else ok(`${该收.length} 条正常写法收下、${该退.length} 条超人写法顶回去，每条都说清了该改哪儿`);

  /* 五十个汉字是硬线：标点和数字不计，跟清单一个数法 */
  const 五十 = '普'.repeat(50) + '，。！？1234567890abc';
  if (!E.checkPersona(五十).ok) fail('正好五十个汉字加一堆标点，该收下');
  else if (E.checkPersona('普'.repeat(51)).ok) fail('五十一个汉字该顶回去');
  else ok('五十个汉字封顶，标点、数字、字母不计入');

  /* 收下的那句要真进存档，不然设定写了等于没写 */
  const s1 = E.newRun({ year: 1936, month: 5, nick: 'x', persona: '嘴笨，认死理' });
  if (s1.persona !== '嘴笨，认死理') fail(`设定没进存档，存的是「${s1.persona}」`);
  else if (E.newRun({ year: 1936, month: 5, nick: 'x', persona: '会武功' }).persona !== '')
    fail('顶回去的设定不该进存档');
  else ok('收下的设定进存档、顶回去的不进');
}

/* 14. 这一局只有钱：四条杠不许从任何一条路上再冒出来。
 *     静态扫源码——玩家看不看得见那四条杠，取决于存档里有没有那几个字段，
 *     跑一局是看不出来的（老档里还留着它们）。 */
console.log('14. 除了钱没有别的属性');
{
  const fs2 = require('fs'), path2 = require('path');
  const root = path2.join(__dirname, '..');
  const 禁 = /\.standing\b|["'「]standing["'」]|\bstanding\s*[:=]|名声\s*\$?\{|体力\s*[:：]\s*\d/;
  const 中招 = [];
  for (const f of ['engine.js', 'sim.js', 'server.js', 'public/app.js', 'tools/bot.js', 'tools/player.js']) {
    const src = fs2.readFileSync(path2.join(root, f), 'utf8');
    src.split('\n').forEach((line, i) => {
      const 代码 = line.replace(/\/\*.*?\*\//g, '').replace(/^\s*\*.*$/, '').replace(/\/\/.*$/, '');
      if (禁.test(代码)) 中招.push(`${f}:${i + 1} ${代码.trim().slice(0, 60)}`);
    });
  }
  if (中招.length) 中招.forEach(x => fail(`四条杠又冒出来了：${x}`));
  else ok('六个文件的代码里都没有名声/关系/体力/麻烦这几条槽了（注释里说明改动史不算）');

  /* 老档里还带着 standing，不能因此读不回来 */
  const 老档 = { ...E.newRun({ year: 1962, month: 5, nick: 'x' }), standing: { 名声: 10, 关系: 10, 体力: 80, 麻烦: 0 } };
  try {
    E.applyMonth(老档, { entries: [{ what: '做工', amount: 40 }], standing: { 体力: -9 } });
    ok('老档带着 standing 也照样走得动，模型回的 standing 直接扔掉');
  } catch (e) { fail(`老档读不回来了：${e.message}`); }
}

console.log(bad ? `\n没过，${bad} 条` : '\n全过');
process.exit(bad ? 1 : 0);
