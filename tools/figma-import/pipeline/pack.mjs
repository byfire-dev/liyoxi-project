// Pack artboard JSON (and optionally the builder code) into an SVG whose <text> elements carry base64 chunks.
// Usage: node pack.mjs <out.svg> [--builder] <side>:<Name> ...
import { readFileSync, writeFileSync } from 'node:fs';
const S = '/private/tmp/claude-501/-Users-byfire-ai-repository-liyoxi-project/903dfdee-4da3-42d9-99b9-d88965ea41ce/scratchpad';
const [outFile, ...rest] = process.argv.slice(2);
const CHUNK = 20000;
const ascii = (s) => s.replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
const texts = [];
const add = (kind, name, payload) => {
  const b64 = Buffer.from(payload, 'latin1').toString('base64');
  const total = Math.ceil(b64.length / CHUNK);
  for (let i = 0; i < total; i++) texts.push(`#lyx|${kind}|${name}|${i}|${total}|` + b64.slice(i * CHUNK, (i + 1) * CHUNK));
};
for (const a of rest) {
  if (a === '--builder') {
    const code = readFileSync(`${S}/figma/builder.js`, 'utf8');
    if (/[^\x00-\x7f]/.test(code)) throw new Error('builder must be ASCII');
    add('b', 'builder', code);
  } else {
    const [side, name] = a.split(':');
    add('d', name, ascii(readFileSync(`${S}/figma/out/${side}/${name}.json`, 'utf8')));
  }
}
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="${texts.length * 6 + 10}" viewBox="0 0 400 ${texts.length * 6 + 10}">` +
  texts.map((t, i) => `<text x="0" y="${(i + 1) * 6}" font-size="4" font-family="Inter" fill="#999999">${t}</text>`).join('') + '</svg>';
writeFileSync(outFile, svg);
console.log(outFile, 'texts', texts.length, 'bytes', svg.length);
