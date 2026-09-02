'use strict';
/* 玩家写了跨时代的事，游戏必须把他顶回去。
 *
 *   secret exec OPENROUTER_API_KEY -- node tools/check-anachronism.js
 *     --local   只验本地那道闸（不花钱，秒出）
 *     --jobs N  并发，默认 4
 *
 * 两层都要过：
 *   一、本地关键词表当场认出来（engine.scanAnachronism）——这层是确定性的，
 *       不指望模型自己想起 1930 年没有手机。
 *   二、模型收到裁定之后的下场。**分两种，下场是相反的**：
 *       · 那一年**根本没有**这东西（early/gone）：refused 里要有这一条，正文里写他撞的那堵墙。
 *       · 那一年**有，但干这个犯法**（banned，摆摊、私人办厂）：**不许顶回去**——
 *         让他做成，正文里要写他做了，并且要有代价（有人管、罚没、打点，或者麻烦涨）。
 *         2026-09-03 之前这两种混在一起验，逼着模型把犯法的事也否掉，
 *         玩家写「去接一单杀人的活」，回来的是一句「该类任务属于犯罪活动」。
 * 十三个场景，一个不过就退出码非 0。
 */
const path = require('path');
const fs = require('fs');
const E = require('../engine.js');
const SIM = require('../sim.js');

const LOCAL = process.argv.includes('--local');
const JOBS = (() => { const i = process.argv.indexOf('--jobs'); return i >= 0 ? Number(process.argv[i + 1]) : 4; })();

/* want: 应当被顶回去的那个词。null 表示这条是对照组，不该被拦。
 * alsoOk: 同一件事的其它说法。第二层只查「模型的拒绝里有没有点出那件事」，
 *   模型经常换个说法——1943 写「1943 年尚无电子计算机」、1962 写「私人办厂属于投机倒把」，
 *   判得都对，只是没有逐字出现 want。实测每六次会这么挂一次，而且每次挂的场景不同。
 *   所以 want 和 alsoOk 里任一个命中就算数。这不是放宽：拒绝理由仍然要 ≥10 字、
 *   仍然不许跟玩家写的原话一模一样，对照组仍然一个都不许被拦。 */
const CASES = [
  { year: 1930, month: 5,  list: '我打算做一个手机应用，卖给上海的商行，收订阅费。', want: '手机应用',
    alsoOk: ['手机', '移动电话', '应用程序'] },
  { year: 1943, month: 3,  list: '弄一台个人电脑，写一套记账的程序卖给几家商行。', want: '个人电脑',
    alsoOk: ['电脑', '计算机'] },
  { year: 1958, month: 9,  list: '去银行办一张信用卡，先刷五百块进货。', want: '信用卡',
    alsoOk: ['刷卡', '银行卡', '透支'] },
  { year: 1962, month: 5,  list: '注册一家私营企业，招十个工人做服装。', want: '私营企业',
    alsoOk: ['私营', '私人办厂', '私人经营', '公私合营', '雇工', '雇佣劳动'], didIt: ['服装', '缝', '衣', '布'] },
  { year: 1934, month: 6,  list: '去交易所做标金，再看看纱布期货，本钱两百块大洋。', want: null },
  { year: 1968, month: 4,  list: '在街口摆个摊卖凉粉，一天卖两百碗。', want: '摆摊',
    alsoOk: ['摆个摊', '个体户', '个体经营', '投机倒把', '私自买卖'], didIt: ['凉粉', '摊'] },
  { year: 1975, month: 7,  list: '按揭买一套商品房，等它涨价再卖掉。', want: '商品房',
    alsoOk: ['房屋买卖', '买卖房', '房产交易', '按揭', '私有房产'], didIt: ['房'] },
  { year: 1980, month: 6,  list: '开个网店，把这边的衣服卖到南方去。', want: '网店',
    alsoOk: ['网上', '互联网', '因特网', '电子商务', '上网'] },
  { year: 1986, month: 2,  list: '用微信联系几个客户，把货款打过来。', want: '微信',
    alsoOk: ['即时通讯', '智能手机', '互联网', '在线转账'] },
  { year: 1992, month: 1,  list: '买点比特币囤着，等它翻十倍。', want: '比特币',
    alsoOk: ['加密货币', '虚拟货币', '数字货币'] },
  { year: 2003, month: 4,  list: '开个直播带货，一晚上卖三万块。', want: '直播带货',
    alsoOk: ['直播', '带货', '短视频'] },
  /* 两条对照组：写的是那一年真有的事，绝不能被拦 */
  { year: 1985, month: 8,  list: '在街口摆个摊卖凉粉，一天卖两百碗，顺便打听哪里能批到便宜的绿豆。', want: null },
  { year: 2015, month: 6,  list: '开个网店卖衣服，找人拍照修图，先上二十个款试试水。', want: null },
];

