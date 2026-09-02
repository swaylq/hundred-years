'use strict';
/* 查一张年卡。写完一年就跑一次：
 *
 *   node tools/check-one-year.js 1937
 *
 * 退出码 0 才算这一年做完了。**不许为了让它过而放宽这个脚本**——
 * 它和 tools/check-years.js 用的是同一套判据（同一份代码），
 * 改了这里不改那里，收工时全量一跑照样红。
 */
const path = require('path');
const fs = require('fs');
const { checkCard } = require('./check-years.js');
const SPINE = require('../data/spine.json');

const y = Number(process.argv[2]);
if (!(y >= 1926 && y <= 2025)) { console.error('用法：node tools/check-one-year.js 1937'); process.exit(2); }

const f = path.join(__dirname, '..', 'data', 'years', `${y}.json`);
if (!fs.existsSync(f)) { console.error(`还没有 data/years/${y}.json`); process.exit(1); }

let card;
try { card = JSON.parse(fs.readFileSync(f, 'utf8')); }
catch (e) { console.error(`${y}.json 不是合法的 JSON：${e.message}`); process.exit(1); }

const sy = SPINE.years.find(x => x.year === y);
const errs = checkCard(card, sy);

/* 顺手把这一年的关键数印出来，好对着看 */
const CN = { SILVER: '银元', FABI: '法币', GOLDYUAN: '金圆券', RMB1: '第一套人民币', RMB: '人民币' };
const jan = sy.months[0];
console.log(`${y} 年 · 落点 ${sy.city} · 当年的钱 ${sy.currencies.map(c => CN[c]).join(' / ')}`);
console.log(`  中位年收入 ${jan.income.toPrecision(4)}（一个月 ${(jan.income / 12).toPrecision(4)}）· 白手起家的顶 ${sy.ceiling} 年`);
if (sy.switch) console.log(`  ${sy.switch.month} 月 ${sy.switch.day} 日换钱：${sy.switch.say}`);
console.log(`  出处 ${Array.isArray(card.sources) ? card.sources.length : 0} 条`);

if (errs.length) {
  console.log(`\n没过，${errs.length} 条：`);
  for (const e of errs) console.log('  x ' + e);
  process.exit(1);
}
console.log('\n过了');
