# crosspoint-web

The CrossPoint e-reader firmware compiled to WebAssembly and running in a
browser, with an optional three.js view that projects the live e-ink panel onto
a model of the Xteink X4.

Only the **X4 Pro** is built and deployed. The X4 and X3 profiles are stashed:
they remain in `MODELS` in `build.py`, and adding an id back to `ENABLED_MODELS`
restores it (the page's device picker reappears once more than one is built).

The build is **host-agnostic**. Every URL it emits is relative, and it falls
back to a service worker when a host cannot set COOP/COEP — so the same `dist/`
runs from GitHub Pages, Cloudflare Pages, Netlify, S3, a subfolder of an
existing site, or a local HTTP server, without rebuilding. HTTPS (or localhost)
is required; opening `index.html` directly with `file://` is not supported.
Embedding in another page additionally requires an isolated top-level page.
See [porting into silkscreen-site](PORTING.md) and the [review findings](REVIEW.md).

This repo holds **only the build harness** — about 6 MB. The firmware, the
simulator HAL and the SD card content live elsewhere and are pulled in at build
time. The default slim output is about 43 MiB; the full-content build is about
157 MiB.

## Layout

| Path | What it is |
| --- | --- |
| `build.py` | The whole build. Direct `emcc` compilation and `em++` linking — no PlatformIO. |
| `switcher.html` | The page: model picker, 2D/3D toggle, boot loader, input routing. |
| `three/` | Vendored three.js, `cp3d.js` (the 3D view), and `x4-device.3mf`. |
| `shims/` | Host shims the firmware links against, incl. the sleep/wake reload. |
| `seed.json` | Source first-visit state; the demo build keeps settings, recents and covers. |
| `sd-profile.json` | Allowlist for the three-book demo; excludes SD fonts and dictionaries. |
| `patches/` | Simulator changes not yet upstream (see below). |
| `pins.env` | Firmware, simulator, Emscripten and ArduinoJson pins. |
| `package.json`, `package-lock.json` | Pinned browser vendor tooling and libraries. |
| `runtime/` | Framework-independent framebuffer/filesystem adapters, with TypeScript declarations. |
| `examples/LivePanel.tsx` | Reuse the live panel in Silkscreen's React Three Fiber scene. |
| `scripts/` | `bootstrap.ps1` (recreate the env), `pack-fs.ps1` (publish the SD tree). |
| `serve.py` | Local server, with flags to emulate awkward hosts. |
| `qa/cdp_3d_input.mjs` | Headless-Chrome QA harness for taps, buttons and orbit. |

## What is deliberately *not* here

- **`emsdk/`** (~2 GB) — reinstalled from `EMSDK_VERSION` in `pins.env`.
- **`firmware/`, `simulator/`** — upstream repos, cloned at the pinned SHAs.
  `bootstrap.ps1` and CI both clone them *inside* this repo (they are
  gitignored); `build.py` also accepts them as siblings, which is how the
  original local workspace was laid out.
- **`thirdparty/ArduinoJson.h`** — single-header amalgamation, downloaded at
  `ARDUINOJSON_VERSION` and checksum-verified against `ARDUINOJSON_SHA256`.
- **`fs_/`** (~134 MB) — books, fonts and dictionaries. Published as a release
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
`python build.py model x4pro` for the model only, `all` for everything.

### Slim demo content

The default build includes **three books**, built-in Noto Serif / Noto Sans
reading fonts, and **no dictionary or SD font packs**. `sd-profile.json` lists
the books explicitly; a missing entry stops the content build before replacing
the previous filesystem output. CI uses this profile too.

```sh
python build.py fs             # update SD content and matching seed only
python build.py page           # update the page, SD content and matching seed
python build.py fs --full-fs   # restore the complete source SD tree and seed
```

`--full-fs` also works with `page`, `model` and `all`. The original `fs_/`,
release archive and source `seed.json` stay intact. `--skip-fs` preserves an
existing generated seed so a page-only update cannot restore stale SD settings.

Measured payload: **134.2 → 24.4 MiB SD content**, **4.55 MB → 22 KB seed**,
and **157.1 → 43.0 MiB total deployment**. The three book files are unchanged.
Pride and Prejudice's illustrated EPUB accounts for 23.7 MiB of the remainder.

The generated seed clears the removed font/dictionary selections, retains all
three recent-book cards and covers, and omits regenerable HTML/image/page caches.
Books paginate afresh on first open. Existing visitors retain their saved state;
the firmware falls back to built-in fonts when their selected SD font is missing.
Dictionary lookup is unavailable in the slim build.

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
Repeat against a `--no-coi` server to exercise service-worker isolation.

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

## The simulator patch

`patches/simulator-web.patch` adds two things the web build needs that are not
upstream:

- the `cp_fb_*` framebuffer exports in `HalDisplay`, which the 3D view samples;
- the `__EMSCRIPTEN__` sleep/wake shim in `HalGPIO`, since a browser tab cannot
  actually power down — wake is a real `location.reload()`.

Without it the build still links, but the 3D panel renders blank.
`bootstrap.ps1` applies it and is safe to re-run. When a pin moves and the patch
conflicts, resolve it in `simulator/` and re-export with `git -C simulator diff`.

> Watch the encoding: PowerShell's `>` writes UTF-16, which git rejects with
> "No valid patches in input". Write it with `UTF8Encoding($false)`.

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
