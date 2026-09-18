# crosspoint-web

The CrossPoint e-reader firmware compiled to WebAssembly and running in a
browser, with an optional three.js view that projects the live e-ink panel onto
a model of the Xteink X4.

Two firmwares are built, both for the **X4 Pro**, and the page's picker switches
between them: **CrossPoint** (1.6.5rc) and **CrossInk** (v1.5.1, a fork of
CrossPoint 1.5). Each is a separate upstream project with its own simulator HAL
and its own web patch; they share this harness, the page, the 3D view and the SD
tree, and both keep their state in `/.crosspoint`, so your place in a book
carries across when you switch. See `VARIANTS` in `build.py`.

The X4 and X3 device profiles are stashed: they remain in `MODELS`, and adding an
id back to `ENABLED_MODELS` restores them.

The build is **host-agnostic**. Every URL it emits is relative, and it falls
back to a service worker when a host cannot set COOP/COEP — so the same `dist/`
runs from GitHub Pages, Cloudflare Pages, Netlify, S3, a subfolder of an
existing site, or a local HTTP server, without rebuilding. HTTPS (or localhost)
is required; opening `index.html` directly with `file://` is not supported.
Embedding in another page additionally requires an isolated top-level page.
See [porting into silkscreen-site](PORTING.md) and the [review findings](REVIEW.md).

This repo holds **only the build harness** — about 6 MB. The firmware, the
simulator HAL and the SD card content live elsewhere and are pulled in at build
time. The build ships the whole SD tree: three books, three SD font families and
the Oxford dictionary, 61.5 MiB on disk but **20.3 MiB served** after build-time
compression, of which only 9.2 MiB is fetched before the reader starts.

## Layout

| Path | What it is |
| --- | --- |
| `build.py` | The whole build. Direct `emcc` compilation and `em++` linking — no PlatformIO. `VARIANTS` defines the firmwares. |
| `switcher.html` | The page: model picker, 2D/3D toggle, boot loader, input routing. |
| `three/` | Vendored three.js, `cp3d.js` (the 3D view), and `x4-device.3mf`. |
| `runtime/frontlight.js` | Maps the firmware's frontlight to an emissive term; e-paper reflectance LUT. |
| `shims/` | Host shims the firmware links against, incl. the sleep/wake soft reboot. |
| `seed.json` | Source first-visit state; curated at build time against the shipped library. |
| `sd-profile.json` | Optional `--slim` allowlist: books only, no SD fonts or dictionary. |
| `patches/` | One web patch per simulator, not yet upstream (see below). |
| `pins.env` | Per-variant firmware/simulator pins, plus Emscripten and ArduinoJson. |
| `package.json`, `package-lock.json` | Pinned browser vendor tooling and libraries. |
| `runtime/` | Framework-independent framebuffer, frontlight and filesystem adapters, with TypeScript declarations. |
| `examples/LivePanel.tsx` | Reuse the live panel in Silkscreen's React Three Fiber scene. |
| `scripts/` | `bootstrap.ps1` (recreate the env), `pack-fs.ps1` (publish the SD tree), `capture-seed.mjs` (regenerate `seed.json`). |
| `serve.py` | Local server, with flags to emulate awkward hosts. |
| `qa/cdp_3d_input.mjs` | Headless-Chrome QA harness for taps, buttons and orbit. |

## What is deliberately *not* here

- **`emsdk/`** (~2 GB) — reinstalled from `EMSDK_VERSION` in `pins.env`.
- **`firmware/`, `simulator/`, `firmware-crossink/`, `simulator-crossink/`** —
  upstream repos, cloned at the pinned SHAs.
  `bootstrap.ps1` and CI both clone them *inside* this repo (they are
  gitignored); `build.py` also accepts them as siblings, which is how the
  original local workspace was laid out.
