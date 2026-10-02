// 极简的 Chrome DevTools Protocol 驱动（无依赖；Node 22 起自带 WebSocket）
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export async function launch(port = 9377) {
  const profile = mkdtempSync(join(tmpdir(), 'lyx-chrome-'));
  const proc = spawn(CHROME, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', '--no-first-run',
    '--no-default-browser-check', '--force-device-scale-factor=1', 'about:blank',
  ], { stdio: 'ignore' });
  let ver;
  for (let i = 0; i < 100; i++) {
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); break; } catch { await new Promise(r => setTimeout(r, 100)); }
  }
  if (!ver) { proc.kill('SIGKILL'); throw new Error('chrome did not start'); }
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pending = new Map(); const listeners = new Set();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else for (const l of listeners) l(m);
  };
  const send = (method, params = {}, sessionId) => new Promise((res, rej) => {
    const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  const waitEvent = (method, sessionId, timeout = 20000) => new Promise((res, rej) => {
    const t = setTimeout(() => { listeners.delete(l); rej(new Error('timeout ' + method)); }, timeout);
    const l = (m) => { if (m.method === method && (!sessionId || m.sessionId === sessionId)) { clearTimeout(t); listeners.delete(l); res(m.params); } };
    listeners.add(l);
  });
  async function openPage(url, width, height) {
    const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true });
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, sessionId);
    const loaded = waitEvent('Page.loadEventFired', sessionId, 30000);
    await send('Page.navigate', { url }, sessionId);
    await loaded;
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error('page error: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
      return r.result.value;
    };
    const screenshot = async (w, h, scale = 2, format = 'png', quality) => {
      await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false }, sessionId);
      await new Promise(r => setTimeout(r, 150));
      const { data } = await send('Page.captureScreenshot', { format, ...(quality ? { quality } : {}), clip: { x: 0, y: 0, width: w, height: h, scale: 1 } }, sessionId);
      return Buffer.from(data, 'base64');
    };
    const setSize = (w, h) => send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false }, sessionId);
    const close = () => send('Target.closeTarget', { targetId });
    return { evaluate, screenshot, setSize, close };
  }
  const quit = async () => { try { await send('Browser.close'); } catch {} try { ws.close(); } catch {} setTimeout(() => proc.kill('SIGKILL'), 500); };
  return { openPage, quit };
}
