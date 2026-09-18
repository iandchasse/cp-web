# Reusing cp-web in silkscreen-site

The target inspected for this work is `../silkscreen-site/silkscreen-main`: React 19.2,
Vite 8, React Three Fiber 9.7, and Three.js 0.171. Its `ReaderDemo` currently loads
the GitHub Pages build in a cross-origin iframe. No files in that application were
changed by this portability pass.

## Pieces ready to reuse

| Piece | Interface | Dependencies |
| --- | --- | --- |
| `runtime/framebuffer.js` | `new FramebufferReader(getModule, isReady).read()` | None; TypeScript declarations included |
| `runtime/frontlight.js` | `readFrontlight(module)`, `frontlightEmissive(state, glow)`, `einkLut()`, `applyLut()` | None; declarations included |
| `runtime/filesystem.js` | `createFilesystemLoader({getFS, baseUrl, fetchImpl?, signal?, onProgress?})` | Fetch API and Emscripten FS; declarations included |
| `examples/LivePanel.tsx` | React component inside an existing R3F `Canvas` | The host application's React, R3F and Three.js |
| `three/cp3d.js` | `Device3D(host, options)`, `load()`, `start()`, `stop()`, `dispose()` | The vendored Three.js renderer; useful for standalone use |

`FramebufferReader.read()` returns `null` until ready or when no new frame exists.
Otherwise it returns `{pixels, width, height, frame}`. Pixels are non-shared RGBA,
portrait and bottom-up for a Three.js `DataTexture` with its default `flipY=false`.
The reader owns and reuses the pixel array; copy it if you need to retain history.
Dimensions come from the firmware exports, including X3's 528 × 792 portrait panel.
Readiness must come from the real firmware first-frame event, not a timeout.

For the standalone renderer, inject `getModule` and `isReady` to avoid its legacy
`window.Module` / `window.__cpFirstFrame` defaults. `modelUrl` overrides the default
module-relative X4 asset. `panelW`, `topGap`, `zLift`, `fbW` and `fbH` are options;
URL query parsing belongs to the demo page. Custom case models still need their own
measured screen/button geometry: the built-in geometry is explicitly X4-specific.
Always call `dispose()` when removing a renderer, including after a failed load.

## Suggested integration sequence

1. Copy `runtime/framebuffer.js`, its `.d.ts`, and `examples/LivePanel.tsx` into
   Silkscreen, preserving or updating their relative import. Use the host's Three.js
   dependency; do not import cp-web's vendored Three.js into its R3F scene. This
   adapter exchanges byte arrays, so it does not require upgrading Silkscreen's
   Three.js 0.171 or its intentionally pinned React version.
2. Place `LivePanel` inside the existing device scene, in a group positioned and
   rotated onto the actual display glass. Pass physical dimensions in that scene's
   units. Defaults assume metres and the X4 panel; Silkscreen's enclosure and board
   use a different coordinate frame. The component handles only display output;
   it does not start WASM or add device input routing.
3. Initially keep the firmware in its own **same-origin isolated document** and
   pass getters for that document's `Module` and `__cpFirstFrame`. React can read
   these only when the iframe and parent are same-origin and the top-level page is
   isolated. The current GitHub Pages iframe is cross-origin, so its heap is not
   accessible this way. The SDL canvas must stay laid out for input forwarding.
4. For a direct runtime integration, add an Emscripten modular factory build and
   explicit runtime lifecycle. This pass does not make the C++ program restartable
   as a general React unmount/remount: it still has global state, worker threads
   and a single `window.Module`. A React component cannot dispose those merely by
   removing a canvas. That said, `switcher.html`'s `cpwebSoftReboot()` (see
   README.md's "Sleep and wake") is a working, tested example of tearing the
   instance down and booting a fresh one *in place*, without ever navigating the
   document: `SDL_Quit()` releases the canvas's GL context and input listeners,
   `PThread.terminateAllThreads()` clears the worker pool, and the same boot
   function runs again against a fresh `Module`. That is close to the sequence a
   real unmount/remount would need, minus the modular-factory wrapping (this build
   is not `-sMODULARIZE`, so its globals just get redeclared on each `<script>`
   injection rather than cleanly scoped) and minus the current build's assumption
   that only one instance ever exists on the page at a time. A same-origin iframe
   remains a useful lifetime boundary until factory startup, worker termination,
   input, persistence and this reboot sequence are adapted to that stricter model
   and tested.

The example uses `useFrame` and expects a continuously ticking R3F canvas while
the demo is active. With `frameloop="demand"`, arrange an external frame-change
notification or polling plus `invalidate()`; otherwise firmware changes alone
cannot schedule an R3F frame. Keep the `getModule` and `isReady` callbacks stable.

## Hosting decision before embedding

Threaded WASM requires a secure, cross-origin-isolated browsing context. A service
worker in the child cannot isolate a non-isolated top-level page. The current
Silkscreen iframe therefore cannot be assumed to work just because the standalone
GitHub Pages demo does. The demo now shows a new-tab link when isolation is absent.

Choose either a separate top-level reader route with `COOP: same-origin` and
`COEP: require-corp`, or isolate the containing application and its embedded reader.
For a cross-origin embed, also delegate `allow="cross-origin-isolated"` and ensure
the iframe response supplies compatible COEP headers. Review the containing page's
fonts, videos and other external resources before changing its policy.
[Browser isolation requirements](https://developer.mozilla.org/en-US/docs/Web/API/Window/crossOriginIsolated).

Silkscreen uses Cloudflare **Workers Static Assets**. Merge rules into its root
`public/_headers` / actual response handler, and account for its SPA fallback:
missing `.wasm`, manifests and SD assets must return errors, not the marketing
page's HTML. Copy the entire generated reader directory, including `runtime/`,
`three/`, model JS/WASM, manifests, service worker, seed and SD tree.

## Performance work to prioritize next

- The published library is the whole SD tree (three books, three SD font packs,
  the Oxford dictionary): 61.5 MiB of files served as 20.3 MiB after build-time
  gzip, of which 7.3 MiB is fetched before the reader starts; the unselected
  font packs and then the 11 MiB dictionary stream afterwards. First boot on a 20 Mbit link measures about
  6.4 s, against 33 s for the earlier 24 MiB illustrated-EPUB library. The
  generated seed is about 2 KB instead of 4.55 MB. Silkscreen's "a few MB" copy
  still understates the download. True book-on-demand loading needs coordination
  with synchronous firmware file access; replacing `fetch` alone is insufficient.
- The framebuffer copy skips unchanged frames and reuses its JS buffer. The
  standalone demo still renders to SDL and mirrors into a second WebGL context.
  Use `LivePanel` with the existing R3F renderer to avoid adding a third context.
- Visibility-triggered IndexedDB flushing is best effort, not a durable save
  guarantee on abrupt tab/process termination. An explicit save completion API
  and debounced saves during use would make the runtime portable with fewer
  assumptions about its host page.
- The model is an X4 case even for X3/Pro. Correct pixel dimensions do not make
  its enclosure, rocker positions or touch coordinates a Silkscreen hardware model.

See `REVIEW.md` for fixes, dependency decisions and validation details.
