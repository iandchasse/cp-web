// Requires a local server and Chrome/Chromium. Isolated temporary profile;
// always exits nonzero on regression and tears down the browser on failure.
// CHROME=/path/to/chrome node qa/cdp_smoke.mjs http://127.0.0.1:8099/reader/
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { spawn } from 'node:child_process';

const profile = await mkdtemp(join(tmpdir(), 'cpweb-smoke-'));
const chromePath = process.env.CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const port = 9357;
const browser = spawn(chromePath, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,1100', 'about:blank'],
{ stdio: 'ignore' });
let launchError;
browser.on('error', error => { launchError = error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, message, timeout = 90000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (launchError) throw launchError;
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error('Timed out: ' + message);
}
let socket;
try {
  let target;
  await until(async () => {
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); }
    catch { return false; }
    return !!target;
  }, 'browser start', 15000);
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let id = 0;
  const pending = new Map();
  const exceptions = [];
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id) pending.get(message.id)?.(message);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails);
  };
  function send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const request = ++id;
      const timer = setTimeout(() => { pending.delete(request); reject(new Error('CDP timeout: ' + method)); }, 30000);
      pending.set(request, message => {
        clearTimeout(timer); pending.delete(request);
        if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
      });
      socket.send(JSON.stringify({ id: request, method, params }));
    });
  }
  async function js(expression) {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  await send('Runtime.enable');
  await send('Page.enable');
  // Every build the page advertises: one entry per firmware variant.
  const base = new URL(process.argv[2] || 'http://127.0.0.1:8099/reader/');
  const builds = await (await fetch(new URL('models.json', base))).json();
  assert.ok(builds.length, 'models.json lists no builds');
  console.log('builds: ' + builds.map(b => b.label).join(', '));
  for (const build of builds) {
    const model = build.id;
    // Both firmwares share one IDBFS-backed .crosspoint tree (same origin,
    // same mount point -- see README.md's "Firmware variants"), so whatever
    // state one build's sleep/wake test persists would otherwise leak into
    // the next build's cold boot. Each build gets a truly clean IndexedDB.
    await send('Storage.clearDataForOrigin', { origin: base.origin, storageTypes: 'indexeddb' });
    const url = new URL(base);
    url.searchParams.set('model', model);
    await send('Page.navigate', { url: String(url) });
    await until(() => js('!!window.__cpFirstFrame'), model + ' first frame');
    assert.equal(await js('crossOriginIsolated'), true);
    await until(() => js('!!window.fsLoad?.ready'), model + ' filesystem');
    assert.equal(await js('window.fsLoad.error'), null);
    if (process.env.CHECK_DEMO_CONTENT === '1') {
      // The full SD tree ships: three books, three SD font families and the
      // dictionary. Fonts and the dictionary are served gzipped and the
      // dictionary in parts, so this also proves the loader rebuilt them byte
      // for byte -- a wrong inflate or a dropped part would show up here.
      assert.deepEqual(await js('Module.FS.readdir("/fs_/books").filter(name => name.endsWith(".epub")).length'), 3);
      assert.deepEqual(await js('Module.FS.readdir("/fs_/fonts").filter(name => !name.startsWith(".")).sort()'),
        ['AtkinsonHyperlegibleNext', 'Bitter', 'Vollkorn']);
      const font = await js('Module.FS.stat("/fs_/fonts/Bitter/Bitter_16.cpfont").size');
      assert.ok(font > 700000, `inflated font too small: ${font}`);
      const dictionary = await js(`(() => {
        const dir = '/fs_/dictionaries/Oxford English';
        const name = Module.FS.readdir(dir).find(f => f.endsWith('.dict'));
        return name ? Module.FS.stat(dir + '/' + name).size : 0;
      })()`);
      assert.ok(dictionary > 40 * 1024 * 1024, `split dictionary not rejoined: ${dictionary}`);
      // Nothing may arrive as a .gz or .part-N: those are transport artifacts.
      assert.deepEqual(await js(`Module.FS.readdir('/fs_/fonts/Bitter').filter(f => /\.(gz|part-\d+)$/.test(f))`), []);
      // Home -> File Browser -> books -> first book. The seeded recents list is
      // empty (its covers named the previous library), so the home screen opens
      // on the menu; walk in with Enter until a book actually paginates.
      const paginated = () => js(`(() => {
        const root = '/fs_/.crosspoint';
        return Module.FS.readdir(root).filter(f => f.startsWith('epub_')).some(book => {
          const path = root + '/' + book + '/sections';
          return Module.FS.analyzePath(path).exists && Module.FS.readdir(path).some(name => name.endsWith('.bin'));
        });
      })()`);
      for (let press = 0; press < 4 && !(await paginated()); press++) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
        await sleep(1500);
      }
      await until(paginated, 'book layout regenerated');
      console.log(`${model}: full SD tree, inflated fonts, rejoined dictionary and pagination passed`);
    }
    // Toggle on then off while the model is still loading.
    await js('window.__enable3d(); document.getElementById("view3d").click()');
    await until(() => js('!!window.__dev3d?.ready'), model + ' 3D load');
    assert.equal(await js('window.__dev3d._raf'), null, 'hidden view restarted');
    await js('window.__enable3d()');
    await until(() => js('window.__dev3d?.lastFrame >= 0'), 'panel texture');
    const dimensions = await js('[window.__dev3d.tex.image.width, window.__dev3d.tex.image.height]');
    assert.deepEqual(dimensions, [build.w, build.h]);
    assert.ok(await js('window.__dev3d.tris > 0'));
    // The panel is lit e-paper, dark until the firmware's frontlight comes on.
    assert.equal(await js('window.__dev3d.screen.material.emissiveIntensity'), 0, 'frontlight off at boot');
    assert.equal(await js('typeof Module._cp_frontlight_on'), 'function', 'frontlight exports missing');
    assert.equal(await js('Module._cp_frontlight_on()'), 0, 'firmware starts with the light off');
    // The 3D material must follow that state, not a timer or a guess. Keep the
    // real reader so the end-to-end check below still sees the firmware.
    await js(`window.__realFrontlight = window.__dev3d.getFrontlight`);
    await js(`window.__dev3d.getFrontlight = () => ({ on: true, brightness: 80, warmth: 20 })`);
    await until(() => js('window.__dev3d.screen.material.emissiveIntensity > 0'),
                'panel emissive follows the frontlight', 10000);
    assert.equal(await js('window.__dev3d.halo.visible'), true);
    await js(`window.__dev3d.getFrontlight = () => ({ on: false, brightness: 0, warmth: 0 })`);
    await until(() => js('window.__dev3d.screen.material.emissiveIntensity === 0'),
                'panel goes dark again', 10000);
    await js(`window.__dev3d.getFrontlight = window.__realFrontlight`);

    // End to end through the firmware's own UI. The quick panel opens on a
    // top-edge down-swipe and toggles the light with Enter in both firmwares;
    // CrossInk drives its own inline HalFrontlight (shims/crossink/
    // frontlight_exports.cpp), not the simulator library's, so this is what
    // catches the two ending up out of sync again.
    await js('document.getElementById("view3d").click()');
    await sleep(800);
    // The quick panel opens from Home, FileBrowser or Settings, never from
    // the reader, and the content check above leaves a book open.
    for (let back = 0; back < 3; back++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(700);
    }
    const panel = await js('(() => { const r = document.getElementById("canvas").getBoundingClientRect(); return { x: r.left + r.width / 2, top: r.top, h: r.height }; })()');
    const from = panel.top + 8;
    const to = panel.top + Math.round(panel.h * 0.35);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: panel.x, y: from, button: 'left', buttons: 1, clickCount: 1 });
    for (let step = 1; step <= 6; step++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: panel.x,
        y: from + Math.round((to - from) * step / 6), button: 'left', buttons: 1 });
      await sleep(30);
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: panel.x, y: to, button: 'left', buttons: 0, clickCount: 1 });
    await sleep(2000);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await until(() => js('Module._cp_frontlight_on() === 1'), 'firmware frontlight on', 10000);
    await js('document.getElementById("view3d").click()');
    await until(() => js('!!window.__dev3d?.ready'), '3D back after the quick panel');
    await until(() => js('window.__dev3d.screen.material.emissiveIntensity > 0'),
                'panel lit from the firmware itself', 10000);
    console.log(`${model}: quick panel lit the 3D panel end to end`);

    // Sleep and wake must be seamless: no page navigation, no dropped 3D
    // scene, just the WASM instance rebooting in place (see README.md's
    // "Sleep and wake"). Back at Home first -- the sleep hotkey is ignored
    // while the quick panel is open.
    for (let back = 0; back < 3; back++) {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await sleep(400);
    }
    await js('window.__cpwebSmokeMarker = "pre-sleep"; window.Module.__cpwebSmokeTag = "pre-sleep"');
    const dev3dBefore = await js('window.__dev3d ? window.__dev3d.uuid || (window.__dev3d.uuid = Math.random()) : null');
    // 's' forces immediate sleep (a debug-only shortcut); 'p' is the power
    // button, which the poll in HalGPIO::pollWebSleepWake() treats as wake.
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
    await sleep(500);
    // Nothing about simulated sleep cuts power the way real hardware would,
    // so the firmware has to say so itself (cp_frontlight_set_on(0), called
    // once on the sleep transition in web_main.cpp) or the panel stays lit
    // over a screen that's supposed to be asleep.
    assert.equal(await js('Module._cp_frontlight_on()'), 0, 'frontlight must go dark on sleep, not just after wake');
    await until(() => js('window.__dev3d.screen.material.emissiveIntensity === 0'),
                'panel goes dark on sleep', 10000);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'p', code: 'KeyP', windowsVirtualKeyCode: 80 });
    // A real navigation would drop every JS global, including this one.
    await until(() => js('window.__cpwebSmokeMarker === "pre-sleep"'), 'no page navigation on wake', 5000);
    await until(() => js('window.Module?.__cpwebSmokeTag !== "pre-sleep"'), 'WASM instance rebooted in place', 15000);
    await until(() => js('!!window.__cpFirstFrame'), 'firmware ready again after wake', 15000);
    assert.equal(await js('window.__dev3d ? window.__dev3d.uuid : null'), dev3dBefore,
      'the 3D scene must survive a wake untouched');
    assert.equal(await js('typeof Module._cp_frontlight_on'), 'function', 'frontlight exports missing after wake');
    // "Restore Light on Wake" (CrossPointSettings::frontlightRestoreOnWake)
    // defaults on, and nothing here touched it -- the persisted frontlightOn
    // this build's own e2e check set (still true) means the fresh boot's
    // Frontlight.begin() should turn the light back on, same as real wake.
    assert.equal(await js('Module._cp_frontlight_on()'), 1, 'frontlight did not restore on wake');
    await until(() => js('window.__dev3d.screen.material.emissiveIntensity > 0'),
                'panel lit again after wake', 10000);
    console.log(`${model}: sleep/wake rebooted the WASM instance without touching the page`);

    // Drive a real physical-button press through the capture listeners.
    const button = await js('window.__dev3d.buttonToClient("down")');
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...button, button: 'left', buttons: 1, clickCount: 1 });
    await sleep(150);
    assert.equal(await js('window.__dev3d.buttons.find(b => b.userData.button.id === "down").material.opacity'), 0.45);
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...button, button: 'left', buttons: 0, clickCount: 1 });
    assert.equal(await js('window.__dev3d.buttons.find(b => b.userData.button.id === "down").material.opacity'), 0);
    await js('window.__dev3d.dispose(); window.__dev3d.dispose()');
    assert.equal(await js('document.querySelectorAll("#stage3d canvas").length'), 0);
    assert.equal(await js('window.__dev3d._raf'), null);
    assert.equal(await js(`(async () => {
      const { Device3D } = await import('./three/cp3d.js');
      const view = new Device3D(document.getElementById('stage3d'));
      const result = view.load().then(() => false, () => true);
      view.dispose();
      return await result && !document.querySelector('#stage3d canvas');
    })()`), true, 'dispose during fetch must abort and remove the canvas');
    console.log(`${model}: boot, filesystem, 3D, dimensions, toggle race, button input and disposal passed`);
  }
  // Opening the 3D view while the firmware is still booting must not touch its
  // exports: before the runtime initializes they are stubs that abort it. The
  // view has to come up lit-off and pick the frontlight up once the panel does.
  {
    const bootUrl = new URL(process.argv[2] || 'http://127.0.0.1:8099/reader/');
    bootUrl.searchParams.set('model', 'x4pro');
    await send('Page.navigate', { url: String(bootUrl) });
    await until(() => js('typeof window.__enable3d === "function"'), '3D entry point');
    assert.equal(await js('!!window.__cpFirstFrame'), false, 'firmware must still be booting');
    await js('window.__enable3d()');
    await until(() => js('!!window.__dev3d?.ready'), '3D loads during boot');
    assert.equal(await js('window.__dev3d.screen.material.emissiveIntensity'), 0, 'unlit before the first frame');
    await until(() => js('!!window.__cpFirstFrame'), 'firmware first frame with 3D already open');
    await until(() => js('window.__dev3d.lastFrame >= 0'), 'panel texture after boot');
    assert.equal(await js('window.fsLoad.error'), null);
    console.log('3D opened during boot: no aborted runtime, panel live once booted');
  }

  // A broken manifest must leave an actionable error and must not start main().
  await send('Network.enable');
  await send('Network.setBlockedURLs', { urls: ['*manifest.json'] });
  const failureUrl = new URL(process.argv[2] || 'http://127.0.0.1:8099/reader/');
  failureUrl.searchParams.set('model', 'x4pro');
  await send('Page.navigate', { url: String(failureUrl) });
  await until(() => js('!!window.fsLoad?.error'), 'filesystem failure');
  assert.equal(await js('!!window.__cpFirstFrame'), false);
  assert.match(await js('document.getElementById("status").textContent'), /Filesystem load failed/);
  console.log('Manifest failure: startup blocked with a visible error');
  assert.deepEqual(exceptions, [], 'uncaught browser exceptions');
} finally {
  socket?.close();
  const exited = new Promise(resolve => browser.once('exit', resolve));
  if (browser.exitCode === null && !launchError) { browser.kill(); await exited; }
  assert.equal(dirname(resolve(profile)), resolve(tmpdir()));
  assert.ok(basename(profile).startsWith('cpweb-smoke-'));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
}
