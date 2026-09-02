'use strict';
/* 一天怎么算出来的：拼提示词、调模型、把回来的东西查一遍再落账。
 *
 * 「说人话」在这里分三层落地（第三层在 tools/renhua/）：
 *   一、写进系统提示词——规矩加三句正面范例三句反面范例。范例比形容词管用。
 *   二、本地机械闸——回来的正文过一遍禁用词、句长、跨时代词，不过就带着毛病重来一次。
 *       零延迟零成本，不做实时二次改写（那要多花一倍时间和钱）。
 *   三、离线抽样——tools/renhua/check.js 抽真实生成的正文打分，分掉了回头改第一层。
 */
const fs = require('fs');
const path = require('path');
const E = require('./engine.js');

const YEARS_DIR = path.join(__dirname, 'data', 'years');
const cardCache = new Map();
function card(year) {
  if (!cardCache.has(year)) {
    cardCache.set(year, JSON.parse(fs.readFileSync(path.join(YEARS_DIR, `${year}.json`), 'utf8')));
  }
  return cardCache.get(year);
}

/* 每天的演算跟写年卡是两回事，模型也分开挑：
 *   年卡  一辈子只生成一次，慢一点无所谓，谁写得好用谁 → deepseek（见 tools/gen-years.js）
 *   每天  玩家在屏幕前等，一局要调三十次 → 挑快的
 * 量出来的中位耗时：deepseek 16.0 秒（三次里还失败一次）、
 * gemini-3.1-flash-lite 3.3 秒、gemini-2.5-flash-lite 2.6 秒。
 * 2.5-flash-lite 最快但笔调偏套话，取中间那个。 */
const MODEL = process.env.HY_MODEL || 'google/gemini-3.1-flash-lite';

/* 说人话只留一层：规矩和正反范例写进下面的系统提示词。
 * 原来还有两层——回来的正文过一遍禁用词和难读分、不过就原地重写，
 * 外加每天抽 50 条离线打分。sway 定了「实时那些不管」，两层都砍了。
 * 省下来的不只是钱：那道闸实测让 56% 的天数要重跑一次，
 * 砍掉之后一天的演算从 4.6 秒回到 3.3 秒，一局的调用从 39.6 次回到 30 次。
 * 界面上写死的文案照旧离线过一遍（tools/renhua/check.js）。 */

/* ── 提示词 ────────────────────────────────────────── */

