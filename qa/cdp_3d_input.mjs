// Exercise 3D input end to end: real CDP pointer events land on the three.js
// stage, get raycast, and must come out the other side as firmware touches and
// button presses. Deliberately does NOT call the forwarder directly -- the whole
// point is to test the path a user's hand takes.
//
//   node cdp_3d_input.mjs <model> <outPrefix>
import { writeFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';

const MODEL = process.argv[2] || 'x4pro';
const OUT = process.argv[3] || 'in3d';
const PORT = 9345;
const CHROME = process.env.CHROME ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_ = process.env.URL || `http://127.0.0.1:8000/index.html?model=${MODEL}`;

const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${process.env.TEMP}\\cp3d-input`,
  '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  '--disable-gpu-sandbox', `--window-size=${process.env.WIN || '820,1000'}`, URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = j.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  } catch (e) { /* not up */ }
  if (!page) await sleep(500);
}
if (!page) { console.error('no chrome target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r, { once: true }));
let id = 0; const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  else if (m.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', m.params.exceptionDetails.text,
                m.params.exceptionDetails.exception?.description || '');
  }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');
const js = async (expr) => {
  const r = await send('Runtime.evaluate',
    { expression: expr, awaitPromise: true, returnByValue: true });
  // Without this, a throwing/mis-parsed expression silently yields undefined,
  // which is indistinguishable from an expression that legitimately returns
  // undefined. That ambiguity has already cost one debug cycle.
  const ex = r.result?.exceptionDetails;
  if (ex) {
    const msg = ex.exception?.description || ex.text || JSON.stringify(ex);
    throw new Error(`page threw: ${msg}`);
  }
  return r.result?.result?.value;
};
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  if (r.result?.data) {
    writeFileSync(`shots/${OUT}-${name}.png`, Buffer.from(r.result.data, 'base64'));
    console.log('   shot', name);
  }
};
const fb = () => js('window.Module && Module._cp_fb_counter ? Module._cp_fb_counter() : -1');

// A cheap sampled hash of the *firmware's* framebuffer, read straight from the
// WASM heap. Independent of whether we are looking at the 2D canvas or the 3D
// model, so it is the honest way to ask "did the reader actually change?".
const fbHash = () => js(`(() => {
  const M = window.Module;
  // NOTE: testing for _cp_fb_sync is NOT sufficient. Emscripten installs the
  // exports as stubs that ABORT the module if called before runtime init, so
  // across a wake reload this would kill the page. __cpFirstFrame is the only
  // honest readiness signal.
  if (!M || !M._cp_fb_sync || !window.__cpFirstFrame) return 'na';
  M._cp_fb_sync();
  const ptr = M._cp_fb_ptr(), w = M._cp_fb_width(), h = M._cp_fb_height();
  const src = new Uint8Array(M.HEAPU8.buffer, ptr, w * h * 4);
  let x = 2166136261;
  for (let i = 0; i < src.length; i += 61) { x ^= src[i]; x = Math.imul(x, 16777619); }
  return (x >>> 0).toString(16);
})()`);

// e-ink refreshes are slow and book parsing is async, so poll rather than
// sleeping a fixed amount and hoping.
async function settle(prevHash, timeoutMs = 9000) {
  const t0 = Date.now();
  let last = prevHash, stableFor = 0;
  while (Date.now() - t0 < timeoutMs) {
    await sleep(300);
    const h = await fbHash();
    if (h !== last) { last = h; stableFor = 0; }
    else if (h !== prevHash) { stableFor += 300; if (stableFor >= 900) break; }
  }
  return last;
}

// Wait for the firmware to have painted at least one frame.
for (let i = 0; i < 90; i++) {
  if (await js('!!window.__cpFirstFrame')) break;
  await sleep(1000);
}
console.log('booted, fb =', await fb());

// MODE=2d runs the identical gesture script against the plain canvas, which is
// the baseline: anything 2D cannot do either is a bad test target, not a 3D bug.
const MODE = process.env.MODE || '3d';
if (MODE === '3d') {
  console.log(await js('window.__enable3d(), "3D requested"'));
  for (let i = 0; i < 60; i++) {
    if (await js('!!(window.__dev3d && window.__dev3d.screen)')) break;
    await sleep(500);
  }
  await sleep(2500);
  console.log('3D ready:', await js('window.__dev3d.tris'), 'tris');
} else {
  console.log('2D baseline mode');
}
await shot('01-home');

// --- real pointer helpers -------------------------------------------------
const mouse = (type, x, y, extra = {}) => send('Input.dispatchMouseEvent', {
  type, x: Math.round(x), y: Math.round(y), button: 'left',
  buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1,
  pointerType: 'mouse', ...extra,
});
const at = (u, v) => (MODE === '3d'
  ? js(`JSON.stringify(window.__dev3d.panelToClient(${u}, ${v}))`)
  : js(`(() => { const r = document.getElementById('canvas').getBoundingClientRect();
         return JSON.stringify({ x: r.left + ${u} * r.width, y: r.top + (1 - ${v}) * r.height }); })()`)
).then(JSON.parse);
const btnAt = (idb) => (MODE === '3d'
  ? js(`JSON.stringify(window.__dev3d.buttonToClient(${JSON.stringify(idb)}))`).then(JSON.parse)
  : Promise.resolve(null));

async function tap(u, v, label) {
  const p = await at(u, v);
  const h0 = await fbHash();
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y);
  await sleep(90);
  await mouse('mouseReleased', p.x, p.y);
  const h1 = await settle(h0);
  console.log(`   tap ${label} uv(${u},${v}) -> client(${p.x|0},${p.y|0})  ${h0} -> ${h1} ${h1 !== h0 ? 'CHANGED' : 'NO CHANGE'}`);
  return h1;
}

async function swipe(u0, v0, u1, v1, label, opts = {}) {
  const a = await at(u0, v0), b = await at(u1, v1);
  const h0 = await fbHash();
  // The firmware rejects a contact held longer than TOUCH_SWIPE_MAX_MS (700 ms)
  // as a drag rather than a swipe. Each CDP dispatch costs real milliseconds, so
  // a move-heavy gesture blows the budget on round-trips alone. Keep the move
  // count low and report the measured press-to-release time.
  const N = opts.moves ?? 4;
  const gap = opts.gapMs ?? 0;
  const t0 = Date.now();
  await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
  await mouse('mousePressed', a.x, a.y);
  for (let i = 1; i <= N; i++) {
    await mouse('mouseMoved', a.x + (b.x - a.x) * i / N, a.y + (b.y - a.y) * i / N);
    if (gap) await sleep(gap);
  }
  await mouse('mouseReleased', b.x, b.y);
  const heldMs = Date.now() - t0;
  const h1 = await settle(h0);
  const slow = heldMs > 700 ? ' !!OVER 700ms BUDGET' : '';
  console.log(`   swipe ${label}  held ${heldMs}ms${slow}  ${h0} -> ${h1} ${h1 !== h0 ? 'CHANGED' : 'NO CHANGE'}`);
  return h1;
}

async function key(k, label) {
  const map = { ArrowRight: 39, ArrowLeft: 37, ArrowUp: 38, ArrowDown: 40, Enter: 13, Escape: 27 };
  // Single letters need an explicit virtual keycode AND a "KeyX"-form code;
  // passing code:'s' with no keycode dispatches an event SDL never sees.
  const isLetter = /^[a-z]$/i.test(k);
  const vk = isLetter ? k.toUpperCase().charCodeAt(0) : map[k];
  const code = isLetter ? 'Key' + k.toUpperCase() : k;
  const h0 = await fbHash();
  const common = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  await send('Input.dispatchKeyEvent', { type: 'keyDown', ...common,
    ...(isLetter ? { text: k } : {}) });
  await sleep(120);
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...common });
  const h1 = await settle(h0);
  console.log(`   key ${label || k}  ${h0} -> ${h1} ${h1 !== h0 ? 'CHANGED' : 'NO CHANGE'}`);
  return h1;
}

async function press(idb, label, holdMs = 140) {
  const p = await btnAt(idb);
  if (!p) { console.log(`   button ${idb} NOT FOUND`); return null; }
  const h0 = await fbHash();
  await mouse('mouseMoved', p.x, p.y, { buttons: 0 });
  await mouse('mousePressed', p.x, p.y);
  await sleep(holdMs);
  await mouse('mouseReleased', p.x, p.y);
  const h1 = await settle(h0);
  console.log(`   press ${label} -> client(${p.x|0},${p.y|0})  ${h0} -> ${h1} ${h1 !== h0 ? 'CHANGED' : 'NO CHANGE'}`);
  return h1;
}

// --- the actual checks ----------------------------------------------------
const steps = JSON.parse(process.env.STEPS || '[]');
const marks = {};
for (const s of steps) {
  let h = null;
  if (s.t === 'hints') { await js(`window.__dev3d.showButtonHints(${s.on !== false})`); await sleep(600); }
  if (s.t === 'camfront') {
    await js(`(() => { const d = window.__dev3d;
      const r = d.camera.position.length();
      d.camera.position.set(0, 0, r);
      d.controls.target.set(0, 0, 0);
      d.controls.update();
      return 'ok'; })()`);
    await sleep(900);
  }
  if (s.t === 'wait') { await sleep(s.ms || 3000); console.log('   waited', s.ms || 3000, 'ms ->', await fbHash()); }
  if (s.t === 'eval')  { console.log('   eval:', await js(s.js)); await sleep(s.ms || 400); }
  // Evaluate a whole .js file. Passing large scripts through the STEPS env var
  // means round-tripping them through PowerShell's JSON encoder, which mangles
  // multi-line strings; reading from disk sidesteps that entirely.
  if (s.t === 'evalfile') {
    console.log('   evalfile:', s.path);
    console.log(await js(readFileSync(s.path, 'utf8')));
    await sleep(s.ms || 400);
  }
  if (s.t === 'tap')   h = await tap(s.u, s.v, s.label);
  if (s.t === 'swipe') h = await swipe(s.u0, s.v0, s.u1, s.v1, s.label, s);
  if (s.t === 'key')   h = await key(s.key, s.label);
  if (s.t === 'press') h = await press(s.id, s.label);
  if (s.t === 'orbit')  {
    // Drag starting off the device (but still inside the 3D stage) must orbit.
    const r = JSON.parse(await js(
      'JSON.stringify(document.getElementById("stage3d").getBoundingClientRect())'));
    const oy = Math.round(r.top + r.height * 0.55);
    const ox = Math.round(r.left + 24);
    const before = await js('JSON.stringify(window.__dev3d.camera.position)');
    await mouse('mouseMoved', ox, oy, { buttons: 0 });
    await mouse('mousePressed', ox, oy);
    for (let i = 1; i <= 10; i++) { await mouse('mouseMoved', ox + i * 12, oy); await sleep(16); }
    await mouse('mouseReleased', ox + 120, oy);
    await sleep(600);
    const after = await js('JSON.stringify(window.__dev3d.camera.position)');
    console.log('   orbit off-device:', before === after ? 'NO MOVEMENT (bad)' : 'camera moved OK');
  }
  // Sustained orbit drag, for frame-pacing measurement. Traces a small circle
  // so a long drag stays inside the stage instead of running off the edge.
  if (s.t === 'orbitn') {
    const r = JSON.parse(await js(
      'JSON.stringify(document.getElementById("stage3d").getBoundingClientRect())'));
    const cx = Math.round(r.left + 40);
    const cy = Math.round(r.top + r.height * 0.55);
    const n = s.n || 60;
    const before = await js('JSON.stringify(window.__dev3d.camera.position)');
    const t0 = Date.now();
    await mouse('mouseMoved', cx, cy, { buttons: 0 });
    await mouse('mousePressed', cx, cy);
    for (let i = 1; i <= n; i++) {
      await mouse('mouseMoved',
        cx + Math.round(30 * Math.sin(i / 6)),
        cy + Math.round(18 * Math.cos(i / 6)));
      await sleep(s.gap === undefined ? 8 : s.gap);
    }
    await mouse('mouseReleased', cx, cy);
    const after = await js('JSON.stringify(window.__dev3d.camera.position)');
    // Logged because a silent orbitn makes it impossible to tell a real result
    // from a drag that was too short to have exercised anything.
    console.log(`   orbitn n=${n} held ${Date.now() - t0} ms:`,
      before === after ? 'NO MOVEMENT (bad)' : 'camera moved OK');
  }
  if (s.t === 'noorbit') {
    // A drag across the glass must NOT orbit.
    const a = await at(0.2, 0.5), b = await at(0.8, 0.5);
    const before = await js('JSON.stringify(window.__dev3d.camera.position)');
    await mouse('mouseMoved', a.x, a.y, { buttons: 0 });
    await mouse('mousePressed', a.x, a.y);
    for (let i = 1; i <= 10; i++) {
      await mouse('mouseMoved', a.x + (b.x - a.x) * i / 10, a.y + (b.y - a.y) * i / 10);
      await sleep(16);
    }
    await mouse('mouseReleased', b.x, b.y);
    await sleep(600);
    const after = await js('JSON.stringify(window.__dev3d.camera.position)');
    console.log('   drag on glass:', before === after ? 'camera still OK' : 'CAMERA MOVED (bad)');
  }
  if (s.mark) { marks[s.mark] = h ?? await fbHash(); }
  if (s.same) {
    const now = h ?? await fbHash();
    console.log(`   vs "${s.same}": ${marks[s.same] === now ? 'IDENTICAL (returned to same page)' : 'different'}`);
  }
  if (s.name) await shot(s.name);
}

ws.close();
chrome.kill();
