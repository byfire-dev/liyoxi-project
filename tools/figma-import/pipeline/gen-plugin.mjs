// Generate the local Figma plugin (manifest.json + code.js) with all artboard data embedded, then smoke-test it against a mock.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const S = '/private/tmp/claude-501/-Users-byfire-ai-repository-liyoxi-project/903dfdee-4da3-42d9-99b9-d88965ea41ce/scratchpad';
const OUT = '/Users/byfire.ai/repository/liyoxi-project/tools/figma-import';
mkdirSync(OUT, { recursive: true });
const plan = JSON.parse(readFileSync(`${S}/figma/plan.json`, 'utf8'));
const PAGES = { merchant: '商家端小程序', admin: '运营管理后台' };
const DATA = { order: ['merchant', 'admin'] };
for (const side of DATA.order) {
  const boards = {};
  for (const row of plan[side].rows) for (const n of row.names) {
    const d = JSON.parse(readFileSync(`${S}/figma/out/${side}/${n}.json`, 'utf8'));
    delete d.stats; delete d.name;
    boards[n] = d;
  }
  DATA[side] = { page: PAGES[side], rows: plan[side].rows.map((r) => ({ title: r.title, names: r.names })), boards };
}
const tpl = readFileSync(`${S}/figma/plugin-template.js`, 'utf8');
const code = tpl.replace('__DATA__', () => JSON.stringify(DATA));
writeFileSync(`${OUT}/code.js`, code);
writeFileSync(`${OUT}/manifest.json`, JSON.stringify({ name: '狸有戏原型导入', id: 'lyx-prototype-import-20261002', api: '1.0.0', main: 'code.js', editorType: ['figma'], documentAccess: 'dynamic-page', networkAccess: { allowedDomains: ['none'] } }, null, 2) + '\n');
console.log('code.js', Math.round(code.length / 1024), 'KB', 'boards', DATA.order.map((s) => Object.keys(DATA[s].boards).length).join('+'));

// ---------- smoke test against a mock of the Plugin API ----------
let created = { FRAME: 0, TEXT: 0, SECTION: 0, SVG: 0 };
class Node {
  constructor(type) { this.type = type; this.children = []; this.name = ''; this.x = 0; this.y = 0; this.width = 100; this.height = 100; this.parent = null; this.characters = ''; }
  appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((k) => k !== c); c.parent = this; this.children.push(c); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((k) => k !== this); this.removed = true; }
  resize(w, h) { if (!(w > 0 && h > 0)) throw new Error('bad size'); this.width = w; this.height = h; }
  resizeWithoutConstraints(w, h) { this.resize(w, h); }
  findAllWithCriteria({ types }) { const out = []; const walk = (n) => { for (const c of n.children) { if (types.includes(c.type)) out.push(c); walk(c); } }; walk(this); return out; }
  set relativeTransform(m) { if (!Array.isArray(m) || m.length !== 2 || m[0].length !== 3 || m.flat().some((v) => typeof v !== 'number' || Number.isNaN(v))) throw new Error('bad transform'); this._rt = m; }
  set fills(v) { for (const p of v) { if (p.type === 'SOLID' && ['r', 'g', 'b'].some((k) => !(p.color[k] >= 0 && p.color[k] <= 1))) throw new Error('bad color'); if (p.type === 'SOLID' && 'a' in p.color) throw new Error('alpha in color'); } this._fills = v; }
  set fontName(v) { if (!FONT_OK.has(v.family + '/' + v.style)) throw new Error('font not loaded ' + v.family + ' ' + v.style); this._font = v; }
  set characters2(v) {}
}
const FONT_OK = new Set();
const pages = [Object.assign(new Node('PAGE'), { name: '商家端小程序' }), Object.assign(new Node('PAGE'), { name: '运营管理后台' })];
// simulate leftovers: a data holder and an old frame on the merchant page
const holder = new Node('FRAME'); holder.name = 'lyx-data-merchant-00.svg'; const ht = new Node('TEXT'); ht.characters = '#lyx|d|Main|0|1|AAAA'; holder.appendChild(ht); pages[0].appendChild(holder);
const old = new Node('FRAME'); old.name = 'M02 首页'; pages[0].appendChild(old);
let closed = null; const notes = [];
globalThis.figma = {
  root: { children: pages }, currentPage: pages[0],
  createFrame() { created.FRAME++; return new Node('FRAME'); },
  createText() { created.TEXT++; const t = new Node('TEXT'); t.width = 10; return t; },
  createSection() { created.SECTION++; return new Node('SECTION'); },
  createPage() { const p = new Node('PAGE'); pages.push(p); return p; },
  createNodeFromSvg(s) { if (!/^<svg[\s>]/.test(s) || !/<\/svg>$/.test(s)) throw new Error('bad svg'); created.SVG++; const n = new Node('FRAME'); const m = s.match(/width="([\d.]+)" height="([\d.]+)"/) || s.match(/width="([\d.]+)"/); if (m) { n.width = +m[1]; n.height = +(m[2] || m[1]); } return n; },
  async loadFontAsync(f) { FONT_OK.add(f.family + '/' + f.style); },
  async setCurrentPageAsync(p) { this.currentPage = p; },
  notify(msg) { notes.push(msg); return { cancel() {} }; },
  viewport: { scrollAndZoomIntoView() {} },
  closePlugin(msg) { closed = msg; },
};
await import(`${OUT}/code.js?t=${Date.now()}`).catch((e) => { console.error('IMPORT ERROR', e); });
await new Promise((r) => setTimeout(r, 4000));
for (let i = 0; i < 100 && closed == null; i++) await new Promise((r) => setTimeout(r, 300));
console.log('closed:', closed);
console.log('created', JSON.stringify(created));
console.log('page children', pages.map((p) => p.name + ': ' + p.children.map((c) => c.type + '(' + c.children.length + ')').join(' ')).join(' | '));
console.log('leftover holder removed:', holder.removed === true, 'old frame removed:', old.removed === true);
