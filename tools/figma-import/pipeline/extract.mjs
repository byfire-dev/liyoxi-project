// Render each prototype artboard in headless Chrome and extract a layout tree as JSON.
// Usage: node extract.mjs <merchant|admin> [Name1 Name2 ...]
import { launch } from './cdp.mjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const S = '/private/tmp/claude-501/-Users-byfire-ai-repository-liyoxi-project/903dfdee-4da3-42d9-99b9-d88965ea41ce/scratchpad';
const side = process.argv[2];
const only = process.argv.slice(3);
const canvas = JSON.parse(readFileSync(`${S}/src/${side}/project/canvas.json`, 'utf8'));
const OUT = `${S}/figma/out/${side}`;
mkdirSync(OUT, { recursive: true });

// ---------- runs inside the page ----------
const PHASE1 = async function (cfg) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let root = null;
  for (let i = 0; i < 120; i++) {
    root = [...document.querySelectorAll('body div')].find((d) => /width:\s*\d+px/.test(d.getAttribute('style') || '') && d.getBoundingClientRect().width >= cfg.w - 1);
    if (root && root.children.length) break;
    await sleep(100);
  }
  if (!root) throw new Error('root not found');
  await sleep(400);
  window.__root = root;
  const all = [root, ...root.querySelectorAll('*')];
  for (const e of all) if (/Noto Serif/i.test(getComputedStyle(e).fontFamily)) e.setAttribute('data-serif', '1');
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Noto+Sans+SC:wght@400;500;700;900&family=Noto+Serif+SC:wght@400;500;600;700;900&display=block';
  await new Promise((r) => { link.onload = r; link.onerror = r; document.head.appendChild(link); setTimeout(r, 12000); });
  const st = document.createElement('style');
  st.textContent = "*:not([data-serif]){font-family:'Noto Sans SC',sans-serif !important}[data-serif]{font-family:'Noto Serif SC',serif !important}";
  document.head.appendChild(st);
  let txt = document.body.innerText + ' 0123456789';
  for (const i of document.querySelectorAll('input,textarea')) txt += (i.value || '') + (i.placeholder || '');
  const loads = [];
  for (const w of ['400', '500', '700', '900']) loads.push(document.fonts.load(`${w} 16px "Noto Sans SC"`, txt).catch(() => null));
  for (const w of ['400', '500', '600', '700', '900']) loads.push(document.fonts.load(`${w} 16px "Noto Serif SC"`, txt).catch(() => null));
  await Promise.race([Promise.all(loads), sleep(25000)]);
  await document.fonts.ready;
  await sleep(250);
  const sample = (document.body.innerText || '').replace(/\s+/g, '').slice(0, 40) || '狸有戏';
  const fontOk = document.fonts.check('400 16px "Noto Sans SC"', sample) && document.fonts.check('700 16px "Noto Sans SC"', sample);
  // expand scrollable regions so that nothing is hidden below the fold
  let H = Math.max(cfg.h, Math.ceil(root.getBoundingClientRect().height));
  const fixedH = /height:\s*\d+px/.test(root.getAttribute('style') || '');
  for (let i = 0; i < 8 && fixedH; i++) {
    const sc = all.filter((e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowY) && e.scrollHeight - e.clientHeight > 1; });
    if (!sc.length) break;
    sc.sort((a, b) => (b.scrollHeight - b.clientHeight) - (a.scrollHeight - a.clientHeight));
    const top = sc[0];
    const before = top.scrollHeight - top.clientHeight;
    root.style.height = (H + Math.ceil(before)) + 'px';
    await sleep(60);
    const after = top.scrollHeight - top.clientHeight;
    if (after >= before - 1) { root.style.height = H + 'px'; top.setAttribute('data-noexpand', '1'); break; }
    H += Math.ceil(before);
  }
  for (const e of all) e.scrollTop = 0;
  await sleep(60);
  return { H, fontOk, n: all.length };
};

