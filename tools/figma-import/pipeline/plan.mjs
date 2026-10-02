// Build the upload plan: rows (sections) from canvas.json, batches of artboards, and packed SVG files.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const S = '/private/tmp/claude-501/-Users-byfire-ai-repository-liyoxi-project/903dfdee-4da3-42d9-99b9-d88965ea41ce/scratchpad';
const BATCH = +(process.argv[2] || 8);
mkdirSync(`${S}/figma/up`, { recursive: true });
const plan = {};
for (const side of ['merchant', 'admin']) {
  const canvas = JSON.parse(readFileSync(`${S}/src/${side}/project/canvas.json`, 'utf8'));
  const boards = Object.entries(canvas.boards).map(([k, v]) => ({ name: k.replace('.dc.html', ''), ...v }));
  const notes = Object.values(canvas.notes || {}).filter((n) => n.kind === 'title1');
  const ys = [...new Set(boards.map((b) => b.y))].sort((a, b) => a - b);
  const rows = ys.map((y) => {
    const note = notes.slice().sort((a, b) => Math.abs(a.y - (y - 300)) - Math.abs(b.y - (y - 300)))[0];
    const bs = boards.filter((b) => b.y === y).sort((a, b) => a.x - b.x).filter((b) => existsSync(`${S}/figma/out/${side}/${b.name}.json`));
    return { title: note ? note.text : `row ${y}`, names: bs.map((b) => b.name), titles: bs.map((b) => b.title || b.name) };
  });
  const order = rows.flatMap((r) => r.names);
  const batches = [];
  for (let i = 0; i < order.length; i += BATCH) batches.push(order.slice(i, i + BATCH));
  const files = batches.map((bt, i) => {
    const f = `${S}/figma/up/${side}-${String(i).padStart(2, '0')}.svg`;
    const args = [`${S}/figma/pack.mjs`, f, ...(i === 0 ? ['--builder'] : []), ...bt.map((n) => `${side}:${n}`)];
    const o = execFileSync('node', args).toString().trim();
    return { file: f, bytes: +o.split('bytes ')[1], names: bt };
  });
  plan[side] = { rows, batches, files, missing: boards.filter((b) => !existsSync(`${S}/figma/out/${side}/${b.name}.json`)).map((b) => b.name) };
}
writeFileSync(`${S}/figma/plan.json`, JSON.stringify(plan, null, 1));
for (const side of ['merchant', 'admin']) {
  console.log(side, 'rows', plan[side].rows.map((r) => `${r.title}(${r.names.length})`).join(' | '));
  console.log(side, 'files', plan[side].files.map((f) => `${f.names.length}:${Math.round(f.bytes / 1024)}KB`).join(' '), 'missing', plan[side].missing.join(','));
}
