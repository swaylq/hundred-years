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

/* 2b. 没有上限了（2026-09-05 sway 定的）：月月做到头，二十四个月照实累加 */
console.log('2b. 不封顶：月月做到头，整局照实累加');
{
  const { s } = walk(2015, 6, st => E.applyMonth(st, { entries: [{ what: '做到头的一个月', amount: E.monthTop(st.year, st.month) }] }));
  const r = E.settle(s);
  const was = E.yearOf(2015).ceiling * 6;            // 老口径：平均每月做到头 × 六个满月
  if (r.ceiling != null || r.cappedTotal != null) fail('结算结果里还留着封顶那几项');
  if (!(r.score > was * 3)) fail(`月月做到头只打出 ${r.score.toFixed(1)} 年，老封顶是 ${was.toFixed(1)} 年，撤了闸该在它三倍以上`);
  else ok(`2015-06 月月做到头，打出 ${r.score.toFixed(1)} 年的收入（老封顶 ${was.toFixed(1)} 年，早过了）`);
}

/* 2c. 撤了上限之后剩下的唯一一道：单位写错。
 *     判据是「比那一年做到头的一个月还高一千倍」——挣得再多也够不着，
 *     够得着的只有换币后照旧钱记账和清单里的注入。 */
console.log('2c. 只有单位写错才折回去，挣得多不折');
{
  const top = E.monthTop(2015, 6);
  const put = delta => {
    const s = E.newRun({ year: 2015, month: 6, nick: 'x', seed: 1 });
    const before = E.netWorth(s);
    const res = E.applyMonth(s, delta);
    return { got: E.netWorth(s) - before, res };
  };
  const a = put({ entries: [{ what: '一笔天大的买卖', amount: top * 999 }] });
  if (a.res.rescaled) fail('做到头的九百九十九倍被当成单位写错了');
  else if (Math.abs(a.got - top * 999) > 1e-6) fail(`九百九十九倍进去 ${top * 999}，落下的却是 ${a.got}`);
  else ok(`做到头的九百九十九倍，一分不少全记上（${E.money(top * 999, 'RMB')}）`);

  const b = put({ entries: [{ what: '注入', amount: 1e13 }] });
  if (!b.res.rescaled) fail('清单里注入 1e13，没被当成单位写错');
  else if (b.got > top * 10) fail(`折回去之后还剩 ${b.got}，该落回那一年的量级（做到头 ${top}）`);
  else ok(`注入 1e13，按 10 的 ${-b.res.rescaled.zeros} 次幂折回 ${E.money(b.got, 'RMB')}（做到头是 ${E.money(top, 'RMB')}）`);

  const c = put({ assetsAdd: [{ name: '一栋楼', kind: '实物', worth: 1e13 }] });
  if (!c.res.rescaled || c.got > top * 10) fail(`写成「家当」的 1e13 绕过去了：落下 ${c.got}`);
  else ok(`写在 assetsAdd 里的 1e13（整月一笔账都不记）一样折回 ${E.money(c.got, 'RMB')}`);
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

/* 5. 一个月赚过头，一分不削 */
console.log('5. 一个月赚过头也照记');
{
  const s = E.newRun({ year: 2015, month: 6, nick: 'x', seed: 1 });
  const top = E.monthTop(2015, 6);
  const before = E.netWorth(s);
  const res = E.applyMonth(s, { cash: top * 100 });
  const got = E.netWorth(s) - before;
  if (res.capped !== undefined) fail('applyMonth 还在返回削顶的记号');
  else if (Math.abs(got - top * 100) > 1e-6) fail(`塞进做到头的一百倍，落下的却是 ${got}`);
  else ok(`塞 ${E.money(top * 100, 'RMB')} 进去，家底就多 ${E.money(got, 'RMB')}，一分没削`);
}

/* 6. 家底要把票证和权益算进来 */
console.log('6. 票证和权益算进家底');
{
  const s = E.newRun({ year: 1962, month: 5, nick: 'x', seed: 1 });
  /* 这两笔加起来 105，验的是家底算法 */
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

/* 5d. 「做到头的一个月」这把尺子必须跟着换币走 */
console.log('5d. 换币之后，「做到头的一个月」要按新钱算');
{
  const before = E.monthTop(1948, 8);          // 换币那个月整月按法币过
  const after = E.monthTop(1948, 9);           // 下个月起是金圆券
  const r = E.yearOf(1948).switch.rate;
  if (!(before / after > r * 0.5 && before / after < r * 2)) {
    fail(`换币前后的尺子差了 ${(before / after).toExponential(2)} 倍，应该跟比价 ${r.toExponential(2)} 一个量级`);
  } else ok(`换币前 ${E.money(before, 'FABI')}，换币后 ${E.money(after, 'GOLDYUAN')}`);

  /* 尺子跟着换币走，「换币之后照旧用法币数目记账」才认得出来是单位错了 */
  const { s } = walk(1948, 8, st => E.applyMonth(st, { entries: [{ what: '照法币量级乱记的进账', amount: 5e7 }] }));
  const r2 = E.settle(s);
  if (r2.score > 500) fail(`换币后月月记五千万，算出 ${r2.score.toFixed(1)} 年的收入——单位没折回金圆券的量级`);
  else ok(`换币后月月记五千万，折回金圆券的量级，整局 ${E.fmtScore(r2.score)}`);
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

/* 14. 四条杠回来了（2026-09-03 晚 sway 要回来的），但**记分只看家底** */
console.log('14. 四条杠回来了，可它们不进分数');
{
  const s = E.newRun({ year: 1936, month: 5, nick: 'x' });
  const 该有 = { 名声: 10, 关系: 10, 体力: 80, 麻烦: 0 };
  if (JSON.stringify(s.standing) !== JSON.stringify(该有)) fail(`开局那四个数不对：${JSON.stringify(s.standing)}`);
  else ok(`开局 ${Object.entries(该有).map(([k, v]) => k + ' ' + v).join(' · ')}`);

  /* 模型给的是增量，夹在 0..100 之间 */
  E.applyMonth(s, { entries: [{ what: '做工', amount: 10 }], standing: { 体力: -95, 麻烦: 150, 名声: 3 } });
  if (s.standing.体力 !== 0) fail(`体力该压到 0，实际 ${s.standing.体力}`);
  else if (s.standing.麻烦 !== 100) fail(`麻烦该封到 100，实际 ${s.standing.麻烦}`);
  else if (s.standing.名声 !== 13) fail(`名声该是 13，实际 ${s.standing.名声}`);
  else ok('模型给的是变化量，夹在 0 到 100 之间（−95 压到 0，+150 封到 100）');

  /* 记分只看家底：四条杠差到天上去，分数也必须一模一样 */
  const mk = st => {
    const r = E.newRun({ year: 1936, month: 5, nick: 'x', seed: 1 });
    Object.assign(r.standing, st);
    r.cash *= 3;
    for (let i = 1; i <= E.MONTHS; i++) { r.months.push({ n: r.n, year: r.year, month: r.month }); if (i < E.MONTHS) E.advanceTo(r, i + 1); else E.closeOut(r); }
    return E.settle(r).score;
  };
  const 高 = mk({ 名声: 100, 关系: 100, 体力: 100, 麻烦: 0 });
  const 低 = mk({ 名声: 0, 关系: 0, 体力: 1, 麻烦: 100 });
  if (高 !== 低) fail(`四条杠影响了分数：满杠 ${高}、空杠 ${低}`);
  else ok('名声关系体力麻烦拉满和拉爆，分数一模一样——记分只看家底');

  /* 09-03 白天那半天开的局没有 standing，读回来不许炸 */
  const 老档 = E.newRun({ year: 1962, month: 5, nick: 'x' });
  delete 老档.standing;
  try {
    E.applyMonth(老档, { entries: [{ what: '做工', amount: 40 }], standing: { 体力: -9 } });
    if (老档.standing.体力 !== 71) fail(`老档补默认值之后该是 71，实际 ${老档.standing.体力}`);
    else ok('撤掉四条杠那半天开的老档，进来先补默认值再往上加');
  } catch (e) { fail(`老档读不回来了：${e.message}`); }
}

/* 15. 记忆只添不删：走满二十四个月，头一个月的事必须还在 */
console.log('15. 二十四个月走下来，一件都没丢');
{
  const s = E.newRun({ year: 1926, month: 10, nick: 'x', seed: 7 });
  /* 第 1 个月认识老周、起一条头绪；第 9 个月了结它；第 20 个月老周再出现 */
  for (let n = 1; n <= E.MONTHS; n++) {
    const at = { n, year: 1926 + Math.floor((9 + n) / 12), month: (9 + n) % 12 + 1 };
    const d = { memo: { line: `第 ${n} 个月的事`, people: [], threads: [], done: [] } };
    if (n === 1) {
      d.memo.people.push({ who: '老周（十六铺工头）', note: '要两块押金，头月不退' });
      d.memo.threads.push({ what: '凑两块交押金入伙扛包', note: '老周说交了才排得上' });
    }
    if (n === 9) d.memo.done.push('凑两块交押金');           // 故意不抄全，考一考模糊匹配
    if (n === 20) d.memo.people.push({ who: '老周（十六铺工头）', note: '肯赊两天工钱给他' });
    E.applyMemo(s, d, at);
  }
  const m = s.memo;
  /* 月记 2026-09-04 从四十字放到一百五十字，并由引擎白送一行硬数字 */
  const 长句 = '月初去十六铺找工头老周，交两块押金买了护具，排上扛包的班，一件八分，二十天挣了七块六。月中听老黄说闸北缺盐，凑六块收了两袋，月底卖一袋得七块五，另一袋说好下月八块收走。房钱三块、伙食三块八。';
  const s9 = E.newRun({ year: 1926, month: 10, nick: 'x' });
  E.applyMemo(s9, { memo: { line: 长句 } }, { n: 1, year: 1926, month: 10, tally: '进：扛包 7.60 银元；出：房钱 3.00 银元；净进 0.30 银元' });
  const t9 = s9.memo.trail[0];
  if (t9.say !== 长句) fail(`一百字出头的月记被截了：留下 ${E.countHan(t9.say)} 个汉字`);
  else if (!/净进 0\.30 银元/.test(t9.tally || '')) fail('引擎该白送这个月的净进，没送上');
  else if (!t9.worth) fail('引擎该白送收工家底，没送上');
  else if (!E.memoText(s9).includes('收工家底')) fail('硬数字没渲染进提示词');
  else ok(`月记装得下 ${E.countHan(长句)} 个汉字，后面自动缀上「${t9.tally}，收工家底 ${t9.worth}」——钱的总数不用模型算`);

  if (m.trail.length !== E.MONTHS) fail(`走过的路该有 ${E.MONTHS} 条，实际 ${m.trail.length}`);
  else if (m.trail[0].say !== '第 1 个月的事') fail(`第 1 个月被挤掉了：现在头一条是「${m.trail[0].say}」`);
  else if (m.trail.some((t, i) => t.n !== i + 1)) fail('走过的路的月份不连续，有缺格或者重了');
  else ok(`${E.MONTHS} 个月一条不缺，第 1 个月那句到第 24 个月还在`);

  const 周 = m.people.find(p => p.who.startsWith('老周'));
  if (!周) fail('老周不见了');
  else if (周.notes.length !== 2) fail(`老周名下该有 2 条记录，实际 ${周.notes.length}`);
  else if (周.first !== 1 || 周.last !== 20) fail(`老周的头尾记错了：${周.first} → ${周.last}`);
  else ok('同一个人隔十九个月再出现，新记一条，第 1 个月那条没被盖掉');

  const 头绪 = m.threads[0];
  if (!头绪 || 头绪.done !== 9) fail(`那条头绪该在第 9 个月盖戳，实际 ${头绪 && 头绪.done}`);
  else ok('了结的头绪盖个戳留着，没删（done 抄得不全也认得出来）');

  const txt = E.memoText(s);
  if (!txt.includes('第 1 个月的事')) fail('渲染出来的那一段里没有第 1 个月');
  else if (!txt.includes('要两块押金')) fail('渲染出来的那一段里没有老周头一回那句');
  else ok(`渲染成 ${E.countHan(txt)} 个汉字，第 1 个月的人和事都在里头`);
}

/* 16. 挤不下的时候只折细节、留名字；挂着的头绪一条都不折 */
console.log('16. 挤不下就折，不删');
{
  const s = E.newRun({ year: 1936, month: 5, nick: 'x' });
  for (let n = 1; n <= 100; n++) {
    E.applyMemo(s, { memo: { people: [{ who: `路人${n}`, note: `第 ${n} 个月见过` }] } }, { n });
  }
  if (s.memo.people.length !== E.MEMO_CAP.people) fail(`人该封顶在 ${E.MEMO_CAP.people}，实际 ${s.memo.people.length}`);
  else if (s.memo.folded.length !== 100 - E.MEMO_CAP.people) fail(`折出去的该有 ${100 - E.MEMO_CAP.people} 个，实际 ${s.memo.folded.length}`);
  else if (!s.memo.folded[0].includes('路人1')) fail(`折的该是最久没提起的那个，实际折了「${s.memo.folded[0]}」`);
  else ok(`一百个人挤到 ${E.MEMO_CAP.people} 个，挤出去的 ${s.memo.folded.length} 个只折掉细节、名字留着`);

  /* 挂着的头绪：只要没了结，多到封顶也不许折 */
  const s2 = E.newRun({ year: 1936, month: 5, nick: 'x' });
  for (let n = 1; n <= E.MEMO_CAP.threads + 10; n++) {
    E.applyMemo(s2, { memo: { threads: [{ what: `没了结的第 ${n} 件` }] } }, { n });
  }
  const 挂着 = s2.memo.threads.filter(t => !t.done);
  if (挂着.length !== E.MEMO_CAP.threads + 10) fail(`挂着的头绪被折掉了 ${E.MEMO_CAP.threads + 10 - 挂着.length} 条`);
  else ok(`${挂着.length} 条挂着的头绪一条没折——办不成的事不许悄悄消失`);
}

/* 17. 老档没有这一块，补得上 */
console.log('17. 老档没有记忆这一块');
{
  const 老档 = E.newRun({ year: 1962, month: 5, nick: 'x' });
  delete 老档.memo;
  try {
    E.applyMemo(老档, { memo: { line: '接着走' } }, { n: 5, year: 1962, month: 9 });
    if (老档.memo.trail.length !== 1) fail('老档补上记忆之后没记进去');
    else if (E.memoText({}) !== '') fail('没有记忆的存档该渲染成空串');
    else ok('老档进来先补一块空的，再往里记；没有记忆的存档渲染成空串，不报错');
  } catch (e) { fail(`老档读不回来了：${e.message}`); }
}

/* 18. 同一个人换个叫法，不许记成两个 */
console.log('18. 换个叫法还是同一个人');
{
  const s = E.newRun({ year: 1948, month: 1, nick: 'x' });
  /* 1948 那一局真跑出来的两个叫法 */
  E.applyMemo(s, { memo: { people: [{ who: '工头老张（自来水厂）', note: '认可你的进口工具' }] } }, { n: 4 });
  E.applyMemo(s, { memo: { people: [{ who: '老张（自来水厂工头）', note: '把核心泵房交给你' }] } }, { n: 5 });
  const 张 = s.memo.people.filter(p => p.who.includes('老张'));
  if (张.length !== 1) fail(`老张记成了 ${张.length} 个人`);
  else if (张[0].notes.length !== 2) fail(`并起来该有 2 条记录，实际 ${张[0].notes.length}`);
  else if (张[0].first !== 4) fail('并的时候把头一次见面的月份丢了');
  else ok('「工头老张（自来水厂）」和「老张（自来水厂工头）」并成一个人，两条记录都在');

  /* 别并过头：这是两个人 */
  E.applyMemo(s, { memo: { people: [{ who: '阿强', note: '雇他搬东西' }] } }, { n: 6 });
  E.applyMemo(s, { memo: { people: [{ who: '阿强的学徒', note: '跟着来了' }] } }, { n: 7 });
  if (s.memo.people.filter(p => p.who.includes('阿强')).length !== 2) fail('阿强和他的学徒被并成一个人了');
  else ok('「阿强」和「阿强的学徒」还是两个人');

  /* 一个人攒二十条记录：不超预算就全给，超了才折，而且折过的地方必须留记号 */
  const s2 = E.newRun({ year: 1948, month: 1, nick: 'x' });
  for (let n = 1; n <= 20; n++) E.applyMemo(s2, { memo: { people: [{ who: '老周', note: `第 ${n} 个月的事` }] } }, { n });
  const 周 = s2.memo.people[0];
  const 全给 = E.memoText(s2);
  if (周.notes.length !== 20) fail(`老周名下该有 20 条，实际 ${周.notes.length}`);
  else if ([...Array(20)].some((_, i) => !全给.includes(`第 ${i + 1} 个月的事`)))
    fail('没超预算就该二十条全给，现在少了几条');
  else ok('二十条记录不超预算，一条不折全给到提示词里');

  const 挤过 = E.memoText(s2, { limit: 60 });          // 预算卡到很小，逼它折
  if (!挤过.includes('第 1 个月的事')) fail('折过之后丢了「头一回怎么认识的」');
  else if (!挤过.includes('第 20 个月的事')) fail('折过之后丢了最近那一条');
  else if (!/中间第 2–\d+ 个月还有 \d+ 次来往/.test(挤过))
    fail(`折了却没留记号，模型会以为中间那些月份什么也没发生：${挤过.slice(-90)}`);
  else ok(`预算卡死时折中间那些，但写明缺口：「${/中间第[^；]*/.exec(挤过)[0]}」`);
}

/* 19. 削减的四条底线：六个档位挨个跑一遍，一档都不许破 */
console.log('19. 越削越狠，四条底线一档都不破');
{
  /* 造一份很大的记忆：24 个月、18 个人各 12 条记录、6 条挂着的、20 条了结的 */
  const s = E.newRun({ year: 1948, month: 1, nick: 'x' });
  for (let n = 1; n <= 24; n++) {
    const d = { memo: { line: `第 ${n} 个月做成了一笔买卖，进项还算稳当`, people: [], threads: [], done: [] } };
    for (let k = 0; k < 18; k++) d.memo.people.push({ who: `熟人${k}`, note: `第 ${n} 个月跟熟人${k}又打了一次交道` });
    if (n <= 6) d.memo.threads.push({ what: `挂着的第 ${n} 件`, note: '说好下月再来' });
    d.memo.traits = [{ what: `本事${n % 9}`, note: `第 ${n} 个月又长进了一点` }];
    if (n > 6) { d.memo.threads.push({ what: `办完的第 ${n} 件` }); d.memo.done.push(`办完的第 ${n} 件`); }
    E.applyMemo(s, d, { n, year: 1948, month: (n - 1) % 12 + 1 });
  }
  const 人名 = s.memo.people.map(p => p.who);
  const 挂着 = s.memo.threads.filter(t => !t.done);
  const 本事 = s.memo.traits.filter(t => !t.lost).map(t => t.what);
  let 破 = [];
  for (let lv = 0; lv <= 6; lv++) {
    /* limit 卡成 1 就一路降到第 6 档，每一档都验一遍 */
    const txt = E.memoText(s, { limit: lv === 0 ? 1e9 : 1 });
    const 档 = lv === 0 ? '一档不折' : '削到底';
    for (let n = 1; n <= 24; n++) {
      if (!txt.includes(`第 ${n} 个月做成了一笔买卖`)) { 破.push(`${档}：第 ${n} 个月那句没了`); break; }
    }
    for (const w of 人名) if (!txt.includes(w)) { 破.push(`${档}：${w} 这个名字没了`); break; }
    for (const t of 挂着) if (!txt.includes(t.what)) { 破.push(`${档}：挂着的「${t.what}」没了`); break; }
    for (const t of 本事) if (!txt.includes(t)) { 破.push(`${档}：身上的「${t}」没了`); break; }
    if (lv > 0 && !txt.includes('没写在这儿')) 破.push(`${档}：折了却没留记号`);
    if (lv === 0) break;                       // limit 给足就是第 0 档，剩下的都用 limit=1 跑
  }
  /* 再单跑一遍最狠那一档，确认它确实降到了第 6 档（走过的路并成了段） */
  const 最狠 = E.memoText(s, { limit: 1 });
  if (!最狠.includes('早先几个月并成了段')) 破.push('limit 卡到 1 都没降到最后一档，档位没接上');
  if (破.length) 破.forEach(fail);
  else ok(`第 0 档到第 6 档：24 个月一句不少、18 个人名一个不缺、6 条挂着的一条不折、${本事.length} 样本事一条不折、折过的都留了记号`);

  const 全 = E.countHan(E.memoText(s, { limit: 1e9 })), 狠 = E.countHan(最狠);
  ok(`同一份记忆：一档不折 ${全} 个汉字，削到底 ${狠} 个（省了 ${Math.round((1 - 狠 / 全) * 100)}%），两头都没破底线`);

  /* 预算够用的时候不许乱折——真实规模（走满二十四个月）应当一档都不动 */
  const 真实 = E.memoText(s);
  if (真实 !== E.memoText(s, { limit: 1e9 }) && E.countHan(E.memoText(s, { limit: 1e9 })) <= E.MEMO_LIMIT)
    fail('没超预算却折了');
  else ok(`预算 ${E.MEMO_LIMIT} 个汉字：够用就一档不折，超了才一档一档往下降`);
}

/* 20. 他变成什么人，攒在 memo.traits 里——练废了也不删，只盖个戳 */
console.log('20. 练出来的本事攒着，废了也留着');
{
  const s = E.newRun({ year: 1926, month: 10, nick: 'x' });
  const at = n => ({ n, year: 1926, month: 10 });
  E.applyMemo(s, { memo: { traits: [{ what: '练拳', note: '跟退役的拳师练了一个月，还打不过人' }] } }, at(1));
  E.applyMemo(s, { memo: { traits: [{ what: '练拳', note: '扛得住码头上一般混混两下了' }] } }, at(6));
  E.applyMemo(s, { memo: { traits: [{ what: '城西那摊子', note: '手下二十来号人，收三条街的份子' }] } }, at(14));

  const 拳 = s.memo.traits.find(t => t.what === '练拳');
  if (!拳 || 拳.notes.length !== 2) fail(`练拳该有 2 条长进记录，实际 ${拳 ? 拳.notes.length : 0}`);
  else if (拳.first !== 1 || 拳.last !== 6) fail(`练拳的头尾记错了：${拳.first} → ${拳.last}`);
  else ok('同一样本事下个月又长进，往它名下再记一条，第 1 个月那条没被盖掉');

  /* 废了不删，盖个戳；戳过之后渲染进「曾经有过」那一行 */
  E.applyMemo(s, { memo: { traitsLost: ['练拳'] } }, at(19));
  const txt = E.memoText(s);
  if (s.memo.traits.length !== 2) fail(`废了不该删，现在只剩 ${s.memo.traits.length} 条`);
  else if (拳.lost !== 19) fail(`该在第 19 个月盖戳，实际 ${拳.lost}`);
  else if (!/曾经有过、后来没了的：.*练拳/.test(txt)) fail('废掉的本事没进「曾经有过」那一行');
  else if (/练出来、挣下来的[\s\S]*?· 练拳/.test(txt)) fail('废了还挂在「他现在有什么」里');
  else if (!txt.includes('城西那摊子')) fail('还在身上的那条不见了');
  else ok('练废了只盖戳不删：从「他现在有什么」挪进「曾经有过、后来没了的」');

  /* 捡回来 */
  E.applyMemo(s, { memo: { traits: [{ what: '练拳', note: '养好了手，又练回来一些' }] } }, at(22));
  if (拳.lost !== null) fail('又练回来了，戳该撤掉');
  else if (拳.notes.length !== 3) fail('捡回来那一条也该记上');
  else ok('后来又练回来，戳撤掉，三条记录都在');

  /* 模型给同一样本事改名（真跑出来过：第 1 个月「洋行跑街学徒」、第 2 个月「洋行跑街」） */
  const s3 = E.newRun({ year: 1926, month: 10, nick: 'x' });
  E.applyMemo(s3, { memo: { traits: [{ what: '洋行跑街学徒', note: '刚学会跑腿送样' }] } }, at(1));
  E.applyMemo(s3, { memo: { traits: [{ what: '洋行跑街', note: '能独立找作坊谈合作了' }] } }, at(2));
  E.applyMemo(s3, { memo: { traits: [{ what: '练拳', note: '另一样东西' }] } }, at(3));
  if (s3.memo.traits.length !== 2) fail(`改个名该并起来，现在有 ${s3.memo.traits.length} 条：${s3.memo.traits.map(t => t.what).join('、')}`);
  else if (s3.memo.traits[0].what !== '洋行跑街') fail(`该留最近那个叫法，实际留了「${s3.memo.traits[0].what}」`);
  else if (s3.memo.traits[0].notes.length !== 2) fail('并起来之后两条记录该都在');
  else if (s3.memo.traits[0].first !== 1) fail('并的时候把头一次的月份丢了');
  else ok('「洋行跑街学徒」改叫「洋行跑街」并成一条，留最近那个叫法，两条记录都在');

  /* 一个月最多收两条：模型一放开就月月长出一样新本事 */
  const s4 = E.newRun({ year: 1926, month: 10, nick: 'x' });
  E.applyMemo(s4, { memo: { traits: [{ what: '甲' }, { what: '乙' }, { what: '丙' }, { what: '丁' }] } }, at(1));
  if (s4.memo.traits.length !== 2) fail(`一个月该最多收两条，实际收了 ${s4.memo.traits.length}`);
  else ok('一个月最多添两样本事，多给的不收');

  /* 老档没有这一摊，补得上 */
  const 老档 = E.newRun({ year: 1962, month: 5, nick: 'x' });
  delete 老档.memo.traits;
  try {
    E.applyMemo(老档, { memo: { traits: [{ what: '会修钟表', note: '跟街口的师傅学的' }] } }, at(3));
    if (老档.memo.traits.length !== 1) fail('老档补上这一摊之后没记进去');
    else ok('09-03 晚之前的老档没有这一摊，进来先补一块空的');
  } catch (e) { fail(`老档读不回来了：${e.message}`); }
}

/* 21. 家当这一套 —— sway 2026-09-04 点名要保住的，动它之前先读这一段。
 *
 *     承重的是四件事，缺一件「攒东西躲通胀」就不成立：
 *       ① 进货配上 assetsAdd，家底不因为「进了一批货」掉一截
 *       ② 实物每月跟着中位收入重新标价，现金和债权不跟
 *       ③ 换币的时候实物躲得过、现金躲不过（第 3b 条在验）
 *       ④ 票证和权益也算钱（第 6 条在验）
 *     ①靠模型自觉配对，所以还有第五件：认出它没配对，下个月提醒它补。 */
console.log('21. 家当：进货的钱不算花掉');
{
  /* ① 同一笔钱，配了 assetsAdd 家底不动；没配就掉一截 */
  const 配了 = E.newRun({ year: 1936, month: 5, nick: 'x', seed: 1 });
  const 没配 = E.newRun({ year: 1936, month: 5, nick: 'x', seed: 1 });
  const 本钱 = Math.round(配了.cash / 2);
  const 前 = E.netWorth(配了);
  E.applyMonth(配了, { entries: [{ what: '进一批布的货款', amount: -本钱 }], assetsAdd: [{ name: '压在手里的布', kind: '实物', worth: 本钱 }] });
  E.applyMonth(没配, { entries: [{ what: '进一批布的货款', amount: -本钱 }], assetsAdd: [] });
  if (Math.abs(E.netWorth(配了) - 前) > 1e-6) fail(`配了 assetsAdd 家底还是动了：${前} → ${E.netWorth(配了)}`);
  else if (Math.abs(E.netWorth(没配) - (前 - 本钱)) > 1e-6) fail('没配 assetsAdd 家底该掉一整笔本钱');
  else ok(`同一笔进货：记了东西家底纹丝不动，没记就掉 ${E.money(本钱, 'SILVER')}——配对是承重的`);

  /* ② 实物跟着中位收入走，现金和债权不跟 */
  const r = E.newRun({ year: 1947, month: 6, nick: 'x', seed: 1 });
  r.assets = [{ name: '两石米', kind: '实物', worth: 1000 }, { name: '老周的欠条', kind: '债权', worth: 1000 }];
  const k = E.incomeOf(1947, 7) / E.incomeOf(1947, 6);
  E.reprice(r, { year: 1947, month: 6 }, { year: 1947, month: 7 });
  if (Math.abs(r.assets[0].worth - 1000 * k) > 1e-6) fail(`实物没跟着走：该 ${(1000 * k).toFixed(2)}，实际 ${r.assets[0].worth.toFixed(2)}`);
  else if (r.assets[1].worth !== 1000) fail(`债权不该跟着涨，实际 ${r.assets[1].worth}`);
  else ok(`1947 年 6→7 月，米的标价 ×${k.toFixed(3)} 跟着涨，欠条纹丝不动`);

  /* ⑤ 认出「进了货没记东西」，别误伤当月买当月卖和零碎开销 */
  const 用例 = [
    ['进了一批货、没记东西', { entries: [{ what: '购买三十石大米货款', amount: -1800 }, { what: '一个月伙食', amount: -120 }], assetsAdd: [] }, true],
    ['进了货也记了东西', { entries: [{ what: '购买三十石大米货款', amount: -1800 }], assetsAdd: [{ name: '仓里的米', worth: 1800 }] }, false],
    ['当月买当月卖光了', { entries: [{ what: '购买大米货款', amount: -1800 }, { what: '大米分销所得', amount: 2600 }], assetsAdd: [] }, false],
    ['只是零碎开销', { entries: [{ what: '买煤油及火柴', amount: -50 }, { what: '一个月房租', amount: -300 }], assetsAdd: [] }, false],
    ['押金交出去没记', { entries: [{ what: '入伙押金', amount: -900 }], assetsAdd: [] }, true],
    ['记上了大半', { entries: [{ what: '进货货款', amount: -2000 }], assetsAdd: [{ name: '货', worth: 1500 }] }, false],
  ];
  const 错 = 用例.filter(([, d, want]) => !!E.unpairedBuys(d, 1000) !== want).map(([n]) => n);
  if (错.length) fail(`认漏了或者认错了：${错.join('、')}`);
  else ok(`${用例.length} 个用例都判对（当月买当月卖、零碎开销都不误伤）`);

  /* 认出来之后要挂在这个月上，下个月的提示词才拿得到 */
  const t = E.newRun({ year: 1936, month: 5, nick: 'x', seed: 1 });
  const res = E.applyMonth(t, { entries: [{ what: '进一批布的货款', amount: -Math.round(t.cash / 2) }], assetsAdd: [] });
  if (!res.missedGoods) fail('applyMonth 没把「进了货没记东西」报出来');
  else ok(`applyMonth 报出来了：${res.missedGoods.items[0].what}，下个月提示词里会摆到模型眼前`);
}

/* 22. 顶回去的理由只能是「那一年没有这东西」。
 *     玩家写「去国外接一单暗杀的活」，回来一句「该类任务属于犯罪活动，风险远大于收益」——
 *     那是模型站到了顾问的位置上，这个游戏里犯法的事做得成，只是有人管。
 *     提示词是主闸，cleanRefused 是兜底。 */
console.log('22. 替玩家把事否掉的那种拒绝，落不了地');
{
  const 扔掉 = [
    ['讲犯罪', { what: '前往国外接暗杀任务', why: '该类任务属于犯罪活动，风险远大于收益。' }],
    ['讲危险', { what: '走私烟土', why: '太危险了，抓到要坐牢' }],
    ['讲划算', { what: '盘下这间铺子', why: '本钱压得太多，得不偿失' }],
    ['讲道德', { what: '放印子钱', why: '有违道德，不建议这么做' }],
  ];
  const 留下 = [
    ['说得出年份', { what: '骑共享单车', why: '共享单车 2016 年才出现，街上没有这种东西' }],
    ['关键词表点过名', { what: '开网约车', why: '那时候按非法营运查' }, [{ word: '网约车', kind: 'early' }]],
  ];
  const 漏 = 扔掉.filter(([, r]) => E.cleanRefused([r], []).length).map(([n]) => n);
  const 误伤 = 留下.filter(([, r, hits]) => !E.cleanRefused([r], hits || []).length).map(([n]) => n);
  if (漏.length) fail(`该扔的留下了：${漏.join('、')}`);
  else if (误伤.length) fail(`真的顶回去被误伤：${误伤.join('、')}`);
  else ok(`${扔掉.length} 种劝告全扔掉，${留下.length} 种真顶回去全留住`);

  /* banned（有这东西，但这几年干这个犯法）不是顶回去的依据 */
  const r2 = E.cleanRefused([{ what: '摆摊', why: '这几年干这个犯法' }], [{ word: '摆摊', kind: 'banned' }]);
  if (r2.length) fail('犯法的那种被当成了「办不成」');
  else ok('「有这东西但干这个犯法」不算顶回去——让他做，代价记在钱和麻烦上');

  /* 他要走就让他走：moveTo 落到存档上，废话不动他 */
  const s = E.newRun({ year: 2015, month: 6, nick: 'x', seed: 1 });
  const 原来 = s.city;
  const mv = E.applyMove(s, '香港');
  if (!mv || s.city !== '香港') fail('moveTo 没把人搬过去');
  else if (E.applyMove(s, '香港') || E.applyMove(s, ' ')) fail('没搬也报了一次搬家');
  else ok(`他这个月走了：${原来} → ${s.city}，年卡照旧用${原来}那一份`);
}

/* 23. 自己写的路子要值钱：奖励和奇遇都盯着「有几成是他自己写的」。 */
console.log('23. 照着纸条走给稳当那一份，自己想的路子给足');
{
  const opts = [{ what: '一早去十六铺找工头老周，扛包按件算，一件八分' },
    { what: '把手上那块表当了，进一批线香试试水' },
    { what: '去城西打听纱厂这个月招不招人' }];
  const 抄 = opts[0].what;
  const 半 = opts[0].what + '\n然后我要把老赵压着的那批货吃下来，找船运到宁波去卖';
  const 全 = '我要把手上的钱押进一批线香，找宁波的船运过去，再托人介绍两个买家，月底之前出手';
  const f = t => E.offScript(t, opts);
  if (f(抄) > 0.01) fail(`原样点一条纸条，自己写的比例该是 0，实际 ${f(抄).toFixed(2)}`);
  else if (f(opts.map(o => o.what).join('\n')) > 0.01) fail('三条都点了还算自己写的');
  else if (!(f(半) > 0.4 && f(半) < 0.85)) fail(`点一条再自己加一段，该在四到八成之间，实际 ${f(半).toFixed(2)}`);
  else if (f(全) < 0.99) fail(`一个字没抄，该是 1，实际 ${f(全).toFixed(2)}`);
  else ok(`照抄 ${f(抄).toFixed(2)}、抄一半 ${f(半).toFixed(2)}、全自己写 ${f(全).toFixed(2)}`);

  /* 撞上奇遇的频次：照抄约 8%，全自己写约 45%，四百局跑出来的数要落在附近 */
  const 频 = list => {
    let hit = 0, n = 0;
    for (let seed = 1; seed <= 400; seed++) for (let i = 1; i <= E.MONTHS; i++) {
      n++; if (E.serendipity({ seed, n: i, options: opts, months: [] }, list).luck) hit++;
    }
    return hit / n;
  };
  const p抄 = 频(抄), p全 = 频(全);
  if (Math.abs(p抄 - 0.08) > 0.02) fail(`照着纸条走的奇遇频次跑偏：${(p抄 * 100).toFixed(1)}%，该在 8% 上下`);
  else if (Math.abs(p全 - 0.45) > 0.03) fail(`自己写的奇遇频次跑偏：${(p全 * 100).toFixed(1)}%，该在 45% 上下`);
  else ok(`四百局 × ${E.MONTHS} 个月：照抄撞上 ${(p抄 * 100).toFixed(1)}%，自己写撞上 ${(p全 * 100).toFixed(1)}%`);

  /* 三条底线：同一局同一个月结果不变、上个月刚撞过就减半、一句话的清单不算 */
  const s1 = { seed: 99, n: 7, options: opts, months: [] };
  const 两次 = E.serendipity(s1, 全).luck === E.serendipity(s1, 全).luck;
  const 减半 = E.serendipity({ ...s1, months: [{ luck: true }] }, 全).p;
  const 一句话 = E.serendipity(s1, '去干活').p;
  if (!两次) fail('同一局同一个月，两次算出来不一样');
  else if (Math.abs(减半 - 0.225) > 1e-9) fail(`上个月刚撞过该减半到 0.225，实际 ${减半}`);
  else if (一句话 !== 0) fail(`「去干活」这种清单不该有奇遇，实际 ${一句话}`);
  else ok('同一局重算结果不变；上个月刚撞过减半到 0.225；一句话的清单不给');
}

/* 24. 投机这一把的成败由骰子和那几年的行情定，不由模型的胆量定。
 *     玩家的原话：「我想炒股投机就一直亏亏亏」。 */
console.log('24. 押本钱这一把：顺着行情走赢面大，逆着走赔面大');
{
  const 试 = (list, year, month, n = 400) => {
    let win = 0, sum = 0, big = 0, dead = 0;
    for (let seed = 1; seed <= n; seed++) {
      const r = E.speculation({ seed, n: 5, year, month }, list);
      if (r.win) win++;
      sum += r.mult; if (r.mult >= 3) big++; if (r.mult <= -0.9) dead++;
    }
    return { win: win / n, avg: sum / n, big: big / n, dead: dead / n };
  };
  const 满仓 = '把手里的钱全买股票，满仓等涨，跌了也不割';
  const 牛 = 试(满仓, 2007, 6), 熊 = 试(满仓, 2008, 5), 空 = 试('把股票全清仓换成现金', 2008, 5);
  const 没行情 = 试('倒卖电子表，从广州进货', 1982, 3);
  if (Math.abs(牛.win - 0.68) > 0.06) fail(`顺着牛市走该赢六成八，实际 ${(牛.win * 100).toFixed(0)}%`);
  else if (Math.abs(熊.win - 0.22) > 0.06) fail(`逆着熊市走该赢两成二，实际 ${(熊.win * 100).toFixed(0)}%`);
  else if (Math.abs(没行情.win - 0.45) > 0.06) fail(`表上没写的年份该对半开，实际 ${(没行情.win * 100).toFixed(0)}%`);
  else ok(`2007 年 6 月满仓赢 ${(牛.win * 100).toFixed(0)}%、2008 年 5 月满仓赢 ${(熊.win * 100).toFixed(0)}%、1982 年没行情赢 ${(没行情.win * 100).toFixed(0)}%`);

  if (!(牛.avg > 0.5)) fail(`顺着走的均值该是正的一大截，实际 ${牛.avg.toFixed(2)}`);
  else if (!(熊.avg < 0)) fail(`逆着走的均值该是负的，实际 ${熊.avg.toFixed(2)}`);
  else if (!(牛.big > 0.02 && 熊.dead > 0.04)) fail(`大赢和血本无归两头都要有：翻三倍 ${(牛.big * 100).toFixed(0)}%、亏光 ${(熊.dead * 100).toFixed(0)}%`);
  else ok(`顺着走均值 +${牛.avg.toFixed(2)} 倍（${(牛.big * 100).toFixed(0)}% 翻三倍以上），逆着走均值 ${熊.avg.toFixed(2)} 倍（${(熊.dead * 100).toFixed(0)}% 血本无归）`);

  /* 清仓换现钱赌的是「躲开」：赢了顶多小赚，输了只是踏空，不该按本钱亏三成算 */
  if (!(空.win > 0.6)) fail(`跌市里清仓该多数时候是对的，实际 ${(空.win * 100).toFixed(0)}%`);
  else if (!(空.avg > 0 && 空.avg < 0.4)) fail(`清仓的均值该是小正数，实际 ${空.avg.toFixed(2)}`);
  else ok(`2008 年 5 月清仓换现钱：${(空.win * 100).toFixed(0)}% 躲对了，均值 +${空.avg.toFixed(2)} 倍（踏空只小亏，不按本钱亏三成算）`);

  /* 1948 年 8 月囤金子该是往枪口上撞，1946 年囤米该是对的——同一句话，两个年份两个下场 */
  const 囤46 = 试('把钱换成米囤在仓里', 1946, 6), 囤48 = 试('把钱全换成金条藏起来', 1948, 9);
  if (!(囤46.win > 0.6 && 囤48.win < 0.3)) fail(`同样是囤：1946 赢 ${(囤46.win * 100).toFixed(0)}%、1948 年 9 月赢 ${(囤48.win * 100).toFixed(0)}%，该是一高一低`);
  else ok(`同一句「囤起来」：1946 年 6 月赢 ${(囤46.win * 100).toFixed(0)}%，金圆券限价的 1948 年 9 月只赢 ${(囤48.win * 100).toFixed(0)}%`);

  /* 没押就不掷；同一局同一个月重算结果不变 */
  const 没押 = E.speculation({ seed: 1, n: 1, year: 2007, month: 6 }, '去码头扛包，一件八分');
  const s1 = { seed: 42, n: 6, year: 2007, month: 6 };
  const 两次 = JSON.stringify(E.speculation(s1, 满仓)) === JSON.stringify(E.speculation(s1, 满仓));
  const 借钱 = 试('借钱配资加杠杆满仓买股票', 2015, 9);
  if (没押.bet) fail('没押本钱也掷了骰子');
  else if (!两次) fail('同一局同一个月，两次算出来不一样');
  else if (!(借钱.dead > 0.04)) fail('加了杠杆输光的那一档该有');
  else ok('不押本钱不掷骰子；同一局重算结果不变；借钱押的输光了要背债');

  /* 场子要对得上：2015 年的股灾管不着倒卖球鞋，2013 年股票在跌而房子在涨。
   * 头一版没分场子，2015-06 那一局机器人「抢限量球鞋转手倒卖」的月份
   * 全按股灾的两成二算，一局打下来只剩 0.51 年的收入。 */
  const 球鞋 = 试('去专卖店抢限量球鞋，转手倒卖，能收多少收多少', 2015, 9);
  const 炒股13 = 试('把钱全买股票，满仓', 2013, 5);
  const 买房13 = 试('凑首付买一套房子，等它涨', 2013, 5);
  if (!(球鞋.win > 0.38 && 球鞋.win < 0.52)) fail(`倒卖球鞋撞上股灾就被误伤了：赢 ${(球鞋.win * 100).toFixed(0)}%，该对半开`);
  else if (!(炒股13.win < 0.3 && 买房13.win > 0.6)) fail(`2013 年该是股票跌、房子涨：炒股赢 ${(炒股13.win * 100).toFixed(0)}%、买房赢 ${(买房13.win * 100).toFixed(0)}%`);
  else ok(`分场子了：2015 年 9 月倒卖球鞋 ${(球鞋.win * 100).toFixed(0)}%（不吃股灾），2013 年炒股 ${(炒股13.win * 100).toFixed(0)}%、买房 ${(买房13.win * 100).toFixed(0)}%`);

  /* 行情表本身：不重叠、不倒挂、一百年都查得到 */
  let 空档 = 0;
  for (let y = 1926; y <= 2025; y++) for (let m = 1; m <= 12; m++) if (!E.marketAt(y, m)) 空档++;
  if (空档 > 6 * 12) fail(`行情表空的月份太多：${空档} 个`);
  else ok(`行情表覆盖了一百年里的 ${(1200 - 空档)} 个月，空着的 ${空档} 个按对半开算`);
}

console.log(bad ? `\n没过，${bad} 条` : '\n全过');
process.exit(bad ? 1 : 0);
