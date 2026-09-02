'use strict';
/* 端到端跑一遍网页并截图。服务端要先起着。
 *
 *   node tools/shoot.js [--out goal/shots] [--url http://127.0.0.1:8801] [--months 2]
 *     --months N 在网页上真打几个月（每个月都是一次模型调用，慢；默认 2）
 *     --fast     不打月，只截静态几屏
 *
 * 断言不过就退出码 1。截图存到 --out。
 */
const path = require('path');
const fs = require('fs');
// playwright 不在本项目的依赖里，去几个已知位置找一份能用的
const { chromium } = (() => {
  const tries = [
    'playwright',
    path.join(__dirname, '..', '..', '..', 'node_modules', 'playwright'),   // 本 agent 根目录
    '/Users/mac/claudeclaw/asst/node_modules/playwright',
    '/Users/sway003/text-game/node_modules/playwright',
  ];
  for (const t of tries) { try { return require(t); } catch (e) {} }
  console.error('找不到 playwright。在本 agent 根目录跑一次 `npm i playwright` 再来，或改这里的路径。');
  process.exit(2);
})();

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : (i >= 0 ? true : d); };
const OUT = path.resolve(String(arg('out', path.join(__dirname, '..', 'goal', 'shots'))));
const URL = String(arg('url', 'http://127.0.0.1:8801'));
const MONTHS = Number(arg('months', arg('days', 2)));
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
  page.on('requestfailed', r => failed.push(`${r.url()} ${(r.failure() || {}).errorText || ''}`.trim()));
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
  await page.waitForSelector('.flavor', { timeout: 15000 });
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

  /* 主角设定：先拿超人的写法试一次，必须被顶回去、还留在开局那一屏 */
  await page.locator('#persona').fill('会一身好武功，能以一敌百');
  await page.locator('#start').click();
  await page.waitForTimeout(1200);
  check(await page.locator('#s-play.on').count() === 0, '写「会武功」开不了局，还停在挑年份那一屏');
  check((await page.locator('#toast').textContent()).includes('武功'), '顶回去的时候说清楚了为什么');
  /* 上面那一下是故意讨来的 400，从「资源加载失败」的名单里摘掉，别的照旧算失败 */
  { const i = failed.findIndex(x => /400 .*\/api\/run/.test(x)); if (i >= 0) failed.splice(i, 1); }

  const PERSONA = '做事踏实，嘴笨，认死理，不会来事';
  await page.locator('#persona').fill(PERSONA);
  await page.waitForTimeout(120);
  await snap(page, 'b2-开局那一屏');
  check((await page.locator('#persona-count').textContent()).startsWith('13 /'), '设定框只数汉字，标点不计（13 个汉字 + 3 个逗号）');
  await page.locator('#start').click();
  await page.waitForSelector('#s-play.on', { timeout: 15000 });
  await page.waitForSelector('.bar .cash', { timeout: 10000 });
  /* 四条杠 09-03 晚又要回来了：三条常驻，麻烦是 0 的时候不显示 */
  check(await page.locator('.bar .meter').count() === 3, `左栏有那几条杠（数到 ${await page.locator('.bar .meter').count()} 条；麻烦是 0 时不显示）`);
  check((await page.locator('.bar .who-line').textContent()).includes('认死理'), '左栏最下面写着他是个什么人');
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
    console.log(`\n五、真打 ${MONTHS} 个月`);
    for (let i = 1; i <= MONTHS; i++) {
      await page.locator('#list').fill(
        i === 1
          ? '月初去码头等活，找工头塞点门包，谈按件不按月。中间省着吃。再打听哪里还招人，问清工钱管不管住。月底前找地方合租，租金压低些。'
          : '接着上个月那条路做，做熟了就快。这个月多问两家，看哪家给的价高。省着花，把钱攒下来。');
      await page.waitForTimeout(120);
      await page.locator('#send').click();
      await page.waitForFunction(
        d => document.querySelector('.bar .of')?.textContent.includes(`第 ${d + 1} /`),
        i, { timeout: 120000 });
      const story = (await page.locator('.story p').textContent()) || '';
      check(story.length >= 60, `第 ${i} 个月有正文（${story.length} 字）`);
      const nEntry = await page.locator('.tally .e').count();
      check(nEntry >= 1, `第 ${i} 个月有 ${nEntry} 条分录`);
    }
    await snap(page, 'e-过完一个月');
  }

  if (!FAST) {
    /* 记着的事那一折：走过两个月，两个月都该在里头，一个字都不许少 */
  {
    const memo = await page.evaluate(() => {
      const d = document.querySelector('#memo');
      if (!d || d.hidden) return null;
      d.open = true;
      return { 概要: d.querySelector('summary').textContent, 正文: d.querySelector('#memo-body').innerText };
    });
    check(!!memo, '玩的时候翻得到「这一局记着的事」');
    if (memo) {
      check(/2 个月/.test(memo.概要), `折起来的那行写着走了几个月：${memo.概要.slice(0, 40)}`);
      check(!memo.正文.includes('走过的路'), '玩的时候不摆「走过的路」（二十四行压在旁边太乱）');
      check(/认识的人|还没了结的|练出来/.test(memo.正文), '该有的还在：认识的人／没了结的／练出来的');
      await snap(page, 'e3-记着的事');
    }
  }

  /* 他这两年练出来的：走两个月未必攒得出来，攒出来了就得显示 */
  {
    const tr = await page.evaluate(() => {
      const box = document.querySelector('.bar .traits');
      const memo = (window.run && run.state.memo && run.state.memo.traits) || [];
      return { 显示了: !!box, 存了: memo.filter(t => !t.lost).map(t => t.what) };
    });
    if (tr.存了.length) check(tr.显示了, `攒出了 ${tr.存了.length} 样本事，左栏显示了：${tr.存了.join('、')}`);
    else ok(`走了两个月还没攒出本事来，左栏也就没这一栏（正常）`);
  }

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

  {
    const tabCount = await page.locator('#board-tabs button').count();
    check(tabCount >= 1, `榜上有 ${tabCount} 个页签（总榜 + 有成绩的年份）`);
    if (tabCount > 1) {
      await page.locator('#board-tabs button').nth(1).click();
      await page.waitForTimeout(700);
      check(await page.locator('table.board, .empty').count() > 0, '点年份能切到那一年的年榜');
      await snap(page, 'f1-年榜');
    }
  }

  console.log('\n六之二、结算页（用接口另打一局，不然要在网页上点三十次）');
  {
    const post = async (p2, d) => (await fetch(URL + p2, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(d) })).json();
    const r = await post('/api/run', { year: 1930, month: 10, nick: '截图' });
    for (let d = 1; d <= 24; d++) await post('/api/month', { id: r.id, token: r.token, list: '月初去码头等活，塞两角门包，谈按件不按月。月底找同乡合租。' });
    const dp = await ctx.newPage();
    dp.on('pageerror', e => errors.push('结算页：' + String(e.message)));
    await dp.goto(URL, { waitUntil: 'networkidle' });
    await dp.evaluate(([t, i]) => { localStorage.setItem('hy.token', t); localStorage.setItem('hy.run', i); }, [r.token, r.id]);
    await dp.reload({ waitUntil: 'networkidle' });
    await dp.waitForSelector('#s-play.on', { timeout: 15000 });
    const label = (await dp.locator('#send').textContent()).trim();
    check(label === '两年到了，去算账', `走满二十四个月之后按钮写的是「${label}」`);
    await dp.locator('#send').click();
    await dp.waitForSelector('#s-done.on', { timeout: 20000 });
    await dp.waitForTimeout(400);
    const num = (await dp.locator('.score-card .num').textContent()).trim();
    check(/^[−-]?\d/.test(num), `结算页有分数：${num}`);
    const nDays = await dp.locator('details.day').count();
    check(nDays === 24, `结算页能回看 ${nDays} 个月`);
    const actTop = await dp.locator('.done-acts').boundingBox();
    const dayTop = await dp.locator('details.day').first().boundingBox();
    check(actTop && dayTop && actTop.y < dayTop.y, '「再来一局」在二十四个月的列表上面，不会被挤下去');
    await snap(dp, 'f2-结算');
    await dp.locator('details.day').nth(3).click();
    await dp.waitForTimeout(200);
    check((await dp.locator('details.day[open] .daybox p').count()) > 0, '点开某个月能看到那个月的正文');
    /* 收工回顾：折起来的那一行就是那个月的月记，整段读得完，不许被省略号截掉 */
    const 摘要 = await dp.evaluate(() => {
      const d = document.querySelectorAll('details.day')[5];
      const t = d.querySelector('.dt');
      return { 字数: (t.textContent.match(/[\u4e00-\u9fff]/g) || []).length,
               截了: getComputedStyle(t).textOverflow === 'ellipsis' && getComputedStyle(t).whiteSpace === 'nowrap',
               有家底: !!d.querySelector('.dw') };
    });
    check(摘要.字数 > 25, `折起来那一行是那个月的月记（${摘要.字数} 个汉字），不是一行账`);
    check(!摘要.截了, '月记整段读得完，没被省略号截掉');
    check(摘要.有家底, '每个月右边跟着当月收工的家底');
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
  await m.waitForSelector('.flavor', { timeout: 15000 });
  await snap(m, 'h-手机-一年的详情');
  await noHScroll(m, '手机年份详情');
  /* 输入框字号必须 ≥16px，不然 iOS 一聚焦就把整页放大 */
  await m.locator('.mo').nth(5).click();
  const fs16 = await m.evaluate(() => {
    const t = document.querySelector('#nick');
    return t ? parseFloat(getComputedStyle(t).fontSize) : 0;
  });
  check(fs16 >= 16, `手机上输入框字号 ${fs16}px（低于 16 会被 iOS 放大整页）`);
  /* 设定框也要够大——它跟名号框并排在开局那一屏上 */
  const fsP = await m.evaluate(() => {
    const t = document.querySelector('#persona');
    return t ? parseFloat(getComputedStyle(t).fontSize) : 0;
  });
  check(fsP >= 16, `手机上设定框字号 ${fsP}px`);

  /* 手机上真开一局，看左栏那一块：撤了四条杠、添了「他是个什么人」那一行，
     手机版的 grid-template-areas 跟着改过，得看一眼有没有挤版。 */
  await m.locator('#nick').fill('手机');
  await m.locator('#persona').fill('做事踏实，嘴笨，认死理');
  await m.locator('#start').click();
  await m.waitForSelector('#s-play.on', { timeout: 15000 });
  await m.waitForSelector('.bar .cash', { timeout: 10000 });
  await snap(m, 'i-手机-开局');
  await noHScroll(m, '手机开局');
  check(await m.locator('.bar .meter').count() === 3, '手机上那几条杠也在');
  {
    /* 左栏那一行小字不许跟上面的家底叠在一起 */
    const box = await m.evaluate(() => {
      const w = document.querySelector('.bar .who-line'), mo = document.querySelector('.bar .money');
      if (!w || !mo) return null;
      const a = w.getBoundingClientRect(), b = mo.getBoundingClientRect();
      return { 叠了: a.top < b.bottom - 1, 高: Math.round(a.height) };
    });
    check(box && !box.叠了 && box.高 > 0, box ? `他是个什么人那一行在家底下面，高 ${box.高}px` : '手机上找不到那一行');
  }

  console.log('\n八、页面本身');
  check(errors.length === 0, errors.length ? `控制台报错 ${errors.length} 条：${errors[0].slice(0, 90)}` : '没有 JS 报错');
  /* /api/month 是条 SSE 长连接：正文读完、服务端 res.end() 之后，浏览器仍把这条
     请求记成 ERR_ABORTED，Playwright 就报一次 requestfailed。这是流式的正常收尾，
     不是加载失败——在 HEAD 上就一直红着（2026-09-02 拿旧代码跑过一遍确认）。
     只放行「api/month + 中止」这一种组合，别的一律照旧当失败。 */
  const realFail = failed.filter(u => !/favicon/.test(u) && !/\/api\/month .*ERR_ABORTED/.test(u));
  check(realFail.length === 0, realFail.length ? `资源加载失败：${realFail.join(' , ').slice(0, 200)}` : '资源一个不缺');

  await browser.close();
  console.log(`\n截图在 ${OUT}`);
  if (fails.length) { console.log(`\n没过 ${fails.length} 条：\n  ${fails.join('\n  ')}`); process.exit(1); }
  console.log('全过');
})().catch(e => { console.error('跑挂了：', e.message); process.exit(1); });