async function one(c, i) {
  const out = { ...c, n: i + 1, localOk: false, modelOk: null, why: '' };

  /* 第一层：本地关键词表 */
  const hits = E.scanAnachronism(c.list, c.year);
  /* 「摆个摊」是「摆摊」的一种写法，比对之前先把中间塞的那个字去掉；
   * 条目本身的名字也算数（摆摊命中的是「个体户」这一条）。 */
  const norm = w => String(w).replace(/(个|了|过|一个|了个)/g, '');
  const words = hits.flatMap(h => [h.word, norm(h.word), h.name]);
  if (c.want === null) {
    out.localOk = hits.length === 0;
    if (!out.localOk) out.why = `不该拦却拦了：${words.join('、')}`;
  } else {
    const want = norm(c.want);
    out.localOk = words.some(w => w.includes(want) || want.includes(norm(w)));
    if (!out.localOk) out.why = hits.length ? `拦到的是${hits.map(h => h.word).join('、')}，不是「${c.want}」` : '一个都没拦住';
  }
  if (LOCAL || !out.localOk) return out;

  /* 第二层：模型收到裁定之后，真的顶回去了没有 */
  const s = E.newRun({ year: c.year, month: c.month, nick: '试', seed: 1234 + i });
  let r;
  try { r = await SIM.runMonth(s, c.list); }
  catch (err) { out.modelOk = false; out.why = '调模型出错：' + String(err.message).slice(0, 90); return out; }

  const refused = (r.delta.refused || []).map(x => `${x.what}${x.why}`).join(' ');
  const story = String(r.delta.story || '');
  /* 这一条是「没有这东西」还是「有、但犯法」，照关键词表自己说的算，不手写死。 */
  const wantHit = hits.find(h => [h.word, norm(h.word), h.name].some(w => w.includes(norm(c.want || '\u0000')) || norm(c.want || '\u0000').includes(norm(w))));
  const isBanned = !!wantHit && wantHit.kind === 'banned';
  if (c.want !== null && isBanned) {
    /* 犯法的那种：做得成，只是有人管。验三件事——没被顶回去、正文里真做了、代价出现了。 */
    /* 同一份清单里可能既有犯法的（商品房）又有那时候没有的（按揭）。
     * 拒绝的是后者就不算数——那一条本来就该顶回去。 */
    const goneWords = hits.filter(h => h.kind !== 'banned').flatMap(h => [h.word, h.name]);
    const inRefused = !goneWords.some(w => refused.includes(w))
      && [c.want, ...(c.alsoOk || [])].some(w => refused.includes(w));
    /* 「他到底干没干」不能拿 want 那几个词判：模型写「支起个摊子卖凉粉」，
     * 一个「摆摊」也没出现，事情却办得明明白白。didIt 是这件事的实物证据词。 */
    const inStory = [c.want, ...(c.alsoOk || []), ...(c.didIt || [])].some(w => story.includes(w));
    const 代价 = Number((r.delta.standing || {}).麻烦) > 0
      || /(抓|查|罚|没收|扣|撵|举报|风声|盯|打点|门包|投机倒把|市管|工商|派出所|治安|拘)/.test(story);
    out.modelOk = !inRefused && inStory && 代价;
    out.why = inRefused ? `犯法的事被当成办不成顶回去了：${refused.slice(0, 60)}`
      : !inStory ? `正文里没写他到底干没干「${c.want}」`
        : !代价 ? '做成了却一点代价都没有：没人管、麻烦也没涨' : '';
    out.tag = '犯法但做得成';
  } else if (c.want === null) {
    /* 对照组：只查一件事——**有没有说「这东西那时候还没有」**。
     * 别拿词表判语义：模型说「开网店缺少模特和专业修图，且尚未交付保证金进货」
     * 是一条完全合理的生意理由，里面那个「尚未」跟年代无关，
     * 上一版把它判成「对照组被当成跨时代顶回去了」，白红了两次。
     * 现在只认「点名了这样东西 + 明说它那个年代没有」这一种组合。 */
    const saidAbsent = new RegExp(`${c.list.match(/网店|摆摊|摆个摊|交易所|标金|期货/g)?.join('|') || '不可能出现的词'}`).test(refused) &&
      /(这一?年|那时候|当时|眼下|如今)?[^。]{0,12}(还没有|尚未出现|还不存在|要到\s*\d{4}\s*年|\d{4}\s*年才有)/.test(refused);
    out.modelOk = !saidAbsent;
    if (!out.modelOk) out.why = `对照组被当成跨时代顶回去了：${refused.slice(0, 70)}`;
  } else {
    const mentioned = [c.want, ...(c.alsoOk || [])].some(w => refused.includes(w) || story.includes(w));
    /* 「有没有给理由」用字数判，不用词表判。
     * 上一版列了二十来个词（没有/不存在/要到/犯法…），
     * 结果模型写「私有经济被禁止，属于投机倒把，面临没收工具和拘留处罚」
     * 反被判成「没说清楚」——那是一条完全正确的理由，只是没用到表里的词。
     * 拿词表当语义判断用，等于没判断。
     * 这里只机械地验两件事：提到了那样东西、并且给了一段像样的理由；
     * 理由本身对不对，交给挑刺的人读，脚本不装作能判。 */
    const why = (r.delta.refused || []).map(x => String(x.why || '')).join('');
    const what = (r.delta.refused || []).map(x => String(x.what || '')).join('');
    const substantive = why.length >= 10 && why !== what;
    out.modelOk = mentioned && substantive;
    if (!out.modelOk) {
      out.why = !mentioned ? `正文和 refused 里都没提「${c.want}」`
        : (why.length < 10 ? `refused 里的理由只有 ${why.length} 个字，等于没说` : '理由跟他想做的事一模一样，等于没说');
    }
  }
  out.story = story.slice(0, 100);
  out.refused = refused.slice(0, 120);
  return out;
}

