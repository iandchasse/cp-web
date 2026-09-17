# Review and dependency update — 2026-09-16

**Content follow-up:** default builds now apply `sd-profile.json`: three novels,
no SD font packs or dictionary, and a settings/recents/covers-only seed. SD content
is 24.4 MiB, seed is 22 KB, and total output is 43.0 MiB. The larger measurements
below describe the original/full-content baseline. See README for `--full-fs`.
The slim profile passed all three device browser checks, including first-book
pagination with built-in fonts and regenerated caches. All three EPUBs were
verified byte-for-byte against the source tree.

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
2. **Startup payload is large.** The published SD tree has 96 files, about 134.2
   MiB total, with 88 MiB eager and 46.2 MiB deferred. The 4.55 MB seed is additional.
   Caching helps repeat visits but not first boot. Curating a demo library offers a
   larger gain than micro-optimizing the nine-call 3D scene. A single-part fetch no
   longer creates an unnecessary second full-file JS buffer.
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
