'use strict';
/* 把新加的那几屏在真页面上走一遍并截图：
 * 结算 + 收梢 → 接着走下去 → 后传榜 → 一局的详情。
 * 先跑 tools/seed-extra.js 塞好局，再起服务。
 *
 *   node tools/shoot-extra.js --url http://127.0.0.1:8899 --token <t> --ready <id> --extra <id> --done <id>
 */
const path = require('path'), fs = require('fs');
const { chromium } = (() => {
  const tries = ['playwright', path.join(__dirname, '..', '..', '..', 'node_modules', 'playwright'),
    '/Users/mac/claudeclaw/asst/node_modules/playwright'];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  console.error('找不到 playwright'); process.exit(2);
})();
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 ? process.argv[i + 1] : d; };
const URL = arg('url', 'http://127.0.0.1:8899');
const OUT = path.join(__dirname, '..', 'goal', 'shots-extra');
const fails = [];
const check = (c, m) => { if (c) console.log('  ✓ ' + m); else { fails.push(m); console.log('  ✗ ' + m); } };
const snap = async (p, n) => { fs.mkdirSync(OUT, { recursive: true }); await p.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true }); console.log('    截图 ' + n + '.png'); };
const noH = async (p, w) => { const r = await p.evaluate(() => ({ d: document.documentElement.scrollWidth, w: window.innerWidth })); check(r.d <= r.w + 1, `${w}：不横向溢出（${r.d} / ${r.w}）`); };

(async () => {
  const b = await chromium.launch();
  const page = await b.newPage({ viewport: { width: 1180, height: 900 } });
  page.on('pageerror', e => { fails.push('页面报错 ' + e.message); console.log('  ✗ 页面报错 ' + e.message); });
  await page.goto(URL);
  await page.evaluate(([t, r]) => { localStorage.setItem('hy.token', t); localStorage.setItem('hy.run', r); },
    [arg('token'), arg('ready')]);

  /* 1. 接着上次那一局 → 二十四个月走完了 → 去算账 */
  console.log('1. 结算页：成绩单 + 收梢 + 接着走下去');
  await page.goto(URL);
  await page.waitForSelector('#s-play.on', { timeout: 15000 });
  check(await page.locator('#send').innerText() === '两年到了，去算账', '走完了，按钮变成「去算账」');
  await page.click('#send');
  await page.waitForSelector('#s-done.on', { timeout: 30000 });
  check(await page.locator('#done-body .score-card .num').count() === 1, '成绩单出来了');
  check(/接着走下去/.test(await page.locator('#done-more').innerText()), '结算页给了「接着走下去」');
  const room = await page.locator('#done-more button.primary').innerText();
  check(/还能走 5 年/.test(room), '2015-06 那一局还能走五年：' + room);
  await page.waitForSelector('#done-review .rev-title', { timeout: 90000 });
  const rev = await page.locator('#done-review').innerText();
  check(rev.length > 120, `收梢写出来了，${rev.length} 字`);
  check(!/分数|排行|榜单|属性|系统|玩家|这一局|存档/.test(rev), '收梢里没有游戏用语');
  await noH(page, '结算页');
  await snap(page, '1-done');
  console.log('    收梢头一段：' + rev.split('\n').slice(0, 4).join(' / ').slice(0, 160));

  /* 2. 点「接着走下去」，回到过日子那一屏，月数变成 84 */
  console.log('2. 接着走下去');
  await page.click('#done-more button.primary');
  await page.waitForSelector('#s-play.on', { timeout: 20000 });
  const foot = await page.locator('.cal-foot').innerText();
  check(/第 25 \/ 84 个月/.test(foot), '接上之后站在第 25 个月，一共 84 个月：' + foot.split('·')[0].trim());
  check(!(await page.locator('#list').isDisabled()), '又写得动了');
  await noH(page, '后传第一个月');
  await snap(page, '2-extra-play');

  /* 3. 后传榜 */
  console.log('3. 排行榜：多了一张后传榜');
  await page.click('#top nav button[data-go="board"]');
  await page.waitForSelector('#s-board.on');
  await page.waitForSelector('#board-tabs button');          // loadBoard 是异步的，等它画完再看
  check((await page.locator('#board-tabs button').allInnerTexts()).includes('后传榜'), '页签里有「后传榜」');
  await page.click('#board-tabs button:has-text("后传榜")');
  await page.waitForFunction(() => /不在总榜里/.test(document.querySelector('#board-note').innerText), null, { timeout: 10000 });
  check(true, '后传榜说明白了「不在总榜里」');
  await page.waitForSelector('#board-body table.board');
  check(await page.locator('#board-body tbody tr').count() >= 1, '后传榜上有人');
  await noH(page, '后传榜');
  await snap(page, '3-board-extra');

  /* 4. 点一行进详情 */
  console.log('4. 一局的详情');
  await page.click('#board-body tbody tr:first-child');
  await page.waitForSelector('#s-detail.on');
  await page.waitForSelector('#detail-body .score-card');
  const det = await page.locator('#detail-body').innerText();
  check(/后传/.test(det), '详情页把后传那一段单列出来了');
  check(await page.locator('#detail-body .score-card').count() === 2, '两张成绩单：两年那一份 + 后传那一份');
  check(await page.locator('#detail-body details.day').count() === 84, '84 个月一个不少，点得开');
  check(await page.locator('#detail-body .extra-cut').count() === 1, '回看里标了「往下这些是后传」');
  await noH(page, '详情页');
  await snap(page, '4-detail');
  await page.locator('#detail-body details.day').nth(30).click();
  await snap(page, '5-detail-open');

  /* 5. 手机宽度过一遍 */
  console.log('5. 手机宽度');
  const m = await b.newPage({ viewport: { width: 390, height: 844 } });
  m.on('pageerror', e => { fails.push('手机页报错 ' + e.message); });
  await m.goto(URL + '/#');
  await m.evaluate(t => localStorage.setItem('hy.token', t), arg('token'));
  await m.goto(URL);
  await m.click('#top nav button[data-go="mine"]');
  await m.waitForSelector('#s-mine.on table.board');
  const mine = await m.locator('#mine-body').innerText();
  check(/看详情/.test(mine), '「我的局」里结过账的那几行给了「看详情」');
  await noH(m, '手机 · 我的局');
  await snap(m, '6-m-mine');
  await m.click('#mine-body tbody tr:has-text("看详情")');
  await m.waitForSelector('#s-detail.on .score-card');
  await noH(m, '手机 · 详情页');
  await snap(m, '7-m-detail');

  await b.close();
  console.log(fails.length ? `\n${fails.length} 条没过：\n - ` + fails.join('\n - ') : '\n都过了');
  process.exit(fails.length ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