const PHASE2 = async function (cfg) {
  const root = window.__root;
  const R = (n) => Math.round(n * 100) / 100;
  const hx = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  const color = (c) => {
    if (!c || c === 'transparent') return null;
    let m = c.match(/^rgba?\(([^)]+)\)$/);
    let p, a = 1;
    if (m) { p = m[1].split(/[,\/\s]+/).filter(Boolean).map(parseFloat); if (p.length > 3) a = p[3]; }
    else if ((m = c.match(/^color\(srgb ([^)]+)\)$/))) { p = m[1].split(/[\/\s]+/).filter(Boolean).map(parseFloat); if (p.length > 3) a = p[3]; p = p.slice(0, 3).map((v) => v * 255); }
    else return null;
    if (a <= 0.003) return null;
    return hx(p[0]) + hx(p[1]) + hx(p[2]) + (a < 0.997 ? hx(a * 255) : '');
  };
  // neutralise non-translation transforms so layout rects are measured unrotated
  const mats = new Map();
  for (const e of [root, ...root.querySelectorAll('*')]) {
    const t = getComputedStyle(e).transform;
    if (!t || t === 'none') continue;
    const m = t.match(/^matrix\(([^)]+)\)$/);
    if (!m) continue;
    const v = m[1].split(',').map(parseFloat);
    if (Math.abs(v[0] - 1) < 1e-4 && Math.abs(v[3] - 1) < 1e-4 && Math.abs(v[1]) < 1e-4 && Math.abs(v[2]) < 1e-4) continue;
    mats.set(e, v);
    e.style.transform = 'none';
  }
  const svgs = []; const svgIdx = new Map();
  const stats = { f: 0, t: 0, s: 0 };
  const NAMES = { header: '顶栏', nav: '导航', main: '内容区', footer: '底栏', section: '分区', article: '卡片', aside: '侧栏', button: '按钮', a: '链接', ul: '列表', ol: '列表', li: '列表项', table: '表格', thead: '表头', tbody: '表体', tr: '行', th: '表头格', td: '单元格', h1: '标题', h2: '标题', h3: '标题', h4: '标题', p: '段落', label: '标签', input: '输入框', textarea: '多行输入', select: '下拉框', form: '表单', dl: '指标组', dt: '指标名', dd: '指标值', span: '文本', div: '容器', figure: '图', figcaption: '图注' };
  const SNIP = new Set(['button', 'a', 'h1', 'h2', 'h3', 'h4', 'p', 'li', 'th', 'td', 'label', 'dt', 'dd']);
  const px = (v) => parseFloat(v) || 0;

  function gradient(bi) {
    const m = bi.match(/^linear-gradient\((.*)\)$/s);
    if (!m) return null;
    const parts = []; let depth = 0, cur = '';
    for (const ch of m[1]) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; }
    parts.push(cur.trim());
    let ang = 180;
    if (/deg$/.test(parts[0])) ang = parseFloat(parts.shift());
    else if (/^to /.test(parts[0])) { const d = parts.shift(); ang = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to bottom right': 135, 'to bottom left': 225, 'to top left': 315 }[d] ?? 180; }
    const stops = parts.map((p) => { const mm = p.match(/^(rgba?\([^)]+\)|color\([^)]+\))\s*([\d.]+%)?/); return mm ? [mm[2] ? parseFloat(mm[2]) / 100 : null, color(mm[1]) || '00000000'] : null; }).filter(Boolean);
    if (stops.length < 2) return null;
    stops.forEach((s, i) => { if (s[0] == null) s[0] = i / (stops.length - 1); });
    return { a: ang, s: stops };
  }
  function shadows(bs) {
    if (!bs || bs === 'none') return null;
    const parts = []; let depth = 0, cur = '';
    for (const ch of bs) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; } else cur += ch; }
    parts.push(cur.trim());
    const out = [];
    for (const p of parts) {
      const cm = p.match(/(rgba?\([^)]+\)|color\([^)]+\))/); if (!cm) continue;
      const c = color(cm[1]); if (!c) continue;
      const nums = p.replace(cm[1], '').replace('inset', '').trim().split(/\s+/).map(parseFloat);
      out.push({ x: nums[0] || 0, y: nums[1] || 0, b: nums[2] || 0, s: nums[3] || 0, c, ...( /inset/.test(p) ? { i: 1 } : {}) });
    }
    return out.length ? out.slice(0, 3) : null;
  }

  function textRun(tn, el, cs, er) {
    const raw = tn.nodeValue;
    if (!raw || !raw.trim()) return null;
    const range = document.createRange(); range.selectNodeContents(tn);
    if (!/pre/.test(cs.whiteSpace)) {
      // measure only the visible characters so that trimmed leading/trailing spaces do not shift the run
      const lead = raw.match(/^\s*/)[0].length, trail = raw.match(/\s*$/)[0].length;
      range.setStart(tn, lead); range.setEnd(tn, raw.length - trail);
    }
    const rects = [...range.getClientRects()].filter((q) => q.width > 0.05 && q.height > 0.05);
    if (!rects.length) return null;
    if (/vertical/.test(cs.writingMode)) {
      // Figma has no vertical writing mode: one character per line, centred in a column
      const vchars = raw.replace(/\s+/g, '').split('');
      const l = Math.min(...rects.map((q) => q.left)), r2 = Math.max(...rects.map((q) => q.right)), t = Math.min(...rects.map((q) => q.top)), b2 = Math.max(...rects.map((q) => q.bottom));
      const fsv = px(cs.fontSize); const adv = (b2 - t) / Math.max(1, vchars.length);
      const vn = { k: 'T', x: R((l + r2) / 2 - fsv / 2 - er.left), y: R(t - er.top), w: R(fsv), h: R(b2 - t), t: vchars.join('\n'), fs: R(fsv), lh: R(adv), ta: 'CENTER', c: color(cs.color) || '000000' };
      const vfw = parseInt(cs.fontWeight, 10) || 400; if (vfw !== 400) vn.fw = vfw;
      if (el.closest('[data-serif]')) vn.sf = 1;
      vn.ml = 1;
      stats.t++;
      return vn;
    }
    const lines = [];
    for (const q of rects) { const L = lines.find((l) => Math.abs(l.top - q.top) < 3); if (L) { L.left = Math.min(L.left, q.left); L.right = Math.max(L.right, q.right); } else lines.push({ top: q.top, bottom: q.bottom, left: q.left, right: q.right }); }
    const pre = /pre/.test(cs.whiteSpace);
    let chars = pre ? raw.replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').trim() : raw.replace(/\s+/g, ' ').trim();
    if (cs.textTransform === 'uppercase') chars = chars.toUpperCase();
    const fs = px(cs.fontSize);
    const lh = px(cs.lineHeight) || (lines[0].bottom - lines[0].top);
    const padL = px(cs.paddingLeft) + px(cs.borderLeftWidth), padR = px(cs.paddingRight) + px(cs.borderRightWidth);
    const cw = er.width - padL - padR;
    const left = Math.min(...lines.map((l) => l.left)), right = Math.max(...lines.map((l) => l.right));
    const cy = (lines[0].top + lines[0].bottom) / 2;
    const fw = parseInt(cs.fontWeight, 10) || 400;
    const n = { k: 'T', x: R(left - er.left), y: R(cy - lh / 2 - er.top), w: R(right - left), h: R(lh * lines.length), t: chars, fs: R(fs), lh: R(lh) };
    if (fw !== 400) n.fw = fw;
    if (el.closest('[data-serif]')) n.sf = 1;
    n.c = color(cs.color) || '000000';
    const ls = px(cs.letterSpacing); if (ls) n.ls = R(ls);
    const ta = cs.textAlign; if (ta === 'center') n.ta = 'CENTER'; else if (ta === 'right' || ta === 'end') n.ta = 'RIGHT';
    if (/underline/.test(cs.textDecorationLine)) n.td = 'UNDERLINE'; else if (/line-through/.test(cs.textDecorationLine)) n.td = 'STRIKETHROUGH';
    const only = [...el.childNodes].filter((c) => c.nodeType === 1 || (c.nodeType === 3 && c.nodeValue.trim())).length === 1;
    const ell = cs.textOverflow === 'ellipsis' && cs.overflow !== 'visible';
    const clamp = parseInt(cs.webkitLineClamp, 10) || 0;
    if (ell || clamp) {
      n.tr = clamp || 1; n.x = R(padL); n.w = R(cw);
      n.h = R(lh * Math.min(lines.length, n.tr));
    } else if (lines.length > 1) {
      n.ml = 1;
      if (only && cw > 0) { n.x = R(padL); n.w = R(cw); } else n.w = R(right - left + 1);
    } else {
      // anchor of a single-line run inside its parent content box
      const gl = left - (er.left + padL), gr = (er.right - padR) - right;
      if (Math.abs(gl - gr) < 1.2 && gl > 0.5) n.an = 'c'; else if (gr < 1.2 && gl > 2) n.an = 'r';
    }
    stats.t++;
    return n;
  }

  function build(el, pr) {
    const tag = el.tagName.toLowerCase();
    if (['script', 'style', 'link', 'template', 'noscript'].includes(tag)) return [];
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return [];
    if (cs.display === 'contents') return [...el.children].flatMap((c) => build(c, pr));
    const er = el.getBoundingClientRect();
    const op = parseFloat(cs.opacity);
    if (op <= 0.01) return [];
    const base = { x: R(er.left - pr.left), y: R(er.top - pr.top), w: R(er.width), h: R(er.height) };
    if (tag === 'svg') {
      if (er.width < 0.5 || er.height < 0.5) return [];
      const clone = el.cloneNode(true);
      for (const a of ['style', 'class', 'aria-hidden', 'role', 'focusable']) clone.removeAttribute(a);
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', `0 0 ${px(el.getAttribute('width')) || R(er.width)} ${px(el.getAttribute('height')) || R(er.height)}`);
      clone.setAttribute('width', R(er.width)); clone.setAttribute('height', R(er.height));
      const cc = '#' + (color(cs.color) || '000000').slice(0, 6);
      let s = clone.outerHTML.replace(/currentColor/gi, cc).replace(/\s+/g, ' ').replace(/> </g, '><');
      if (!/fill=|stroke=/.test(s.slice(0, s.indexOf('>')))) { const f = cs.fill && cs.fill !== 'none' ? color(cs.fill) : null; if (f && f !== '000000') s = s.replace('<svg ', `<svg fill="#${f.slice(0, 6)}" `); }
      let i = svgIdx.get(s); if (i == null) { i = svgs.length; svgs.push(s); svgIdx.set(s, i); }
      stats.s++;
      const n = { k: 'S', ...base, s: i }; if (op < 0.99) n.o = R(op);
      const lab = el.getAttribute('aria-label'); if (lab) n.n = lab.slice(0, 24);
      return [n];
    }
    const node = { k: 'F', ...base };
    const lab = el.getAttribute('aria-label');
    let name = lab || NAMES[tag] || tag;
    if (!lab && SNIP.has(tag)) { const t = (el.innerText || '').replace(/\s+/g, ' ').trim(); if (t) name += '/' + t.slice(0, 12); }
    node.n = name.slice(0, 28);
    let visual = false;
    const bg = color(cs.backgroundColor); if (bg) { node.bg = bg; visual = true; }
    if (cs.backgroundImage && cs.backgroundImage !== 'none') { const g = gradient(cs.backgroundImage); if (g) { node.gr = g; visual = true; } }
    const bw = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
    const bst = [cs.borderTopStyle, cs.borderRightStyle, cs.borderBottomStyle, cs.borderLeftStyle];
    const bcs = [cs.borderTopColor, cs.borderRightColor, cs.borderBottomColor, cs.borderLeftColor];
    for (let i = 0; i < 4; i++) if (bst[i] === 'none' || bst[i] === 'hidden' || !color(bcs[i])) bw[i] = 0;
    if (bw.some((v) => v > 0)) { const i = bw.findIndex((v) => v > 0); node.bd = { w: bw.every((v) => v === bw[0]) ? R(bw[0]) : bw.map(R), c: color(bcs[i]) }; if (bst[i] === 'dashed' || bst[i] === 'dotted') node.bd.d = 1; visual = true; }
    const rad = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map((v) => { const first = v.split(' ')[0]; return /%$/.test(first) ? (parseFloat(first) / 100) * Math.min(er.width, er.height) : px(first); }).map((v) => R(Math.min(v, Math.min(er.width, er.height) / 2)));
    if (rad.some((v) => v > 0)) node.r = rad.every((v) => v === rad[0]) ? rad[0] : rad;
    const sh = shadows(cs.boxShadow); if (sh) { node.sh = sh; visual = true; }
    if (op < 0.99) node.o = R(op);
    if (/(hidden|auto|scroll|clip)/.test(cs.overflowX + cs.overflowY)) node.cl = 1;
    if (mats.has(el)) { const v = mats.get(el); node.m = v.map((q) => Math.round(q * 1e5) / 1e5); }
    if (/flex/.test(cs.display)) {
      node.fx = { d: /column/.test(cs.flexDirection) ? 'V' : 'H', g: R(px(/column/.test(cs.flexDirection) ? cs.rowGap : cs.columnGap)), p: [px(cs.paddingTop) + bw[0], px(cs.paddingRight) + bw[1], px(cs.paddingBottom) + bw[2], px(cs.paddingLeft) + bw[3]].map(R), j: cs.justifyContent, a: cs.alignItems };
      if (cs.flexWrap !== 'nowrap') node.fx.w = 1;
      if (/reverse/.test(cs.flexDirection)) node.fx.rv = 1;
    }
    if (cs.position === 'absolute' || cs.position === 'fixed') node.ab = 1;
    if (px(cs.flexGrow) > 0) node.fg = 1;
    if (cs.alignSelf && cs.alignSelf !== 'auto' && cs.alignSelf !== 'normal') node.as = cs.alignSelf;

    const kids = [];
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      const val = tag === 'select' ? ((el.selectedOptions[0] || {}).textContent || '') : (el.value || el.placeholder || '');
      const isPh = tag !== 'select' && !el.value;
      const type = el.getAttribute('type');
      if (val && type !== 'checkbox' && type !== 'radio' && type !== 'range' && type !== 'file') {
        const pc = isPh ? getComputedStyle(el, '::placeholder').color : cs.color;
        const fs = px(cs.fontSize); const lh = px(cs.lineHeight) || fs * 1.45;
        const padL = px(cs.paddingLeft) + bw[3], padT = px(cs.paddingTop) + bw[0], padR = px(cs.paddingRight) + bw[1];
        const t = { k: 'T', x: R(padL), y: R(tag === 'textarea' ? padT : (er.height - lh) / 2), w: R(er.width - padL - padR), h: R(lh), t: val.replace(/\s+/g, ' ').trim(), fs: R(fs), lh: R(lh), c: color(pc) || '999999' };
        const fw = parseInt(cs.fontWeight, 10) || 400; if (fw !== 400) t.fw = fw;
        if (tag === 'textarea') t.ml = 1; else t.tr = 1;
        kids.push([0, t]); stats.t++;
      }
      visual = true;
    } else if (tag === 'img' || tag === 'video' || tag === 'canvas') {
      if (!node.bg) node.bg = tag === 'video' ? '1d1a16' : 'e5e0d8';
      visual = true;
    } else {
      let order = 0;
      for (const c of el.childNodes) {
        if (c.nodeType === 3) { const t = textRun(c, el, cs, er); if (t) kids.push([0, t]); }
        else if (c.nodeType === 1) {
          const ccs = getComputedStyle(c);
          let z = 0; if (ccs.position !== 'static') { const zi = parseInt(ccs.zIndex, 10); z = isNaN(zi) ? 0.5 : zi; }
          for (const b of build(c, er)) kids.push([z, b]);
        }
        order++;
      }
    }
    kids.sort((a, b) => a[0] - b[0]);
    if (kids.length) node.ch = kids.map((k) => k[1]);
    if (!visual && !kids.length) return [];
    if (er.width < 0.05 && er.height < 0.05 && !kids.length) return [];
    stats.f++;
    return [node];
  }
  const rr = root.getBoundingClientRect();
  const out = build(root, rr)[0];
  out.x = 0; out.y = 0; out.cl = 1;
  if (!out.bg) out.bg = color(getComputedStyle(document.body).backgroundColor) || 'ffffff';
  return { name: cfg.name, title: cfg.title, w: R(rr.width), h: R(rr.height), svgs, root: out, stats };
};

