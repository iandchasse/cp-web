# Review and dependency update — 2026-09-16

**Performance follow-up, 2026-09-17** — see "Startup and frame rate" below.
Builds now ship the entire SD tree (`--slim` restores the books-only profile),
compressed and split at build time, and only the X4 Pro bundle is built.

## Dependencies

| Dependency | Before | After / decision |
| --- | --- | --- |
| Three.js, OrbitControls, 3MFLoader | r185, manually vendored | 0.186.0, regenerated together from npm; new BufferGeometryUtils dependency included |
| fflate | Untracked vendored version | 0.8.3, explicitly pinned |
| Emscripten | 6.0.4 | 6.0.9 |
| ArduinoJson | 7.4.2 | 7.4.3, release SHA-256 verified |
| Browser vendor tooling | None | esbuild 0.28.2; r186 no longer ships minified build files |
| GitHub Actions | checkout 4, setup-python 5, cache 4, upload-artifact 4, upload-pages-artifact 3, deploy-pages 4 | checkout 7.0.1, setup-python 7.0.0, setup-node 7.0.0, cache 6.1.0, upload-artifact 7.0.1, upload-pages-artifact 5.0.0, deploy-pages 5.0.1 |
| Firmware / simulator | Short SHA pins | Same commits, expanded to full SHAs |

Upstream firmware and simulator both have newer commits. They remain at the
compatible revisions because their HAL interface and the local simulator patch
must be upgraded together. Updating these to upstream HEAD is a separate firmware
migration, not a safe library bump. The retained pair builds with the new toolchain.
Silkscreen's dependencies were inspected but not changed.