- **`thirdparty/ArduinoJson.h`** — single-header amalgamation, downloaded at
  `ARDUINOJSON_VERSION` and checksum-verified against `ARDUINOJSON_SHA256`.
- **`fs_/`** (~62 MB) — books, fonts and dictionaries. Published as a release
  asset (`FS_CONTENT_TAG`) because it is large, binary, and changes far less
  often than the code.
- **`dist/`** — build output. CI serves it straight from the build artifact, so
  it never enters git history.

## Getting a working tree

```powershell
powershell -File scripts/bootstrap.ps1 -WithFs
. .\emsdk\emsdk_env.ps1
python build.py all
python serve.py
```

Then open <http://127.0.0.1:8000/>.

Day to day: `python build.py page` for HTML/JS changes (seconds),
`python build.py model crossink` for one firmware, `all` for everything.
Bundles land as `dist/<firmware>-<device>.js`, e.g. `dist/crossink-x4pro.js`.

### SD content

The build mirrors the whole of `fs_/` — three books, the Atkinson Hyperlegible
Next / Bitter / Vollkorn font packs and the Oxford dictionary. Two build-time
transforms keep that affordable, both undone by the page loader, so what lands
in MEMFS is byte-for-byte the source file:

- **gzip.** Fonts compress to ~36% and the dictionary to ~22%. No static host
  applies `Content-Encoding` to these types, so `copy_fs` stores them as `.gz`
  (marked `"encoding": "gzip"` in the manifest) and the loader inflates them.
  EPUBs are already zip archives, fail the ratio test, and ship unchanged.
- **Splitting.** Anything still over 20 MiB is written as `.part-N` files and
  rejoined by the loader, because Cloudflare Pages rejects assets over 25 MiB.

Dictionaries and every font family except the one the seeded settings select
are marked `defer`, so they stream in after boot rather than blocking the first
paint: about 7.3 MiB is fetched before the reader starts, the other font packs
land within seconds (the page then tells the firmware to re-scan its font
registry, via `cp_sd_fonts_changed`), and the 11 MiB dictionary follows.

```sh
python build.py fs             # update SD content and matching seed only
python build.py page           # update the page, SD content and matching seed
python build.py fs --slim      # books only (sd-profile.json), for a tiny deploy
```

After changing the library, regenerate the first-visit state so the home screen
shows the new books rather than an empty shelf. The script drives a running
build in headless Chrome, opening every book so the firmware writes its own
recents and cover thumbnails, and keeps the existing `settings.json`:

```sh
python serve.py 8098                              # in another shell
node scripts/capture-seed.mjs http://127.0.0.1:8098/
```

`--slim` also works with `page`, `model` and `all`. The seed is always curated
against the library that actually ships: a recent-book card whose EPUB is absent
is dropped rather than left to open nothing, as are font and dictionary
selections naming files this build does not include.

### Browser dependencies and checks

Static builds still use checked-in vendor files; npm is needed only to update or
verify them, or run tests. Vendor generation copies licenses and rewrites local
imports, so deployment does not require an import map or a CDN.

```sh
npm ci --ignore-scripts
npm run vendor          # regenerate from package-lock.json
npm run vendor:check    # detect drift (also runs in CI)
npm test
python -m unittest discover -s tests -p 'test_*.py'
```

With a full build and `serve.py 8099 --prefix=/reader/` running:

```sh
node qa/cdp_smoke.mjs http://127.0.0.1:8099/reader/
```

The smoke suite checks every enabled device and fails on regressions. Set `CHROME`
to a Chrome/Chromium executable outside the default Windows installation.
Repeat against a `--no-coi` server to exercise service-worker isolation. With
`CHECK_DEMO_CONTENT=1` it also asserts the shipped library: inflated fonts, the
rejoined dictionary and a book that paginates.

## Hosting it

The only real requirement is **cross-origin isolation**: the firmware's threaded
render model needs `SharedArrayBuffer`, which browsers gate behind
`COOP: same-origin` + `COEP: require-corp`.