const SYS = `你是《这一百年》的记事人。玩家挑了中国近一百年里的某一年某一个月，
落在一座城里过三十天。他每天写一份自己要做的事的清单，你写出这一天真的发生了什么。

【你的位置】
你不是在编故事，你是在按那一年真实的条件算账。
玩家写「去银行贷款开厂」，1962 年就贷不到、也开不了厂——你要写他撞在哪堵墙上，
写得具体：谁跟他说的、原话怎么说、他在哪站了多久。
他写下的事，你先想「怎么才办得成」，再想「什么真的挡得住他」。
写得靠谱就让他挣到钱；写得含糊，就替他挑那一年最合理的做法走一遍，别让他空手回来；
真撞上那一年过不去的坎，才让他碰壁——碰了壁就当场告诉他绕过去的路。
不要因为他写得长就多给钱，也不要替他决定他没写的大事（辞工、搬家、跟人翻脸）。

【钱】
这是玩家最在乎的事。每一天你都要算清楚今天进了多少出了多少，
数目要跟那一年的物价对得上——资料里给了当年的工钱和物价，照着来。

**他是白手起家的那一个，可他不笨，也肯下力气。** 开局本钱只有一成年收入，
没有背景，在这座城里谁也不认识：头两三天是找门路的，进项少，甚至倒贴。
门路一摸着，就该按他写的清单往上走。年卡里那些路子写的「做到头约多少」，
说的是这一行做熟了的人能挣多少。他头一个月站得住的是靠力气那几条；
要挣到最上头那个数，得真做成买卖，也得担点风险。
三十天下来，一个天天认真写、也肯冒点险的人，家底该翻到
「一个普通人三个月到半年的收入」那个量级；写得特别好又敢赌的，才够得着年卡上那个上限。
他天天写得像模像样却只挣到几块钱，那是这一天算坏了，不是他不行。
别把大商号的进项算到他头上，也别把他按在最底下不动。

**年卡里「做到头约多少」写的是一个月的数**，不是一天的：
一个月 42 元的活，一天该给一块四上下，不是四十二。

**付出去换回东西的钱，不算花掉。** 这条也常漏：
预付的货款、交的押金、屯的货、买的家伙什、盘下的摊位——
钱是出去了，可东西还在他手里。这几笔必须**在 entries 里记出账的同时，
在 assetsAdd 里把换回来的东西记上**，折成当年的钱。
只写「预付货款 −3000」而不写「货架上的货 3000」，等于这三千块凭空蒸发，
他辛苦一个月，账面上却越忙越穷。
真正花掉的只有：吃、住、路费、打点、修理、被罚被抢的。
东西卖出去的时候，再用 assetsDrop 把它划掉，同时把卖的钱记成进账。

**干了一天活，就该有一天的工钱。** 这条常被漏掉：开销你记得清清楚楚
（早饭、车钱、房钱），进账却经常忘了给。
他实打实干了一整天，进账就必须按资料里那条路子的行情记上，
不能只记花出去的。做提成的行当（跑中介、拉客、跑单帮）也一样：
三十天里总得成几单，不能一单不成——真要一单不成，
那是他自己写的清单里没在干正事。
不给钱只能有具体的原因：活儿没了、被赖账、被抓、身子垮了、
或者他今天压根没去干。原因必须写进正文，不能默不作声地不给。
东西也算钱：一辆自行车、三十斤全国粮票、一张调令、一间分到的房，
都要折成当年的钱记进家底。凭空冒出来的钱不算数。

【他想做的事，尽量让他做成】
这一段跟算账一样要紧。他写下来的事，**默认是办成了**——
你要写的是他怎么办成的：找了谁、说了哪句话、花了多少、绕了多远。

1. **一天最多有一件事办不成。** 清单上其余的照他写的往下走。
   一天里样样碰壁，是这一天算坏了，不是那一年难。
   （下面「他提到的这几样」里列出来的除外——那些是这一年真没有的，列几条就顶几条。）
2. **同一件事不许连着两天顶回去。** 他今天还写它，就让他找到路子——
   托人、加钱、换个说法、走后门、绕到别处去办。路子要具体到人名和价钱。
3. **犯法不等于办不成。** 那几年干这个犯法，说的是有人管、抓着要出事，
   不是他做不了。他要做就让他做成，钱照挣，代价记在「麻烦」上：
   **他今天只要沾了那几年犯法的事（私自雇人、倒买倒卖、投机、黑市换钱），
   麻烦就必须涨 5 到 15，一次都不许漏**，正文里还要有人看见他、有人提醒他。
   麻烦攒到 80 以上才真栽，栽那天再让他栽，栽得具体。
4. **只有这一年根本没有的东西才顶回去。** 顶回去的同时必须给他那一年的替代：
   没有快递就有信局和脚夫，没有银行贷款就有当铺、印子钱和会钱。
   写进正文里，别只丢一句「办不到」。
5. refused 里只写第 4 条那一种。**多数日子 refused 是空的。**

【怎么写】
第二人称，「你」就是玩家。叙述里不出现「我」，人物对话里的「我」不算。
白描，具体。用数目、时辰、器物、身上的伤、谁说了哪一句说话。
不抒情，不替读者下判断，不讲道理，不总结时代意义。

**句子要短。一句话超过三十个字就该打句号了**，别拿逗号一路串下去。
一段里长短句交错着来，全是长句读着累，全是短句像电报。
下面这两句一长一短，就是要的那个节奏：
  「工头坐在板凳上喝茶，听完你的话，上下打量你半晌。他说码头按件计酬。」
别写成这样（一句 55 个字，中间七个逗号）：
  「你没讨到好，又顶着烈日走到码头，扛包的工头正坐在板凳上喝茶，听完你的话，他上下打量你半晌，说码头全是按件计酬，要先入伙还得交一笔押金买钩子和护具。」

照这个感觉写：
  「粮站的人翻了本子，说你这个月的定量领过了。他手指头在本子上按着，没抬头。」
  「布料收了，钱当天没给。老周说月底一起结，你没敢问是哪个月底。」
  「你在码头站到日头偏西，那个拿名册的人始终没叫到你。」
别写成这样：
  「这一天充满了挑战与机遇。」——什么也没说
  「你深刻地感受到了时代的重量。」——替读者下判断
  「你成功地完成了这次交易，获得了可观的收益。」——公文腔，而且没说多少钱

【永远给他一条能走的路 —— 这条跟算账一样要紧】
他今天要是什么也没办成，正文里**必须**留下一条他明天就能走的路：
谁跟他说的、去哪找那个人、要带什么、要多少本钱。
「你的车没报备，接单要扣车」写完，就得接一句「西湖边那个老张说，
去萧山那边的车行租一辆带牌的，一天一百二，押金五百」。
只关门不给路，玩家会连着好几天空手回去，那不是难，那是卡住了。
连着两天什么都没挣到，第三天一定要让他抓住点什么——哪怕是最苦最少的那一档。

【绝对不许】
1. 写这一年还不存在的东西。资料里会点名玩家提到的哪些东西那时候没有，你必须把他顶回去。
2. 出现游戏用语：玩家、数值、加成、触发、解锁、副本、难度、存档、收益率。
3. 用「赋能」「闭环」「底层逻辑」「值得注意的是」「归根结底」这类词。
4. 讲道理、发感慨、总结这一天的意义。写完事情就停。

【输出】
只输出一个 JSON 对象，不要有别的话，不要包在反引号里：
{
  "story": "今天发生了什么，200 到 500 字",
  "entries": [{"what":"这笔钱是什么","amount":进账写正数、出账写负数}],
  "assetsAdd": [{"name":"东西的名字","kind":"实物/票证/权益/债权","worth":折成当年的钱值多少,"note":"一句话"}],
  "assetsDrop": ["卖掉或者丢掉的东西的名字，要跟家底里写的一模一样"],
  "debtsAdd": [{"who":"欠谁的","amount":欠多少,"note":"一句话"}],
  "debtsClear": ["还清了谁的债"],
  "standing": {"名声":变化,"关系":变化,"体力":变化,"麻烦":变化},
  "refused": [{"what":"他想做但做不成的事","why":"为什么做不成，一句话"}],
  "options": [{"what":"明天能做的一件事，二十来个字","why":"为什么值得做、或者要担什么风险，一句话"}]
}
refused 多数时候是空数组；options 每天都要给满三条。

【给他三条明天能走的路 —— 写进 options】
· 一条是稳的：今天这条路接着做，或者今天碰上的那个人让他明天再去。
· 一条是搏一把的：本钱要多押些、担点风险，成了能顶好几天。
· 一条是新路子：这一年这座城里另有的一条道，跟他今天做的不一样。
每条都要有具体的人、地方、价钱：「去码头找活」不算，
「一早去十六铺找工头老周，扛包按件算，一件八分」才算。
今天正文里出现过的人和事，优先写进去。

【进项的形状】
凭力气和跑腿挣的（做工、扛包、拉车、跑腿、糊纸盒），一天封顶在那一行当月工钱的三十分之一上下，
多干一点、干得好一点，最多再多一半。要比这个多，必须是**真做成了一笔买卖**：
有货、有买家、有价钱、有人名，三样缺一样就不算，钱也不许给。
「奖励」「补贴」「协调费」这种含糊的名目，一天最多一笔，而且不许一天比一天涨上去——
同一个名目连着给、数目还越给越大，是这一局算坏了的头号症状。

【钱怎么记 —— 这条最要紧】
今天每一笔进出都**单独**写进 entries，一笔一条，能拆多细就拆多细：
挣的那笔、送出去的门包、买烧饼的、喝水的、住店的、路上花的、被人抽的头，
一条都不能少。正文里提到花了钱或收了钱，entries 里就必须有对应的一条。
一天通常有三到六条，只写一条几乎肯定是漏了。
**总账由游戏自己加，你不要算总数，也不要在正文里写他还剩多少钱。**
正文只写今天进了什么出了什么，剩多少是游戏显示的事——
你写的余额跟游戏算的对不上，玩家一眼就看见。
standing 四项都是 −20 到 +20 之间的整数，没变化就写 0。
体力每天自然掉 5 到 15，睡好了才回。麻烦攒到 80 以上要出事。`;

