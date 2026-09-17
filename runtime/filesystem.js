/** Load the loose SD tree into any Emscripten FS; no DOM or window globals. */
export function createFilesystemLoader({ getFS, baseUrl, fetchImpl = fetch, onProgress = () => {}, signal,
                                         concurrency = 4 }) {
  const base = new URL(baseUrl);
  const state = { eagerPct: 0, deferTotal: 0, deferDone: 0, ready: false, error: null };
  let deferred = [];
  let manifestPromise = null;
  const downloads = new Map();

  function checkEntry(entry) {
    if (!entry.path?.startsWith('/fs_/') || entry.path.split('/').some(p => p === '..' || p === '.') ||
        entry.path.includes('\\') || entry.path.startsWith('/fs_/.crosspoint/')) {
      throw new Error('Invalid or reserved filesystem path: ' + entry.path);
    }
    const urls = entry.parts || [entry.url];
    if (!urls.length || urls.some(url => typeof url !== 'string' || !url)) throw new Error('Missing asset URL');
    return urls;
  }

  async function download(entry) {
    const urls = checkEntry(entry);
    const buffers = [];
    for (const url of urls) {
      const response = await fetchImpl(new URL(url, base), { cache: 'no-cache', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      buffers.push(new Uint8Array(await response.arrayBuffer()));
    }
    const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    // Avoid another full-file allocation for the usual single-part case.
    let data = buffers.length === 1 ? buffers[0] : new Uint8Array(length);
    if (buffers.length > 1) {
      let offset = 0;
      for (const buffer of buffers) { data.set(buffer, offset); offset += buffer.length; }
    }
    // Fonts and dictionaries are served pre-compressed: no static host applies
    // Content-Encoding to these types, and they are a third of their size
    // gzipped. "size" is the real file's size, so it is checked after inflating.
    if (entry.encoding) {
      if (entry.encoding !== 'gzip') throw new Error(`Unsupported encoding ${entry.encoding} for ${entry.path}`);
      if (typeof DecompressionStream === 'undefined') throw new Error('Browser cannot inflate compressed assets');
      data = new Uint8Array(await new Response(
        new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    }
    if (Number.isFinite(entry.size) && data.length !== entry.size) {
      throw new Error('Asset size mismatch: ' + entry.path);
    }
    return data;
  }

  function write(entry, data) {
    const fs = getFS();
    fs.mkdirTree(entry.path.slice(0, entry.path.lastIndexOf('/')));
    fs.writeFile(entry.path, data);
  }

  async function fetchEntry(entry) {
    write(entry, await download(entry));
  }

  async function manifest() {
    const response = await fetchImpl(new URL('manifest.json', base), { cache: 'no-store', signal });
    if (!response.ok) throw new Error('Manifest HTTP ' + response.status);
    const parsed = await response.json();
    if (parsed.version !== 1 || !Array.isArray(parsed.files)) throw new Error('Invalid filesystem manifest');
    deferred = parsed.files.filter(file => file.defer);
    state.deferTotal = deferred.length;
    return parsed.files.filter(file => !file.defer);
  }

  /** Start downloading the eager assets without an FS to write them into.
   *
   * The runtime cannot accept files until it has instantiated, but the network
   * is idle until then. Prefetching overlaps the SD download with the WASM
   * download and compile; loadEager() later writes the bytes already in flight.
   * Safe to call more than once, and safe never to call: loadEager() starts its
   * own downloads when it finds none pending.
   */
  function prefetch() {
    if (manifestPromise) return manifestPromise;
    manifestPromise = manifest().then(eager => {
      // A small window, not all at once: browsers queue per-host requests
      // anyway, and every entry in flight holds its whole file in memory.
      let active = 0;
      const waiting = [];
      const take = () => new Promise(grant => (active < concurrency ? (active++, grant()) : waiting.push(grant)));
      const give = () => { active--; const next = waiting.shift(); if (next) { active++; next(); } };
      for (const entry of eager) {
        const started = take().then(() => download(entry)).finally(give);
        // Nothing awaits these until loadEager runs, so absorb the rejection
        // here and re-surface it there rather than as an unhandled rejection.
        started.catch(() => {});
        downloads.set(entry, started);
      }
      return eager;
    });
    manifestPromise.catch(() => {});
    return manifestPromise;
  }

  async function loadEager() {
    try {
      // Written in manifest order regardless of completion order, so a partial
      // failure leaves a prefix of the library rather than a random subset.
      const eager = await (manifestPromise || manifest());
      const total = eager.reduce((sum, file) => sum + (file.size || 0), 0);
      let loaded = 0;
      for (const file of eager) {
        const pending = downloads.get(file);
        write(file, pending ? await pending : await download(file));
        downloads.delete(file);
        loaded += file.size || 0;
        state.eagerPct = total ? Math.round(loaded / total * 100) : 100;
        onProgress(state.eagerPct);
      }
      state.eagerPct = 100;
    } catch (error) {
      state.error = String(error);
      throw error;
    }
  }

  async function loadDeferred() {
    if (state.error) return;
    try {
      for (const file of deferred) { await fetchEntry(file); state.deferDone++; }
      state.ready = true;
    } catch (error) {
      state.error = String(error);
      throw error;
    }
  }

  return { state, prefetch, loadEager, loadDeferred };
}