| Host | What to do | Isolation via |
| --- | --- | --- |
| GitHub Pages | Nothing — CI deploys it | `coi-serviceworker.js` |
| Cloudflare Pages / Netlify | Nothing — `_headers` ships in `dist/` | real headers |
| Subfolder of an existing site | Copy `dist/` in; merge `_headers` into the **site root** one, rescoped | real headers |
| Any dumb static host | Copy `dist/` in | `coi-serviceworker.js` |

Where headers are unavailable the bundled service worker supplies them
client-side, costing one extra reload on the very first visit. This path is
tested, not assumed — see below.

Two host-specific traps, both already handled in `dist/`:

- **Cloudflare Pages reads only ONE `_headers`, at the deployed site root.** A
  `_headers` inside a subfolder is silently ignored. Deploying as its own
  project means the shipped file works as-is; nesting under an existing site
  means merging its rules into that site's root file and rescoping `/*` to
  `/yourpath/*`. Do not widen isolation to a whole site you share with other
  pages — it breaks third-party embeds, web fonts and form scripts.
- **GitHub Pages runs Jekyll, which drops paths starting with `_`.** `build.py`
  emits `.nojekyll` to disable that.

Per-asset size also differs: Cloudflare Pages caps a single asset at 25 MiB
(which is why the SD tree is served as loose files rather than one `.data`
package), and GitHub Pages caps a whole site at 1 GB. CI enforces both.

### Verifying portability locally

`serve.py` can reproduce the two things most likely to break a deploy:

```powershell
python serve.py 8099 --no-coi --prefix=/crosspoint-web/
```

That serves with **no** COOP/COEP headers from a **subpath**, i.e. the GitHub
Pages project-site case. Confirmed good: `crossOriginIsolated: true`,
`SharedArrayBuffer` available, service worker in control, 2D and 3D both
interactive.

## Firmware variants

`VARIANTS` in `build.py` is the whole definition of a firmware: where its
checkouts live, which patch its simulator needs, its version macro, its extra
defines, the SDK libraries it pulls, and the sources to skip. Adding a third
fork means adding an entry, a patch and its pins.

Everything in the table was found by building the two:

| | CrossPoint | CrossInk |
| --- | --- | --- |
| Checkouts | `firmware/`, `simulator/` | `firmware-crossink/`, `simulator-crossink/` |
| Version macro | `CROSSPOINT_VERSION` | `CROSSINK_VERSION` |
| SDK pin | its own submodule commit | a different one (it uses `pageRowsFor`) |
| Extra SDK libs | — | `NearbyTransfer` |
| Native decoders | — | not enabled: the simulator's decoder shim is used, as here |
| `firmware_link_stubs.cpp` | **needed** (upstream dropped its `MySerialImpl`/uzlib definitions) | **excluded** (still defines both itself) |
| Also skipped | — | `HalClockSim`, `SimulatorSmokeTest.cpp` |
| Extra shim | — | `shims/crossink/smoke_test_stub.cpp` |

That stubs row is the trap: the two firmwares need *opposite* treatment of the
same simulator file, which is why exclusions are per variant rather than global.
Files under `shims/<variant>/` compile only into that variant.

The quick panel differs too: both open the frontlight drawer on a top-edge
down-swipe and toggle the light with Enter, but CrossInk drives its own
inline `HalFrontlight` singleton (`include/CrossInkHalFrontlight.h`) instead
of the simulator library's — `shims/crossink/frontlight_exports.cpp` exports
from that one instead, and the simulator's own `HalFrontlight.cpp` is excluded
for this variant (see `VARIANTS` in `build.py`) so nothing shadows it.

## The simulator patch

`patches/simulator-web.patch` adds two things the web build needs that are not
upstream:

