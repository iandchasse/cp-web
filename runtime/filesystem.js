/** Load the loose SD tree into any Emscripten FS; no DOM or window globals. */
export function createFilesystemLoader({ getFS, baseUrl, fetchImpl = fetch, onProgress = () => {}, signal }) {
  const base = new URL(baseUrl);
  const state = { eagerPct: 0, deferTotal: 0, deferDone: 0, ready: false, error: null };
  let deferred = [];

  async function fetchEntry(entry) {
    if (!entry.path?.startsWith('/fs_/') || entry.path.split('/').some(p => p === '..' || p === '.') ||
        entry.path.includes('\\') || entry.path.startsWith('/fs_/.crosspoint/')) {
      throw new Error('Invalid or reserved filesystem path: ' + entry.path);
    }
    const urls = entry.parts || [entry.url];
    if (!urls.length || urls.some(url => typeof url !== 'string' || !url)) throw new Error('Missing asset URL');
    const buffers = [];
    for (const url of urls) {
      const response = await fetchImpl(new URL(url, base), { cache: 'no-cache', signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      buffers.push(new Uint8Array(await response.arrayBuffer()));
    }
    const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    if (Number.isFinite(entry.size) && length !== entry.size) throw new Error('Asset size mismatch: ' + entry.path);
    // Avoid another full-file allocation for the usual single-part case.
    const data = buffers.length === 1 ? buffers[0] : new Uint8Array(length);
    if (buffers.length > 1) {
      let offset = 0;
      for (const buffer of buffers) { data.set(buffer, offset); offset += buffer.length; }
    }
    const fs = getFS();
    fs.mkdirTree(entry.path.slice(0, entry.path.lastIndexOf('/')));
    fs.writeFile(entry.path, data);
  }

  async function loadEager() {
    try {
      const response = await fetchImpl(new URL('manifest.json', base), { cache: 'no-store', signal });
      if (!response.ok) throw new Error('Manifest HTTP ' + response.status);
      const manifest = await response.json();
      if (manifest.version !== 1 || !Array.isArray(manifest.files)) throw new Error('Invalid filesystem manifest');
      const eager = manifest.files.filter(file => !file.defer);
      deferred = manifest.files.filter(file => file.defer);
      state.deferTotal = deferred.length;
      const total = eager.reduce((sum, file) => sum + (file.size || 0), 0);
      let loaded = 0;
      for (const file of eager) {
        await fetchEntry(file);
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

  return { state, loadEager, loadDeferred };
}
