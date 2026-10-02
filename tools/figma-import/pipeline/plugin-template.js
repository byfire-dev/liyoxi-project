// 狸有戏原型导入：把原型的布局数据生成为 Figma 原生图层（画框、文本、矢量图标）。
// 运行一次即可。可重复运行：同名画板会先删除再重建。
const DATA = __DATA__;

const SANS = 'Noto Sans SC', SERIF = 'Noto Serif SC';
const FONTS = [[SANS, 'Regular'], [SANS, 'Medium'], [SANS, 'Bold'], [SANS, 'Black'], [SERIF, 'Regular'], [SERIF, 'Medium'], [SERIF, 'SemiBold'], [SERIF, 'Bold'], [SERIF, 'Black']];
const hex = (h) => ({ r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255 });
const alpha = (h) => (h.length > 6 ? parseInt(h.slice(6, 8), 16) / 255 : 1);
const paint = (h) => ({ type: 'SOLID', color: hex(h), opacity: alpha(h) });
const styleOf = (n) => {
  const w = n.fw || 400;
  if (n.sf) return w >= 800 ? 'Black' : w >= 700 ? 'Bold' : w >= 600 ? 'SemiBold' : w >= 500 ? 'Medium' : 'Regular';
  return w >= 800 ? 'Black' : w >= 600 ? 'Bold' : w >= 500 ? 'Medium' : 'Regular';
};
const tick = () => new Promise((r) => setTimeout(r, 0));
const warn = [];

function buildBoard(data, parent) {
  let count = 0;
  const mk = (n, p) => {
    count++;
    if (n.k === 'T') {
      const t = figma.createText();
      t.fontName = { family: n.sf ? SERIF : SANS, style: styleOf(n) };
      t.fontSize = Math.max(1, n.fs);
      t.lineHeight = { unit: 'PIXELS', value: Math.max(1, n.lh) };
      if (n.ls) t.letterSpacing = { unit: 'PIXELS', value: n.ls };
      t.characters = n.t;
      t.fills = [paint(n.c)];
      if (n.ta) t.textAlignHorizontal = n.ta;
      if (n.td) t.textDecoration = n.td;
      p.appendChild(t);
      if (n.tr) { t.resize(Math.max(1, n.w), Math.max(1, n.h)); t.textAutoResize = 'HEIGHT'; t.textTruncation = 'ENDING'; t.maxLines = n.tr; t.x = n.x; }
      else if (n.ml) { t.resize(Math.max(1, n.w), Math.max(1, n.h)); t.textAutoResize = 'HEIGHT'; t.x = n.x; }
      else if (n.an === 'c') t.x = n.x + (n.w - t.width) / 2;
      else if (n.an === 'r') t.x = n.x + n.w - t.width;
      else t.x = n.x;
      t.y = n.y;
      return t;
    }
    if (n.k === 'S') {
      let v;
      try { v = figma.createNodeFromSvg(data.svgs[n.s]); }
      catch (e) { warn.push(data.title + ': 图标 ' + n.s + ' 无法导入'); v = figma.createFrame(); v.fills = []; v.resize(Math.max(1, n.w), Math.max(1, n.h)); }
      v.name = n.n || 'icon';
      p.appendChild(v);
      if (Math.abs(v.width - n.w) > 0.5 || Math.abs(v.height - n.h) > 0.5) { try { v.resize(Math.max(0.5, n.w), Math.max(0.5, n.h)); } catch (e) {} }
      v.x = n.x; v.y = n.y;
      if (n.o != null) v.opacity = n.o;
      return v;
    }
    const f = figma.createFrame();
    f.name = n.n || 'frame';
    f.resize(Math.max(0.01, n.w), Math.max(0.01, n.h));
    const fills = [];
    if (n.bg) fills.push(paint(n.bg));
    if (n.gr) {
      const rad = ((n.gr.a - 90) * Math.PI) / 180, cs = Math.cos(rad), sn = Math.sin(rad);
      fills.push({ type: 'GRADIENT_LINEAR', gradientTransform: [[cs, sn, 0.5 - 0.5 * cs - 0.5 * sn], [-sn, cs, 0.5 + 0.5 * sn - 0.5 * cs]], gradientStops: n.gr.s.map((s) => { const c = hex(s[1]); return { position: Math.max(0, Math.min(1, s[0])), color: { r: c.r, g: c.g, b: c.b, a: alpha(s[1]) } }; }) });
    }
    f.fills = fills;
    f.clipsContent = !!n.cl;
    if (n.r != null) { if (typeof n.r === 'number') f.cornerRadius = n.r; else { f.topLeftRadius = n.r[0]; f.topRightRadius = n.r[1]; f.bottomRightRadius = n.r[2]; f.bottomLeftRadius = n.r[3]; } }
    if (n.bd) {
      f.strokes = [paint(n.bd.c)]; f.strokeAlign = 'INSIDE';
      if (typeof n.bd.w === 'number') f.strokeWeight = n.bd.w;
      else { f.strokeTopWeight = n.bd.w[0]; f.strokeRightWeight = n.bd.w[1]; f.strokeBottomWeight = n.bd.w[2]; f.strokeLeftWeight = n.bd.w[3]; }
      if (n.bd.d) f.dashPattern = [4, 4];
    }
    if (n.sh) f.effects = n.sh.map((s) => { const c = hex(s.c); return { type: s.i ? 'INNER_SHADOW' : 'DROP_SHADOW', color: { r: c.r, g: c.g, b: c.b, a: alpha(s.c) }, offset: { x: s.x, y: s.y }, radius: s.b, spread: s.s, visible: true, blendMode: 'NORMAL' }; });
    if (n.o != null) f.opacity = n.o;
    p.appendChild(f);
    if (n.m) {
      const a = n.m[0], b = n.m[1], c = n.m[2], d = n.m[3];
      const cx = n.x + n.w / 2 + n.m[4], cy = n.y + n.h / 2 + n.m[5];
      try { f.relativeTransform = [[a, c, cx - (a * n.w / 2 + c * n.h / 2)], [b, d, cy - (b * n.w / 2 + d * n.h / 2)]]; } catch (e) { f.x = n.x; f.y = n.y; }
    } else { f.x = n.x; f.y = n.y; }
    if (n.ch) for (const ch of n.ch) mk(ch, f);
    return f;
  };
  const root = mk(data.root, parent);
  root.name = data.title;
  return { root, count };
}