- the `cp_fb_*` framebuffer exports in `HalDisplay`, which the 3D view samples;
- the `__EMSCRIPTEN__` sleep/wake shim in `HalGPIO`, since a browser tab cannot
  actually power down — the web build parks the firmware loop() and waits for
  the power button instead. Wake still needs to be a fresh boot, matching
  every other target (see `startDeepSleep()`), but doing that without a
  visible page reload takes more than HalGPIO alone: see the "Sleep and wake"
  section below.

Without it the build still links, but the 3D panel renders blank.
`bootstrap.ps1` applies it and is safe to re-run. When a pin moves and the patch
conflicts, resolve it in `simulator/` and re-export with `git -C simulator diff`.

> Watch the encoding: PowerShell's `>` writes UTF-16, which git rejects with
> "No valid patches in input". Write it with `UTF8Encoding($false)`.

## Sleep and wake

Every other target — hardware, the desktop simulator (`SimulatorLifecycle::
rebootAsPowerWake()`) — treats a power-button wake from deep sleep as a fresh
boot, not a resume in place, so the web build matches that rather than
inventing its own semantics. The naive way to get a fresh boot in a browser is
`location.reload()`, and that's what shipped first: it works, but a real page
navigation is visible (tab spinner, DOM torn down and rebuilt, the three.js
scene and camera reset) no matter how fast it is, so it needed a "Waking…"
splash to cover the gap.

`shims/web_main.cpp` and `switcher.html` now do the fresh boot without ever
navigating the browser:

1. `HalGPIO::pollWebSleepWake()` detects the power button; `main_tick()`
   cancels the main loop and calls `SDL_Quit()` immediately, which releases
   the canvas's WebGL context and the input listeners Emscripten's SDL2 port
   registered on it.
2. `cpweb_persist_and_reboot()` (EM_JS) syncs `/fs_/.crosspoint` to IndexedDB,
   then calls `window.cpwebSoftReboot()`.
3. `cpwebSoftReboot()` terminates the outgoing instance's pthread pool
   (`PThread.terminateAllThreads()`) and calls `bootModule()` again — the same
   function cold boot uses, with a fresh loose-file loader and a fresh
   `Module` — which injects a new `<model>.js` `<script>` tag against the same
   `#canvas`.

Nothing on the page outside the WASM instance is touched: the three.js scene,
camera and scroll position all survive untouched, and the canvas keeps
showing its last frame (the sleep screen) until the fresh instance's first
frame paints over it, so there's nothing to paper over with a splash.
`bootModule()` has to tolerate running a second time with zero state carried
over in JS — every closure it captures (the filesystem loader, `Module`) is
created fresh on each call.

## CI

`.github/workflows/build.yml`:

- **pull requests** — code-only build (~23 MB), no SD tree, no deploy.
- **pushes to `main` / manual dispatch** — full build, then deploy to this
  repo's GitHub Pages.

Enable it once under *Settings → Pages → Source: GitHub Actions*, and publish
the SD tree once with `powershell -File scripts/pack-fs.ps1 -Upload`
(`pwsh` also works if you have PowerShell 7; the scripts target 5.1).

Until that release exists the workflow still succeeds: it builds the code, warns
that the SD tree is missing, and skips publishing rather than deploying a
library with no books in it.

Two things the runner is picky about, both handled but easy to reintroduce:

- `$GITHUB_ENV` accepts **only** `KEY=VALUE`. Piping `pins.env` into it whole
  fails on the comments with "Invalid format", so the workflow filters with
  `grep -E '^[A-Z0-9_]+='` and strips CR with `tr -d '\r'`. Keep the `0-9` in
  the character class — keys like `ARDUINOJSON_SHA256` are dropped without it,
  and a dropped pin surfaces as a confusing failure much later in the run.
- `.gitattributes` forces LF for `pins.env` and marks `*.patch` as `-text`. A
  CRLF committed from Windows would otherwise put a stray `\r` in
  `FIRMWARE_REF` and break `git checkout`, or corrupt the patch context lines.