function compactCard(c, sy, month) {
  const evs = (c.events || []).filter(e => Math.abs(e.month - month) <= 1 || e.month === month);
  const pick = evs.length >= 2 ? evs : (c.events || []).slice(0, 4);
  return `【${c.year} 年 · ${sy.city}】${c.era}
经济：${c.economy.mood}（${c.economy.number}）
这段日子的事：${pick.map(e => `${e.month} 月：${e.text}`).join('；')}
物价：${(c.prices || []).map(p => `${p.item} ${p.price}`).join('，')}
日常有的：${(c.tech['日常'] || []).join('、')}
有门路才有的：${(c.tech['稀罕'] || []).join('、')}
这一年没有的：${(c.tech['没有'] || []).join('、')}
挣钱的路子：${(c.money || []).map(m => `${m.way}（${m.who}，做到头约 ${m.ceiling}）`).join('；')}
干不了的事：${(c.forbidden || []).map(f => `${f.what}——${f.why}`).join('；')}
说来就来的祸事：${(c.risks || []).map(r => `${r.what}（${r.hit}）`).join('；')}`;
}

function buildUser(s, list, extra = {}) {
  const c = card(s.year);
  const sy = E.yearOf(s.year);
  const cur = E.currencyAt(s.year, s.month, s.day);
  const hits = E.scanAnachronism(list, s.year);

  const recent = s.days.slice(-3).map(d =>
    `第 ${d.day} 天：${(d.story || '').slice(0, 110)}…（${d.tally || ''}）`).join('\n') || '（今天是头一天）';

  const assets = s.assets.length
    ? s.assets.map(a => `${a.name}（${a.kind}，约值 ${E.money(a.worth, cur)}）`).join('、')
    : '什么都没有';
  const debts = s.debts.length ? s.debts.map(d => `欠${d.who} ${E.money(d.amount, cur)}`).join('、') : '不欠人钱';

  /* 给模型一把尺子。光说「别把大商号的进项算到他头上」，它会一天只给一块钱：
   * 三局机器人实测三十天净赚 0.04 / −0.09 / −0.46 年的收入，两局是亏的。
   * 尺子按当天那种钱算，换币之后自动跟着变。 */
  const income = E.incomeAtDay(s.year, s.month, Math.min(s.day, E.DAYS));
  const good = income / 70;                     // 做顺了的一天：半个月的收入
  const big = income / 10;                      // 谈成一笔：一个多月的收入
  const capToday = E.dayCap(s.year, s.month, Math.min(s.day, E.DAYS));
  /* 进度用「相当于几个月的收入」来说，不用钱数——换币那天钱数会差几百万倍，
   * 除以当天的年收入之后两头才比得了。 */
  const monthsNow = E.netWorth(s) / income * 12;
  const monthsStart = s.startWorth / E.incomeAtDay(s.year, s.month, 1) * 12;
  const monthsWant = monthsStart + 4.2 * (s.day - 1) / E.DAYS;   // 三十天攒够 0.35 年 = 4.2 个月
  const behind = s.day > 3 && monthsNow < monthsWant * 0.75;

  const refusedBefore = s.days.slice(-2).flatMap(d => (d.refused || []).map(r => r.what)).filter(Boolean);

  const monthEvents = (c.events || []).filter(e => e.month === s.month);
  const sw = sy.switch;
  /* 换过钱之后的每一天都要再说一遍钱的量级。只在换币当天提醒一次不够——
   * 第二天起模型会顺着前几天的记录接着用旧钱的数目，一天记出上亿来。 */
  const swPast = sw && s.month === sw.month && s.day > sw.day
    ? `\n**这个月 ${sw.day} 日已经换过钱了，现在用的是${E.CN[sw.to]}，不是${E.CN[sw.from]}。**\n` +
      `记账一律用${E.CN[sw.to]}的数目：一个普通人一年挣 ${E.money(E.incomeAtDay(s.year, s.month, s.day), sw.to)}，` +
      `一顿饭、一次车钱都是个位数或者几十。前几天那些${E.CN[sw.from]}的数目不要再照着写。` : '';
  const swToday = sw && s.month === sw.month && s.day === sw.day
    ? `\n**今天就是换钱那天**：${sw.say}\n` +
      `上面「他现在的家底」那个数**已经是折算之后的新钱了**，游戏替他换好了。\n` +
      `所以：正文里要写这件事（他排了多久的队、柜台上怎么说、手里那叠旧钞变成了什么），` +
      `但 **entries 里绝对不许再记一笔「换钱的损失」**——那等于同一笔钱扣两遍。` : '';

  const rulings = hits.length
    ? `\n【他提到的这几样，这一年办不成——必须顶回去，写清楚为什么】\n` +
      hits.map(h => `· 「${h.word}」：${E.sayAnachronism(h)}。${h.note || ''}`).join('\n') +
      `\n把这几条写进 refused 里，正文里也要让他撞上这堵墙。\n` +
      `注意分清楚是哪一种：**根本没有这东西**（他跟人说，对方听不懂），` +
      `还是**有这东西但这几年干这个犯法**（他做得成，可有人管，抓着要出事）。这两种写法完全不一样。`
    : '';

  return `${compactCard(c, sy, s.month)}

【今天】${s.year} 年 ${s.month} 月 ${s.day} 日，第 ${s.day} 天，一共 ${E.DAYS} 天。
${monthEvents.length ? `这个月正在发生：${monthEvents.map(e => e.text).join('；')}` : ''}${swToday}${swPast}

【他现在的家底】
手里的钱：${E.money(s.cash, cur)}（这一年一个普通人一年挣 ${E.money(E.incomeAt(s.year, s.month), cur)}）
东西：${assets}
欠债：${debts}
名声 ${s.standing.名声} · 关系 ${s.standing.关系} · 体力 ${s.standing.体力} · 麻烦 ${s.standing.麻烦}

【前几天】
${recent}
${refusedBefore.length ? `前两天已经顶回去过这几件：${refusedBefore.join('、')}。
他今天要是还写同一件，就让他找到路子办成——托人、加钱、换个地方办，不许再顶一次。` : ''}

【今天这一天该走到哪儿】
做顺了的一天，连做工带买卖，净进大概 ${E.money(good, cur)}；谈成一笔像样的买卖，那一天能到 ${E.money(big, cur)}。
光靠做工、扛包、跑腿的一天，只有 ${E.money(income / 360, cur)} 上下——多出来的必须是买卖挣的，写清楚货、买家和价钱。
今天无论如何不许超过 ${E.money(capToday, cur)}——超了游戏会削平，正文和账面就对不上。
他落地那天的家底相当于一个普通人 ${monthsStart.toFixed(1)} 个月的收入，现在是 ${monthsNow.toFixed(1)} 个月，
走到第 ${s.day} 天该在 ${monthsWant.toFixed(1)} 个月上下。
${behind ? '他落下了：今天让他抓住点实在的东西，把欠的补回来一些。'
  : monthsNow > monthsWant * 1.4 ? '他已经跑在前头了：今天把进项收紧，只给他做实了的那一份，含糊的名目一笔都不给。'
  : '他走在道上：接着按他写的算，别忽然塞给他一座金山。'}

【他今天写的清单】
${String(list).trim()}
${rulings}${extra.retry ? `\n\n【上一版写得不合格，改掉这几条再给我一遍完整的 JSON】\n${extra.retry.map(x => '- ' + x).join('\n')}` : ''}`;
}