(async () => {
  for (const c of CASES) {
    if (!fs.existsSync(path.join(__dirname, '..', 'data', 'years', `${c.year}.json`))) {
      console.error(`${c.year} 年的年卡还没生成，先跑 tools/gen-years.js`); process.exit(2);
    }
  }
  const OR = require('./or.js');
  const res = LOCAL
    ? CASES.map((c, i) => one(c, i)).map(x => x)     // 本地是同步的，await 一下即可
    : await OR.pool(CASES, JOBS, one);
  const rows = await Promise.all(res);

  let bad = 0;
  for (const r of rows) {
    const tag = r.want === null ? '对照' : (r.tag || '该拦');
    const ok = r.localOk && (r.modelOk === null || r.modelOk);
    if (!ok) bad++;
    console.log(`${ok ? '✓' : '✗'} ${String(r.n).padStart(2)}. ${r.year}-${String(r.month).padStart(2, '0')} [${tag}] ${r.list.slice(0, 26)}…`);
    console.log(`     本地 ${r.localOk ? '过' : '没过'}` + (r.modelOk === null ? '' : `  模型 ${r.modelOk ? '过' : '没过'}`) + (r.why ? `  —— ${r.why}` : ''));
    if (!ok && r.refused) console.log(`     模型说：${r.refused}`);
  }
  console.log(`\n${rows.length - bad}/${rows.length} 过` + (LOCAL ? '（只验了本地那道闸）' : ''));
  if (!LOCAL) console.log(OR.report());
  process.exit(bad ? 1 : 0);
})();
