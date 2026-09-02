'use strict';
/* 端到端跑一遍网页并截图。服务端要先起着。
 *
 *   node tools/shoot.js [--out goal/shots] [--url http://127.0.0.1:8801] [--days 2]
 *     --days N   在网页上真打几天（每天都是一次模型调用，慢；默认 2）
 *     --fast     不打天，只截静态几屏
 *
 * 断言不过就退出码 1。截图存到 --out。
 */
const path = require('path');
const fs = require('fs');
const { chromium } = require('/Users/sway003/text-game/node_modules/playwright');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (i >= 0 ? true : d); };
const OUT = path.resolve(String(arg('out', path.join(__dirname, '..', 'goal', 'shots'))));
const URL = String(arg('url', 'http://127.0.0.1:8801'));
const DAYS = Number(arg('days', 2));
const FAST = !!arg('fast');

const fails = [];
const ok = m => console.log('  ✓ ' + m);
const check = (c, m) => { if (c) ok(m); else { fails.push(m); console.log('  ✗ ' + m); } };

async function snap(page, name) {
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, name + '.png'), fullPage: false });
  console.log('    截图 ' + name + '.png');
}

/** 页面横向不许溢出——手机上最容易犯 */
async function noHScroll(page, where) {
  const r = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    win: window.innerWidth,
  }));
  check(r.doc <= r.win + 1, `${where}：不横向溢出（内容 ${r.doc}px，视口 ${r.win}px）`);
}

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e.message)));
  const failed = [];
  page.on('requestfailed', r => failed.push(r.url()));
  page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });

  console.log('一、挑一年');
  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.waitForSelector('.yr', { timeout: 15000 });
  const nYears = await page.locator('.yr').count();
  const nReady = await page.locator('.yr:not([disabled])').count();
  check(nYears === 100, `一百个格子都在（数到 ${nYears} 个）`);
  check(nReady > 0, `${nReady} 年可以进`);
  await snap(page, 'a-挑一年');
  await noHScroll(page, '挑一年');

  console.log('\n二、一年的详情和选月');
  await page.locator('.yr:not([disabled])').first().click();
  await page.waitForSelector('#year-head .big', { timeout: 10000 });
  await page.waitForFunction(() => !/读取中/.test(document.querySelector('#year-head .era')?.textContent || '读取中'), { timeout: 15000 });
  const yr = await page.locator('#year-head .big').textContent();
  check(/^\d{4}$/.test(yr.trim()), `年份标题是 ${yr.trim()}`);
  const flavor = (await page.locator('.flavor').textContent()) || '';
  check(flavor.length >= 120, `开场白 ${flavor.length} 字`);
  const nPrices = await page.locator('.pricegrid div').count();
  check(nPrices >= 6, `物价 ${nPrices} 条`);
  const nMonths = await page.locator('.mo').count();
  check(nMonths === 12, `十二个月都能选（数到 ${nMonths} 个）`);
  await snap(page, 'b-一年的详情');

  console.log('\n三、选月开局');
  await page.locator('.mo').nth(9).click();                 // 第 10 月
  check(!(await page.locator('#start-box').isHidden()), '选了月份之后出现开局的入口');
  await page.locator('#nick').fill('截图');
  await page.locator('#start').click();
  await page.waitForSelector('#s-play.on', { timeout: 15000 });
  await page.waitForSelector('.bar .cash', { timeout: 10000 });
  await snap(page, 'c-开局');

  console.log('\n四、清单超字数要被挡住');
  await page.locator('#list').fill('啊'.repeat(520));
  await page.waitForTimeout(150);
  const overTxt = await page.locator('#count').textContent();
  const overCls = await page.locator('#count').getAttribute('class');
  const sendOff = await page.locator('#send').isDisabled();
  check(/520\s*\/\s*500/.test(overTxt), `字数显示 ${overTxt.trim()}`);
  check((overCls || '').includes('over'), '超了之后字数变红');
  check(sendOff, '超了之后不让提交');
  await snap(page, 'd-超字数被挡住');

  if (!FAST) {
    console.log(`\n五、真打 ${DAYS} 天`);
    for (let i = 1; i <= DAYS; i++) {
      await page.locator('#list').fill(
        i === 1
          ? '早上去码头等活，找工头塞点门包，谈按件不按天。中午省一顿。下午打听哪里还招人，问清工钱管不管住。晚上找地方合租，租金压低些。'
          : '接着昨天那条路做，做熟了就快。今天多问两家，看哪家给的价高。省着花，把钱攒下来。');
      await page.waitForTimeout(120);
      await page.locator('#send').click();
      await page.waitForFunction(
        d => document.querySelector('.bar .of')?.textContent.includes(`第 ${d + 1} /`),
        i, { timeout: 120000 });
      const story = (await page.locator('.story p').textContent()) || '';
      check(story.length >= 60, `第 ${i} 天有正文（${story.length} 字）`);
      const nEntry = await page.locator('.tally .e').count();
      check(nEntry >= 1, `第 ${i} 天有 ${nEntry} 条分录`);
    }
    await snap(page, 'e-过完一天');
  }

  if (!FAST) {
    console.log('\n五之二、翻一下这一年');
    await page.locator('#ref > summary').click();
    await page.waitForTimeout(900);
    const refBlocks = await page.locator('#ref-body .block').count();
    check(refBlocks >= 3, `玩的时候翻得到这一年的物价和禁忌（${refBlocks} 块）`);
    await snap(page, 'e2-翻一下这一年');
    await page.locator('#ref > summary').click();
  }

  console.log('\n六、排行榜');
  await page.locator('[data-go="board"]').first().click();
  await page.waitForSelector('#s-board.on', { timeout: 5000 });
  await page.waitForTimeout(600);
  const hasBoard = await page.locator('table.board, .empty').count();
  check(hasBoard > 0, '排行榜出得来（有榜或者有「还没人打完」）');
  await snap(page, 'f-排行榜');

  console.log('\n六之二、结算页（用接口另打一局，不然要在网页上点三十次）');
  {
    const post = async (p2, d) => (await fetch(URL + p2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) })).json();
    const r = await post('/api/run', { year: 1930, month: 10, nick: '截图' });
    for (let d = 1; d <= 30; d++) await post('/api/day', { id: r.id, token: r.token, list: '早上去码头等活，塞两角门包，谈按件不按天。晚上找同乡合租。' });
    const dp = await ctx.newPage();
    dp.on('pageerror', e => errors.push('结算页：' + String(e.message)));
    await dp.goto(URL, { waitUntil: 'networkidle' });
    await dp.evaluate(([t, i]) => { localStorage.setItem('hy.token', t); localStorage.setItem('hy.run', i); }, [r.token, r.id]);
    await dp.reload({ waitUntil: 'networkidle' });
    await dp.waitForSelector('#s-play.on', { timeout: 15000 });
    const label = (await dp.locator('#send').textContent()).trim();
    check(label === '去结算', `走满三十天之后按钮写的是「${label}」`);
    await dp.locator('#send').click();
    await dp.waitForSelector('#s-done.on', { timeout: 20000 });
    await dp.waitForTimeout(400);
    const num = (await dp.locator('.score-card .num').textContent()).trim();
    check(/^[−-]?\d/.test(num), `结算页有分数：${num}`);
    const nDays = await dp.locator('details.day').count();
    check(nDays === 30, `结算页能回看 ${nDays} 天`);
    const actTop = await dp.locator('.done-acts').boundingBox();
    const dayTop = await dp.locator('details.day').first().boundingBox();
    check(actTop && dayTop && actTop.y < dayTop.y, '「再来一局」在三十天列表上面，不会被挤下去');
    await snap(dp, 'f2-结算');
    await dp.locator('details.day').nth(3).click();
    await dp.waitForTimeout(200);
    check((await dp.locator('details.day[open] .daybox p').count()) > 0, '点开某一天能看到那天的正文');
    await snap(dp, 'f3-回看某一天');
    await dp.close();
  }

  console.log('\n七、手机宽度 390×844');
  /* 单开一个上下文：跟桌面那一局共用 localStorage 的话，
   * 一进来就会自动接着上一局走，压根到不了挑年份那一屏。 */
  const mctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const m = await mctx.newPage();
  m.on('pageerror', e => errors.push('手机：' + String(e.message)));
  await m.goto(URL, { waitUntil: 'networkidle' });
  await m.waitForSelector('.yr', { timeout: 15000 });
  await snap(m, 'g-手机-挑一年');
  await noHScroll(m, '手机挑一年');
  await m.locator('.yr:not([disabled])').first().click();
  await m.waitForFunction(() => !/读取中/.test(document.querySelector('#year-head .era')?.textContent || '读取中'), { timeout: 15000 });
  await snap(m, 'h-手机-一年的详情');
  await noHScroll(m, '手机年份详情');
  /* 输入框字号必须 ≥16px，不然 iOS 一聚焦就把整页放大 */
  await m.locator('.mo').nth(5).click();
  const fs16 = await m.evaluate(() => {
    const t = document.querySelector('#nick');
    return t ? parseFloat(getComputedStyle(t).fontSize) : 0;
  });
  check(fs16 >= 16, `手机上输入框字号 ${fs16}px（低于 16 会被 iOS 放大整页）`);

  console.log('\n八、页面本身');
  check(errors.length === 0, errors.length ? `控制台报错 ${errors.length} 条：${errors[0].slice(0, 90)}` : '没有 JS 报错');
  const realFail = failed.filter(u => !/favicon/.test(u));
  check(realFail.length === 0, realFail.length ? `资源加载失败：${realFail.join(' , ').slice(0, 200)}` : '资源一个不缺');

  await browser.close();
  console.log(`\n截图在 ${OUT}`);
  if (fails.length) { console.log(`\n没过 ${fails.length} 条：\n  ${fails.join('\n  ')}`); process.exit(1); }
  console.log('全过');
})().catch(e => { console.error('跑挂了：', e.message); process.exit(1); });