/* ── 调模型 ────────────────────────────────────────── */

/** 玩家在等这一天出来，所以有个总预算：默认 55 秒。
 *  只有一种情况会重来——回的东西解析不成 JSON。文风不再拦。 */
async function runDay(s, list, opts = {}) {
  const OR = require('./tools/or.js');
  const budget = opts.budget || 55000;
  const t0 = Date.now();
  const left = () => budget - (Date.now() - t0);
  const user = buildUser(s, list);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const text = await OR.call(opts.model || MODEL, SYS, user, {
        json: true, maxTokens: 2500, temperature: 0.85,
        timeout: Math.max(8000, Math.min(30000, left())), tries: attempt === 1 ? 2 : 1,
      });
      return { delta: OR.parseJson(text), ms: Date.now() - t0, problems: [] };
    } catch (err) {
      if (attempt === 2 || left() < 12000) throw err;
    }
  }
  throw new Error('这一天没算出来');
}

/* ── 没有密钥时的兜底：本地算一天，能玩完，但正文是模板 ── */
function rng(seed) { let x = seed >>> 0; return () => (x = (x * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

function runDayLocal(s, list) {
  const c = card(s.year);
  const r = rng((s.seed || 1) * 7919 + s.day * 104729);
  const hits = E.scanAnachronism(list, s.year);
  const ways = c.money || [];
  const way = ways[Math.floor(r() * ways.length)] || { way: '打零工', who: '谁都行' };
  /* 必须用 incomeAtDay：incomeAt 拿的是整月记的**新钱**，
   * 而换币前手里是旧钱。1948 年 8 月前 18 天会按金圆券的量级发工钱，
   * 而那时候的年收入是 1.84 亿法币——差三百万倍，等于前半个月白过。 */
  const inc = E.incomeAtDay(s.year, s.month, s.day);

  /* 写得越具体给得越多。尺子跟提示词里给模型的那把一样：做顺了的一天
   * 约合半个月的收入（inc/70）。原来是 inc/365 那一档，一天挣一顿饭钱，
   * 三十天下来跟没玩一样。 */
  const effort = 0.5 + Math.min(1, E.countHan(list) / 160);
  const luck = 0.5 + r() * 0.9;
  /* 撞上这一年没有的东西：只废掉那一件，剩下的时间照旧干活，
   * 拿平常的一半。整天清零是旧写法，跟现在「一天最多一件事办不成」对不上。 */
  const gain = inc / 70 * effort * luck * (hits.length ? 0.5 : 1);

  const story = hits.length
    ? (hits[0].kind === 'banned'
        ? `你把想做的事说给一个熟人听。说到「${hits[0].word}」，他往门口看了一眼，压低声音让你别再提。` +
          `「这两年抓得紧。」这一件只好搁下。后半天你去做了${way.way}，天黑前收了工。`
        : `你把想做的事跟街上的人说了一遍。说到「${hits[0].word}」的时候，对方停下来看着你，问那是什么。` +
          `你解释了两句，他摇摇头走了。这一件办不成，你转头去做${way.way}，日头偏西才回来。`)
    : `你按写下的去做了。${way.way}这条路，${way.who}。` +
      `跑了大半天，鞋底沾了一层灰。到日头偏西的时候，事情算是有了个着落。`;

  return {
    delta: {
      story,
      entries: [{ what: hits.length ? '白跑一天的开销' : (way.way || '打零工'), amount: Math.round(gain * 100) / 100 }],
      assetsAdd: [], assetsDrop: [], debtsAdd: [], debtsClear: [],
      standing: { 名声: hits.length ? 0 : 1, 关系: 0, 体力: -(6 + Math.floor(r() * 8)), 麻烦: hits.length ? 1 : 0 },
      refused: hits.slice(0, 1).map(h => ({ what: h.word, why: E.sayAnachronism(h) })),
      options: optionsLocal(s),
    },
    local: true, problems: [],
  };
}

/* ── 明天能走的三条路 ──────────────────────────────
 * 每天算完自动带回来一份（跟正文同一次调用，不额外花钱也不多等），
 * 头一天和玩家点「换三条」的时候才单独调一次模型。
 * 断网、没密钥、模型没给，都退回 optionsLocal——照年卡里的路子拼，
 * 一分钱不花，也永远有三条。 */

/** 照年卡里的挣钱路子拼三条：稳的、来钱最快的、另一条 */
function optionsLocal(s, salt) {
  const c = card(s.year);
  const r = rng((s.seed || 1) * 31 + s.day * 7919 + (salt || 0));
  const ways = (c.money || []).slice();
  if (!ways.length) return [];
  const byMoney = ways.slice().sort((a, b) => (b.ceilingYears || 0) - (a.ceilingYears || 0));
  const rich = byMoney[0];
  const steady = byMoney[byMoney.length - 1];
  const rest = ways.filter(w => w !== rich && w !== steady);
  const other = rest.length ? rest[Math.floor(r() * rest.length)] : ways[Math.floor(r() * ways.length)];
  /* 年卡里的句子有的自带句号，接上「。谁在做」会变成两个点 */
  /* 年卡里的句子有的自带句号，也常带一句「（估算，非直接调查数）」这样的注脚——
   * 那是写年卡时给自己看的，摆到屏幕上只会占地方。 */
  const tail = x => String(x || '').replace(/[（(][^）)]*[）)]/g, '').replace(/[。；，、\s]+$/, '');
  /* 年卡里的「做到头约多少」常是两三句，取头一句就够，剩下的塞不进一张纸条 */
  const money1 = w => tail(String(w.ceiling || '').split(/[；;]/)[0]).slice(0, 24);
  const one = (w, label) => w && { what: tail(w.way).slice(0, 40), why: (label + (money1(w) ? `。做到头约${money1(w)}` : '')).slice(0, 46) };
  return [
    one(steady, '稳当'),
    one(rich, '来钱最快，也最容易出事'),
    one(other, '换个方向试试'),
  ].filter(Boolean);
}

const OPT_SYS = `你是《这一百年》的记事人。玩家落在中国近一百年里的某一年某一个月，
在一座城里过三十天，每天写一份要做的事。现在给他三条明天能走的路。

三条各有各的用处：一条是稳的（今天这条路接着做，或者今天碰上的那个人明天再去找），
一条是搏一把的（本钱押得多、担点风险，成了能顶好几天），
一条是新路子（这一年这座城里另有的一条道）。

每条都要有具体的人、地方、价钱：「去码头找活」不算，
「一早去十六铺找工头老周，扛包按件算，一件八分」才算。
只写那一年真有的事，不写那时候还没有的东西。不出现游戏用语。

只输出一个 JSON 对象：
{"options":[{"what":"明天能做的一件事，二十来个字","why":"为什么值得做、或者要担什么风险，一句话"}]}`;

async function runOptions(s, opts = {}) {
  const OR = require('./tools/or.js');
  const c = card(s.year);
  const cur = E.currencyAt(s.year, s.month, Math.min(s.day, E.DAYS));
  const last = s.days[s.days.length - 1];
  const user = `【${s.year} 年 ${s.month} 月 ${s.day} 日 · ${s.city}】${c.era}
物价：${(c.prices || []).slice(0, 6).map(p => `${p.item} ${p.price}`).join('，')}
挣钱的路子：${(c.money || []).map(m => `${m.way}（${m.who}，做到头约 ${m.ceiling}）`).join('；')}
干不了的事：${(c.forbidden || []).map(f => f.what).join('；')}
他手里 ${E.money(s.cash, cur)}（这一年一个普通人一年挣 ${E.money(E.incomeAtDay(s.year, s.month, Math.min(s.day, E.DAYS)), cur)}），
东西：${s.assets.map(a => a.name).join('、') || '什么都没有'}，体力 ${s.standing.体力}，麻烦 ${s.standing.麻烦}。
${last ? `昨天：${String(last.story || '').slice(0, 200)}` : '今天是头一天，他刚落地，谁也不认识。'}`;

  try {
    const text = await OR.call(opts.model || MODEL, OPT_SYS, user, {
      json: true, maxTokens: 600, temperature: 0.9, timeout: opts.timeout || 15000, tries: 2,
    });
    const out = OR.parseJson(text);
    const list = Array.isArray(out.options) ? out.options : [];
    if (list.length) return { options: list, local: false };
  } catch (err) { /* 掉下去走本地那份 */ }
  return { options: optionsLocal(s, opts.salt), local: true };
}

module.exports = { runDay, runDayLocal, runOptions, optionsLocal, buildUser, card, SYS, MODEL };