Release references: [Three.js r186](https://github.com/mrdoob/three.js/releases/tag/r186),
[Emscripten 6.0.9](https://github.com/emscripten-core/emscripten/releases/tag/6.0.9),
[ArduinoJson 7.4.3](https://github.com/bblanchon/ArduinoJson/releases/tag/v7.4.3).

## Bugs fixed

- **Incorrect X3 framebuffer reads:** the page always constructed an 800 × 480
  texture reader, although X3 exports 792 × 528. The reusable reader now queries
  firmware dimensions, converts the correct buffer, and updates the texture shape.
- **False runtime readiness:** the wake splash timeout called the real first-frame
  callback. A slow boot could therefore call WASM exports before they were safe.
  Splash dismissal and firmware readiness are now separate.
- **3D resource leaks and loading race:** failed loads leaked renderers/observers;
  there was no unmount API; switching back to 2D while loading restarted hidden
  rendering. Added abortable loads, idempotent disposal and active-view checks.
- **Multiple pointers overwrote one gesture:** pointer IDs are now tracked, extra
  pointers/non-left buttons ignored, and lost capture releases the active press.
- **Stale library assets:** mutable filenames were advertised as immutable for a
  year and fetched with `force-cache`. Both HTTP headers and fetch now revalidate.
  Asset sizes are checked, and manifest errors are reported instead of silently
  returning an empty library. Failed eager loads keep firmware startup blocked.
- **Special filenames:** manifest URLs now escape `#`, `%`, spaces and Unicode
  while preserving their real MEMFS paths.
- **Premature state flush:** hiding the tab during restore could invoke an IDBFS
  save before initialization completed. Background saves now wait for first frame.
- **Stale build inputs / false success:** linking scanned all old object files,
  including deleted sources; compiler upgrades could reuse old objects; missing
  filesystem/page errors were not propagated by `model`/`all`. Fixed those paths,
  and `build.py fs` preserves the previous output when the source tree is absent.
- **C++ linking under new Emscripten:** linking object files with `emcc` omitted
  C++ runtime libraries in the tested toolchain. The driver now uses `em++`.
- **Bootstrap could not actually upgrade an existing install:** the SDK was only
  installed when its directory was absent, and old ArduinoJson headers caused a
  checksum error instead of being replaced. Bootstrap now refreshes SDK metadata,
  installs/activates the requested version, downloads and verifies a replacement
  header before replacing it, and checks git failures.
- **Small viewports overflowed:** panel fitting forced at least 1× scale. It now
  permits downscaling. An attribute/layout observer replaces per-frame size polling.
- **Artifact dotfiles:** CI uploads explicitly include hidden files such as
  `.nojekyll` instead of relying on upload action defaults.

## Remaining limitations, in priority order

1. **Silkscreen embedding needs a hosting decision.** Its existing cross-origin
   iframe does not make the parent cross-origin isolated. A child service worker
   cannot solve this. Use a separate top-level reader route, or isolate the parent
   and configure the embed appropriately. See `PORTING.md`.
2. **Startup payload is bounded by the library, not the code.** 9.2 MiB of
   compressed fonts and books plus 3.1 MiB of gzipped WASM are fetched before
   the first frame; the 11 MiB dictionary streams afterwards. Caching helps
   repeat visits but not first boot. Deferring the two unselected font families
   would take another 3 MiB off the critical path, at the cost of them missing
   from Settings until the next reload, because font discovery runs once at boot.

3. **The firmware runtime is not yet a React component.** Global Module, SDL input,
   worker lifetime, IDBFS state and reload-based wake still belong to the document.
   This pass extracts reusable data adapters and a renderer lifecycle; it does not
   make the entire firmware safe to mount/unmount repeatedly in an SPA.
4. **Persistence is best effort.** Visibility-triggered async saves are not a
   guarantee on tab/process termination. Seed files also apply individually, so
   partial seeding can leave settings present while other default files are absent.
5. **Hardware geometry is X4-specific.** X3/Pro pixels now read correctly, but the
   enclosure, hitboxes and screen placement still represent X4. Silkscreen needs
   its actual measured case/display placement and input mapping. Rotated-screen
   touch mapping and full sleep/wake persistence need dedicated integration tests.
6. **Legacy QA scripts are exploratory.** Several old gesture checks print a
   warning rather than assert it. The added `qa/cdp_smoke.mjs` fails on its checked
   regressions and cleans up its browser; it does not replace all gesture coverage.

## Startup and frame rate — 2026-09-17

Measured with a fresh Chrome profile against the deployed site, CDP-throttled to
20 Mbit/s, and repeated locally after each change.

| | Before | After |
| --- | --- | --- |
| First visit to first frame (20 Mbit) | 33.3 s | 6.4 s |
| Bytes before the first frame | 27.4 MiB | 10.3 MiB |
| 3D view, idle or orbiting | 20 fps | 60 fps |

- **The library blocked the boot, not the runtime.** The firmware itself reached
  its home screen 0.2 s after instantiating; 32 of the 33 s was one 24 MiB
  illustrated EPUB, which `main()` waits for. The new SD tree, its EPUBs already
  optimized upstream, plus build-time gzip of fonts and dictionaries, is what
  moved this. Relinking with `-Os`/`-O3` or without assertions was measured and
  rejected: under 1% of the gzipped WASM.
- **The SD download no longer waits for the runtime.** `prefetch()` starts the
  manifest and eager assets as the page parses, four at a time, and `loadEager`
  writes the bytes already in flight in manifest order. Previously nothing was
  requested until the runtime called `preRun`, leaving the link idle through the
  whole WASM download and compile.
- **The seed had to be recaptured.** Its recents and covers named the previous
  library's filenames, so the home screen opened on an empty shelf. The build
  already drops recents whose books are absent; `scripts/capture-seed.mjs` now
  regenerates them by driving a real build, one book per clean session.
- **Only the selected font family is needed before the first frame.**
  `setup()` loads the family the settings name and clears the setting if it is
  missing; the other packs (1.9 MiB gzipped) now stream in after boot, ahead of
  the dictionary. Discovery ran once at boot, so the page calls the new
  `cp_sd_fonts_changed()` export when the last one lands; the registry re-scans
  on the next Settings visit, the same path a web-server font upload uses.
- **Four pool workers, not eight.** Every pool worker loads and instantiates
  the module before `main()` may run; the firmware starts one thread.
- **Measured and rejected:** `-flto` (WASM grew from 5.51 to 5.92 MB, inlining
  outweighing dead-code removal), `-Os`/`-O3`/no-assertions (under 1% gzipped),
  and Emscripten lazy files for the books (they abort on the main thread, where
  the firmware's file reads happen). The 5.7 MiB *Pride and Prejudice* EPUB is
  now over half of the critical path; further gains are its images.
- **`delay()` on the browser main thread was a busy-wait.** The firmware's
  `loop()` ends with `delay(10)`, or `delay(50)` after three idle seconds, and
  Emscripten cannot sleep the main thread, so it spun there — flooring every
  animation frame at 50 ms whenever the user was not pressing anything, which is
  exactly what orbiting the 3D view is. The web build now records the requested
  deadline (`cpwebDelayDeadline`) and the frame loop runs no firmware work until
  it passes, keeping the firmware's own pacing without holding the thread.
  Frames the render task finished are still flushed on those skipped frames.

## 3D view: lit e-paper and the frontlight — 2026-09-17

The panel used to be an unlit `MeshBasicMaterial` showing the framebuffer at
full white: a backlit LCD. E-paper is reflective, so it is now a fully rough
standard material lit by the scene, whose map is the framebuffer remapped
through `einkLut()` to e-paper reflectances (white ≈ 222, black ≈ 52 in sRGB).
The scene gets image-based lighting from three.js's `RoomEnvironment`, a key
light with a soft shadow onto a shadow-catcher plane, ACES tone mapping, and a
PBR case material in place of the earlier Phong.

The firmware's frontlight is the only emissive term. `HalFrontlight` in the
simulator already tracks on/brightness/warmth without touching the framebuffer,
exactly like the hardware; the patch exports it (`cp_frontlight_*`) and
`runtime/frontlight.js` maps it to an emissive colour (cool white to amber by
warmth) and intensity (a 1.4-power curve of brightness). The same texture is
the emissive map, so lit paper glows and ink stays dark, and a faint additive
halo behind the glass leaks onto the bezel. The quick panel (status-bar tap,
Enter toggles, Left/Right adjust) drives it live. `examples/LivePanel.tsx`
carries the same treatment for Silkscreen.

## Validation

- Fresh bootstrap with checksum-verified ArduinoJson and Emscripten 6.0.9.
- `python build.py all`: 178 source files compiled and linked for each of X4,
  X4 Pro and X3, plus the published SD content and static page.
- Node regression tests and Python build regression tests.
- Browser smoke checks on a `/reader/` subpath with real isolation headers and
  with no isolation headers (service-worker fallback), using a fresh Chrome
  profile. Covers first frame, eager/deferred assets, 3D loading, per-device panel
  dimensions, toggle race, physical-button pointer routing and renderer disposal.
- `LivePanel.tsx` type-checked against the neighboring Silkscreen installation's
  actual TypeScript, React, R3F and Three.js declarations.
- Vendor reproducibility check and npm audit (zero reported npm vulnerabilities).

The hosted GitHub Actions workflow has not been executed or deployed from this
workspace. Browser checks use Chrome/SwiftShader, not a cross-browser or mobile
performance matrix. No production site or neighboring application was modified.
