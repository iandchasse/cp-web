// Tests the coi-serviceworker.js isolation fallback on a header-less subpath deploy.
// Navigates once, then polls state across the SW-triggered auto-reload until the
// firmware boots (or times out). Prints a timeline + captured console highlights.
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9222';
const url = process.argv[3] || 'http://127.0.0.1:8123/crosspoint/?model=x4';
const base = `http://127.0.0.1:${port}`;
const sleep = (t) => new Promise(r => setTimeout(r, t));

let msgId = 0;
function rpc(ws, method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++msgId;
    const onMsg = (ev) => { const m = JSON.parse(ev.data);
      if (m.id === id) { ws.removeEventListener('message', onMsg);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result); } };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}

const list = await (await fetch(`${base}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) { console.log(JSON.stringify({ error: 'no page target' })); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

const logs = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.method === 'Runtime.consoleAPICalled') {
    const txt = (m.params.args || []).map(a => a.value ?? a.description ?? '').join(' ');
    if (/\[SDREG\]|\[DREG\]|\[seed\]|Discovery complete|Hardware detect|coi-sw|SharedArrayBuffer|abort|error/i.test(txt))
      logs.push(txt.slice(0, 160));
  }
});
await rpc(ws, 'Runtime.enable');
await rpc(ws, 'Page.enable');

const probe = `(function(){
  var c = document.getElementById('canvas') || {};
  return JSON.stringify({
    href: location.href,
    coi: !!self.crossOriginIsolated,
    hasSAB: (typeof SharedArrayBuffer !== 'undefined'),
    controller: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    mod: (typeof Module !== 'undefined'),
    ran: (typeof Module !== 'undefined' && !!Module.calledRun),
    cw: c.width || 0, ch: c.height || 0
  });
})()`;

await rpc(ws, 'Page.navigate', { url });

const timeline = [];
let booted = false;
const t0 = Date.now();
for (let i = 0; i < 32; i++) {
  await sleep(1500);
  let st = null;
  try {
    const r = await rpc(ws, 'Runtime.evaluate', { expression: probe, returnByValue: true });
    st = JSON.parse(r.result.value);
  } catch (e) { st = { err: String(e.message).slice(0, 60) }; }
  st.t = ((Date.now() - t0) / 1000).toFixed(1);
  timeline.push(st);
  if (st.coi && st.ran && st.cw > 0) { booted = true; break; }
}

const result = { url, booted, finalIsolated: timeline.at(-1)?.coi, timeline, logs };
writeFileSync('coi_test_result.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exit(booted ? 0 : 2);
