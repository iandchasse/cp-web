// Regenerate seed.json: the first-visit state a new browser starts from.
//
// The firmware's home screen reads /.crosspoint/recent.json and the cover
// thumbnails beside it, which only exist once a book has actually been opened.
// So rather than hand-writing that state, this drives a real build in headless
// Chrome: open every book in the library, then dump the state tree the firmware
// wrote. settings.json is carried over from the existing seed, because the
// theme/sleep/font defaults there were chosen deliberately; build.py's
// curate_seed() later drops any font or dictionary that a given build omits.
//
//   python build.py page && python serve.py 8098      # in another shell
//   node scripts/capture-seed.mjs http://127.0.0.1:8098/
//
// Writes seed.json in the repo root. Review the diff before committing it.
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const url = process.argv[2] || 'http://127.0.0.1:8098/';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const profile = await mkdtemp(join(tmpdir(), 'cpweb-seed-'));
const port = 9500 + Math.floor(Math.random() * 60);
const chrome = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--window-size=1000,1100', 'about:blank'],
  { stdio: 'ignore' });
browser.on('error', error => { throw error; });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let target;
for (let i = 0; i < 60 && !target; i++) {
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); }
  catch { /* not listening yet */ }
  if (!target) await sleep(250);
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
let id = 0;
const pending = new Map();
socket.onmessage = event => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); }
};
const send = (method, params = {}) => new Promise(resolve => {
  const next = ++id; pending.set(next, resolve);
  socket.send(JSON.stringify({ id: next, method, params }));
});
const js = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 400));
  return result.result?.value;
};
const codes = { Enter: 13, Escape: 27, ArrowDown: 40, ArrowUp: 38, h: 72 };
const press = async keyName => {
  for (const type of ['keyDown', 'keyUp']) {
    await send('Input.dispatchKeyEvent', { type, key: keyName, code: keyName, windowsVirtualKeyCode: codes[keyName] });
  }
  await sleep(1200);
};
const until = async (check, what, timeout = 120000) => {
  for (const start = Date.now(); Date.now() - start < timeout;) {
    if (await check()) return;
    await sleep(300);
  }
  throw new Error('Timed out waiting for ' + what);
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.navigate', { url });
  await until(() => js('!!window.__cpFirstFrame'), 'first frame');
  await until(() => js('window.fsLoad?.eagerPct === 100'), 'library');
  await sleep(1500);

  const books = await js(`Module.FS.readdir('/fs_/books').filter(name => name.endsWith('.epub')).sort()`);
  if (!books?.length) throw new Error('no books in /fs_/books');
  console.log(`[seed] library: ${books.length} books`);

  const opened = () => js(`(() => {
    const root = '/fs_/.crosspoint';
    return Module.FS.readdir(root).filter(name => name.startsWith('epub_')).filter(book =>
      Module.FS.analyzePath(root + '/' + book + '/sections').exists).length;
  })()`);

  const dump = () => js(`(() => {
    const walk = (dir, out) => {
      for (const name of Module.FS.readdir(dir)) {
        if (name === '.' || name === '..') continue;
        const path = dir + '/' + name;
        if (Module.FS.isDir(Module.FS.stat(path).mode)) walk(path, out);
        else {
          const data = Module.FS.readFile(path);
          let binary = '';
          for (let i = 0; i < data.length; i++) binary += String.fromCharCode(data[i]);
          out[path.replace('/fs_/.crosspoint/', '')] = btoa(binary);
        }
      }
      return out;
    };
    return walk('/fs_/.crosspoint', {});
  })()`);

  // One book per session, each from an empty IndexedDB. The home screen's
  // layout changes once it has a "continue reading" card and the file browser
  // remembers where it was, so a single session would need a different key
  // sequence for every book; from a clean start the path is always the same.
  // The per-book recents are merged below, newest last so library order wins.
  const captured = {};
  const recents = [];
  let recentsFile = null;
  for (let index = 0; index < books.length; index++) {
    if (index > 0) {
      await send('Storage.clearDataForOrigin', { origin: new URL(url).origin, storageTypes: 'indexeddb' });
      await send('Page.navigate', { url });
      await until(() => js('!!window.__cpFirstFrame'), 'first frame');
      await until(() => js('window.fsLoad?.eagerPct === 100'), 'library');
      await sleep(1500);
    }
    await press('Enter');                   // Browse Files -> SD card root
    await press('Enter');                   // into books/
    for (let step = 0; step < index; step++) await press('ArrowDown');
    await press('Enter');                   // open the book
    await until(async () => await opened() > 0, `${books[index]} to open`);
    await sleep(4000);                      // lay out and write the cover
    await press('Escape');                  // home: writes the recents entry
    await sleep(2500);
    const session = await dump();
    const parsed = JSON.parse(Buffer.from(session['recent.json'], 'base64').toString('utf8'));
    recentsFile = parsed;                   // keep the firmware's own schema
    const entry = parsed.books?.[0];
    if (!entry) throw new Error('no recents entry for ' + books[index]);
    if (!entry.path.endsWith(books[index])) throw new Error(`opened ${entry.path}, wanted ${books[index]}`);
    recents.push(entry);
    for (const [name, data] of Object.entries(session)) {
      if (/^epub_\d+\/thumb_\d+\.bmp$/.test(name)) captured[name] = data;
    }
    console.log(`[seed] captured ${books[index]}`);
  }
  captured['recent.json'] = Buffer.from(JSON.stringify({ ...recentsFile, books: recents })).toString('base64');

  const previous = JSON.parse(await readFile(join(root, 'seed.json'), 'utf8'));
  const files = { 'settings.json': previous.files['settings.json'] };
  files['recent.json'] = captured['recent.json'];
  for (const [name, data] of Object.entries(captured)) {
    if (/^epub_\d+\/thumb_\d+\.bmp$/.test(name)) files[name] = data;
  }
  if (!files['recent.json']) throw new Error('firmware wrote no recent.json');
  const merged = JSON.parse(Buffer.from(files['recent.json'], 'base64').toString('utf8'));
  console.log(`[seed] recents: ${merged.books.map(book => book.path).join(', ')}`);
  console.log(`[seed] covers: ${Object.keys(files).filter(name => name.endsWith('.bmp')).length}`);

  await writeFile(join(root, 'seed.json'), JSON.stringify({
    version: 1,
    note: 'First-visit defaults: settings plus the recents and covers of the shipped library.',
    source_capturedAt: new Date().toISOString(),
    files,
  }, null, 1));
  console.log('[seed] wrote seed.json');
} finally {
  socket?.close();
  browser.kill();
  await sleep(500);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}
