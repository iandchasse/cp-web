# crosspoint-web

The CrossPoint e-reader firmware compiled to WebAssembly and running in a
browser, with an optional three.js view that projects the live e-ink panel onto
a model of the Xteink X4.

The build is **host-agnostic**. Every URL it emits is relative, and it falls
back to a service worker when a host cannot set COOP/COEP — so the same `dist/`
runs from GitHub Pages, Cloudflare Pages, Netlify, S3, a subfolder of an
existing site, or a local directory, with no rebuild and no configuration.

This repo holds **only the build harness** — about 6 MB. The firmware, the
simulator HAL and the SD card content live elsewhere and are pulled in at build
time. That is what keeps a clone fast despite a 157 MB output.

## Layout

| Path | What it is |
| --- | --- |
| `build.py` | The whole build. A direct `emcc` driver — no PlatformIO. |
| `switcher.html` | The page: model picker, 2D/3D toggle, boot loader, input routing. |
| `three/` | Vendored three.js, `cp3d.js` (the 3D view), and `x4-device.3mf`. |
| `shims/` | Host shims the firmware links against, incl. the sleep/wake reload. |
| `seed.json` | First-visit default state: theme, recents, font/dictionary settings. |
| `patches/` | Simulator changes not yet upstream (see below). |
| `pins.env` | Exact upstream versions. The single source of truth. |
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
`python build.py model x4pro` for one model, `all` for everything.

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