// ---------- driver ----------
const b = await launch();
const summary = [];
try {
  const names = Object.keys(canvas.boards).map((k) => k.replace('.dc.html', '')).filter((n) => !only.length || only.includes(n));
  for (const name of names) {
    const board = canvas.boards[name + '.dc.html'];
    const t0 = Date.now();
    try {
      const p = await b.openPage(`file://${S}/src/${side}/project/${name}.dc.html`, board.w, board.h);
      const cfg = { name, title: board.title || name, w: board.w, h: board.h };
      const p1 = await p.evaluate(`(${PHASE1.toString()})(${JSON.stringify(cfg)})`);
      const png = await p.screenshot(board.w, p1.H, 1);
      writeFileSync(`${OUT}/${name}.png`, png);
      await p.setSize(board.w, p1.H);
      const data = await p.evaluate(`(${PHASE2.toString()})(${JSON.stringify(cfg)})`);
      const json = JSON.stringify(data);
      writeFileSync(`${OUT}/${name}.json`, json);
      summary.push({ name, title: cfg.title, w: data.w, h: data.h, bytes: json.length, ...data.stats, svgs: data.svgs.length, fontOk: p1.fontOk, ms: Date.now() - t0 });
      await p.close();
    } catch (e) {
      summary.push({ name, error: String(e.message || e).slice(0, 200) });
    }
  }
} finally { await b.quit(); }
writeFileSync(`${OUT}/_summary.json`, JSON.stringify(summary, null, 1));
for (const s of summary) console.log(JSON.stringify(s));
