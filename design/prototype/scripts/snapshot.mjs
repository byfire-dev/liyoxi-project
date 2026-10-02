// 把原型画板渲染成截图（长页面完整展开）。
// 用法：node design/prototype/scripts/snapshot.mjs <运行时 dc-runtime.js 的路径> [merchant|admin] [画板名 ...]
// 运行时不随仓库保存：它是原型画板自带的 artifact-type/dc-runtime.js，从在线原型取得后放到本机任意位置即可。
// 依赖：本机安装的 Google Chrome、Node 22 及以上。
import { launch } from './cdp.mjs';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [runtime, onlySide, ...only] = process.argv.slice(2);
if (!runtime) { console.error('缺少运行时路径'); process.exit(1); }
const SCALE = { merchant: 2, admin: 1 };

const PREPARE = async function (cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let root = null;
  for (let i = 0; i < 120; i++) {
    root = [...document.querySelectorAll('body div')].find((d) => /width:\s*\d+px/.test(d.getAttribute('style') || '') && d.getBoundingClientRect().width >= cfg.w - 1);
    if (root && root.children.length) break;
    await sleep(100);
  }
  if (!root) throw new Error('root not found');
  await document.fonts.ready;
  await sleep(500);
  const all = [root, ...root.querySelectorAll('*')];
  let H = Math.max(cfg.h, Math.ceil(root.getBoundingClientRect().height));
  if (/height:\s*\d+px/.test(root.getAttribute('style') || '')) {
    for (let i = 0; i < 8; i++) {
      const sc = all.filter((e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight - e.clientHeight > 1; });
      if (!sc.length) break;
      sc.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
      const before = sc[0].scrollHeight - sc[0].clientHeight;
      root.style.height = (H + Math.ceil(before)) + 'px';
      await sleep(60);
      if (sc[0].scrollHeight - sc[0].clientHeight >= before - 1) { root.style.height = H + 'px'; break; }
      H += Math.ceil(before);
    }
  }
  for (const e of all) e.scrollTop = 0;
  await sleep(80);
  return H;
};

const browser = await launch();
try {
  for (const side of ['merchant', 'admin']) {
    if (onlySide && onlySide !== side) continue;
    const src = join(ROOT, side, 'src');
    const out = join(ROOT, side, 'screens');
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(tmpdir(), 'lyx-proto-'));
    for (const f of readdirSync(src)) copyFileSync(join(src, f), join(work, f));
    copyFileSync(runtime, join(work, 'support.js'));
    const canvas = JSON.parse(readFileSync(join(src, 'canvas.json'), 'utf8'));
    for (const key of Object.keys(canvas.boards)) {
      const name = key.replace('.dc.html', '');
      if (only.length && !only.includes(name)) continue;
      const b = canvas.boards[key];
      try {
        const page = await browser.openPage(`file://${work}/${key}`, b.w, b.h);
        const H = await page.evaluate(`(${PREPARE.toString()})(${JSON.stringify({ w: b.w, h: b.h })})`);
        const img = await page.screenshot(b.w, H, SCALE[side], 'webp', 82);
        writeFileSync(join(out, `${name}.webp`), img);
        await page.close();
        console.log(side, name, `${b.w}x${H}`, Math.round(img.length / 1024) + 'KB');
      } catch (e) { console.log(side, name, 'ERROR', String(e.message || e).slice(0, 160)); }
    }
  }
} finally { await browser.quit(); }
