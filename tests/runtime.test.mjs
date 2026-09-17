import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { FramebufferReader } from '../runtime/framebuffer.js';
import { createFilesystemLoader } from '../runtime/filesystem.js';

test('wake splash timeout never announces a firmware frame', () => {
  const html = readFileSync(new URL('../switcher.html', import.meta.url), 'utf8');
  const bridge = html.slice(html.indexOf('    // --- Wake bridge'), html.indexOf('    // Integer-scale'));
  const window = {}, timers = [];
  vm.runInNewContext(bridge, {
    window,
    document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) },
    sessionStorage: { getItem: () => '1', removeItem() {} },
    setTimeout: (fn, delay) => timers.push({ fn, delay }),
  });
  timers.find(timer => timer.delay === 15000).fn();
  assert.equal(window.__cpFirstFrame, undefined);
  window.cpwebFirstFrame();
  assert.equal(window.__cpFirstFrame, true);
});

test('framebuffer gates calls until ready, uses real dimensions, and converts BGRA/rotation', () => {
  let ready = false, calls = 0, counter = 1;
  const module = {
    HEAPU8: Uint8Array.from([1, 2, 3, 0, 4, 5, 6, 0]),
    _cp_fb_width: () => 2, _cp_fb_height: () => 1, _cp_fb_ptr: () => 0,
    _cp_fb_counter: () => counter,
    _cp_fb_sync: () => { calls++; return counter; },
  };
  const reader = new FramebufferReader(() => module, () => ready);
  assert.equal(reader.read(), null);
  assert.equal(calls, 0);
  ready = true;
  const frame = reader.read();
  assert.deepEqual([frame.width, frame.height], [1, 2]);
  assert.deepEqual([...frame.pixels], [6, 5, 4, 255, 3, 2, 1, 255]);
  assert.equal(reader.read(), null);
  assert.equal(calls, 1);
  // A grown heap must be reacquired; the output allocation can be reused.
  counter++;
  module.HEAPU8 = Uint8Array.from([7, 8, 9, 0, 10, 11, 12, 0]);
  assert.equal(reader.read().pixels, frame.pixels);
  assert.equal(frame.pixels[0], 12);
});

test('framebuffer re-reads replacement runtimes even when counters match', () => {
  const make = n => ({ HEAPU8: Uint8Array.from([n, n, n, 255]),
    _cp_fb_width: () => 1, _cp_fb_height: () => 1, _cp_fb_ptr: () => 0,
    _cp_fb_counter: () => 1, _cp_fb_sync: () => 1 });
  let module = make(1);
  const reader = new FramebufferReader(() => module, () => true);
  assert.equal(reader.read().pixels[0], 1);
  module = make(2);
  assert.equal(reader.read().pixels[0], 2);
});

function fixture(files, response = () => new Response(Uint8Array.of(1, 2))) {
  const writes = new Map(), urls = [];
  const loader = createFilesystemLoader({
    baseUrl: 'https://example.test/reader/',
    getFS: () => ({ mkdirTree() {}, writeFile(path, data) { writes.set(path, data); } }),
    fetchImpl: async url => {
      urls.push(String(url));
      return String(url).endsWith('manifest.json')
        ? Response.json({ version: 1, files }) : response();
    },
  });
  return { loader, writes, urls };
}

test('filesystem resolves subpath assets, defers dictionaries, and concatenates parts', async () => {
  const { loader, writes, urls } = fixture([
    { path: '/fs_/book.epub', url: 'fs/book.epub', size: 2 },
    { path: '/fs_/dictionaries/test', parts: ['fs/a', 'fs/b'], size: 4, defer: true },
  ]);
  await loader.loadEager();
  assert.equal(writes.size, 1);
  assert.equal(loader.state.eagerPct, 100);
  assert.equal(loader.state.ready, false);
  await loader.loadDeferred();
  assert.equal(loader.state.ready, true);
  assert.equal(loader.state.deferDone, 1);
  assert.deepEqual([...writes.get('/fs_/dictionaries/test')], [1, 2, 1, 2]);
  assert.equal(urls[1], 'https://example.test/reader/fs/book.epub');
});

test('filesystem rejects truncated assets instead of writing corrupt books', async () => {
  const { loader, writes } = fixture([{ path: '/fs_/book', url: 'fs/book', size: 20 }]);
  await assert.rejects(loader.loadEager(), /size mismatch/);
  assert.equal(writes.size, 0);
  await loader.loadDeferred();
  assert.equal(loader.state.ready, false);
});

test('filesystem rejects manifest HTTP failures', async () => {
  const loader = createFilesystemLoader({ baseUrl: 'https://example.test/', getFS() {},
    fetchImpl: async () => new Response('', { status: 404 }) });
  await assert.rejects(loader.loadEager(), /Manifest HTTP 404/);
});

test('filesystem cannot escape its SD root or overwrite persisted settings', async () => {
  for (const path of ['/fs_/../settings', '/other/file', '/fs_/.crosspoint/settings.json']) {
    const { loader, writes } = fixture([{ path, url: 'fs/file', size: 2 }]);
    await assert.rejects(loader.loadEager(), /Invalid or reserved/);
    assert.equal(writes.size, 0);
  }
});
