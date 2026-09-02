'use strict';
/* 机器人玩家。bot.js 和 calibrate.js 共用一份，两边各写一份必然走散。
 *
 * 「认真」这一档不是最优解，是一个**肯下决心的普通人**：
 * 头两天摸清楚门路要什么条件，第三天起就一头扎进去干，
 * 攒下钱就加码，每七天回头算一次账、不行就换路子。
 *
 * 这一档的写法很要紧：原来那版每天都写「去问问有没有活」，
 * 结果 2015 年那一局问了二十八天，第二十九天才挣到第一笔钱——
 * 量出来的是这个机器人不会玩，不是这个游戏的行情。
 */
const E = require('../engine.js');

function rng(seed) { let x = (seed >>> 0) || 1; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32; }
const pick = (r, a) => a[Math.floor(r() * a.length)] ;

/** 挑一条主路：按种子固定，一局之内不乱换。
 *
 *  **不碰那条贴着上限的**。年卡里最肥的那条按设计就是要命的
 *  （2015 年是「被人拉进贵金属喊单群，本金大概率被平台吃干净」，
 *   1988 年是「带录像机过境，被抓就判刑」）。
 *  一个认真的人不会把全部身家押进喊单群——他会挑一条有奔头又不至于赔光的。
 *  原来按种子在全部路子里随便挑，挑中喊单群就整局归零，
 *  于是「认真打」在 2015 年反而不如「什么都不干」。 */
function mainWay(s, c) {
  const ways = c.money || [];
  if (!ways.length) return { way: '找活干', who: '谁都行', ceiling: '不好说' };
  const ceil = require('../engine.js').yearOf(s.year).ceiling;
  const sane = ways.filter(w => !(w.ceilingYears > ceil * 0.5));
  const pool = sane.length ? sane : ways;
  /* 在稳妥的那几条里挑最有奔头的那一档，再按种子在同档里选 */
  const sorted = [...pool].sort((a, b) => (b.ceilingYears || 0) - (a.ceilingYears || 0));
  const top = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
  return top[(s.seed || 1) % top.length];
}

/** 认真打：定下一条路，摸清条件，然后天天干，有钱就加码 */
function careful(s, c, r) {
  const w = mainWay(s, c);
  const alt = (c.money || []).filter(x => x.way !== w.way);
  const cur = E.currencyAt(s.year, s.month, s.day);
  const cash = E.money(s.cash, cur);
  const d = s.day;

  if (d === 1) {
    return `今天只做一件事：把「${w.way}」这条路彻底问明白。找到干这行的人，` +
      `问清楚三件事——入行要什么（本钱、家伙、门路、谁的关系）、一天能挣多少、什么时候结账。` +
      `问到具体的人名和地方，别问完就走。手里有 ${cash}，该花的打点钱就花。` +
      `今天不指望挣钱，明天就要开工。`;
  }
  if (d === 2) {
    return `按昨天问到的，今天把入行要的东西凑齐：该交的押金交了，该买的家伙买了，` +
      `该求的人今天就去求。凑不齐就退而求其次，找个不要门槛的先做着，` +
      `${alt.length ? `比如「${alt[0].way}」` : '什么都行'}。**今天必须开工，不许再打听了。**`;
  }

  let t = `接着做「${w.way}」，今天从早干到晚，不再东问西问。` +
    `按昨天谈好的价钱和时辰做，能多接一份就多接一份。`;

  if (d % 7 === 0) {
    t += `今天收工算一次总账：这条路一天到底净剩多少，够不够本。` +
      `不够就明天换「${alt.length ? pick(r, alt).way : '别的营生'}」，够就想办法把量做大。`;
  } else if (d % 3 === 0) {
    t += `顺手把手里的 ${cash} 用上：能雇个人搭把手就雇，能多进一批货就进，` +
      `能预付定金拿到更便宜的价就付。钱放着不动是最亏的。`;
  } else {
    t += `路上留意有没有更划算的主顾，谈得拢就换。`;
  }

  if (s.standing.体力 < 40) t += `身上乏得厉害，今天少做两个时辰，找地方睡足，别把身子干垮了。`;
  if (s.standing.麻烦 > 50) t += `最近盯上我的人多了，今天低调些，钱不露白，别惹事。`;
  if (s.assets.length) t += `手里有${s.assets.map(a => a.name).join('、')}，能变成钱或者能生钱的就用起来。`;
  return t;
}

/** 敷衍打：对照组。分数必须明显低于认真打，否则玩家写什么都无所谓 */
function lazy(s) {
  return ['随便走走。', '今天不想动。', '睡一天。', '看看天。', '待着。'][s.day % 5];
}

module.exports = { careful, lazy, mainWay, rng, pick };