function isDataHolder(node) {
  if (node.type === 'SECTION') return false;
  const ts = node.type === 'TEXT' ? [node] : ('findAllWithCriteria' in node ? node.findAllWithCriteria({ types: ['TEXT'] }) : []);
  return ts.length > 0 && ts[0].characters.indexOf('#lyx|') === 0;
}

async function run() {
  let note = figma.notify('正在加载字体…', { timeout: 60000 });
  for (const f of FONTS) await figma.loadFontAsync({ family: f[0], style: f[1] });
  const summary = [];
  for (const side of DATA.order) {
    const conf = DATA[side];
    let page = figma.root.children.find((p) => p.name === conf.page);
    if (!page) { page = figma.createPage(); page.name = conf.page; }
    await figma.setCurrentPageAsync(page);
    // 1. 清掉此前上传的数据占位层，以及同名的旧画板与旧分区
    const titles = new Set(Object.keys(conf.boards).map((k) => conf.boards[k].title));
    const rowTitles = new Set(conf.rows.map((r) => r.title));
    for (const c of page.children.slice()) {
      if (isDataHolder(c)) { c.remove(); continue; }
      if (c.type === 'FRAME' && titles.has(c.name)) { c.remove(); continue; }
      if (c.type === 'SECTION' && rowTitles.has(c.name)) { c.remove(); continue; }
    }
    // 2. 逐行建分区，逐个生成画板
    const GAP = 100, PAD = 80, TOP = 80;
    let y = 0, done = 0, nodes = 0;
    const total = Object.keys(conf.boards).length;
    for (const row of conf.rows) {
      const sec = figma.createSection();
      sec.name = row.title;
      page.appendChild(sec);
      let x = PAD, maxH = 0;
      for (const name of row.names) {
        const data = conf.boards[name];
        if (!data) continue;
        try {
          const { root, count } = buildBoard(data, sec);
          root.x = x; root.y = TOP;
          x += data.w + GAP; maxH = Math.max(maxH, data.h); nodes += count;
        } catch (e) {
          warn.push(conf.page + ' / ' + data.title + '：' + String((e && e.message) || e).slice(0, 120));
        }
        done++;
        note.cancel();
        note = figma.notify(conf.page + '：' + done + ' / ' + total, { timeout: 60000 });
        await tick();
      }
      sec.resizeWithoutConstraints(Math.max(200, x - GAP + PAD), TOP + maxH + PAD);
      sec.x = 0; sec.y = y;
      y += TOP + maxH + PAD + 240;
    }
    summary.push(conf.page + ' ' + done + ' 个画板、' + nodes + ' 个图层');
    figma.viewport.scrollAndZoomIntoView(page.children);
  }
  note.cancel();
  if (warn.length) console.log('导入提示：\n' + warn.join('\n'));
  figma.closePlugin('导入完成：' + summary.join('；') + (warn.length ? '（有 ' + warn.length + ' 条提示，见控制台）' : ''));
}

run().catch((e) => { console.error(e); figma.closePlugin('导入失败：' + String((e && e.message) || e).slice(0, 160)); });
