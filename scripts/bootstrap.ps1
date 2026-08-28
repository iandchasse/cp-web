# Recreate the full build environment from a fresh clone.
#
#   powershell -File scripts/bootstrap.ps1            # toolchain + sources
#   powershell -File scripts/bootstrap.ps1 -WithFs    # also pull the SD tree
#
# Targets Windows PowerShell 5.1; pwsh works too.
#
# Everything here is derived from pins.env, so this and CI cannot drift.

param([switch]$WithFs)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# pins.env is plain KEY=VALUE so both bash (CI) and PowerShell can read it.
# The 0-9 in the class matters: keys like ARDUINOJSON_SHA256 contain digits.
$pins = @{}
Get-Content pins.env | Where-Object { $_ -match '^\s*[A-Z0-9_]+=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $pins[$k.Trim()] = $v.Trim()
}
$pins.GetEnumerator() | Sort-Object Name | ForEach-Object { "  $($_.Name) = $($_.Value)" }

function Clone-At([string]$url, [string]$dir, [string]$ref, [switch]$Submodules) {
  if (-not (Test-Path $dir)) {
    Write-Host "`n[bootstrap] cloning $dir"
    git clone --filter=blob:none $url $dir
  }
  git -C $dir fetch --all --quiet
  git -C $dir checkout --detach $ref
  if ($Submodules) {
    # freeink-sdk (and its nested lucide-icons) supply headers the build needs;
    # without this the compile fails on missing FreeInkUI/Icons includes.
    git -C $dir submodule update --init --recursive --depth 1
  }
}

Clone-At $pins.FIRMWARE_REPO  'firmware'  $pins.FIRMWARE_REF -Submodules
Clone-At $pins.SIMULATOR_REPO 'simulator' $pins.SIMULATOR_REF

# Single-header amalgamation the firmware and the simulator's WString.h both
# depend on. Fetched at the pinned version and checksum-verified.
if (-not (Test-Path 'thirdparty/ArduinoJson.h')) {
  Write-Host "`n[bootstrap] fetching ArduinoJson $($pins.ARDUINOJSON_VERSION)"
  New-Item -ItemType Directory -Force -Path thirdparty | Out-Null
  $v = $pins.ARDUINOJSON_VERSION
  Invoke-WebRequest -Uri "https://github.com/bblanchon/ArduinoJson/releases/download/v$v/ArduinoJson-v$v.h" `
                    -OutFile 'thirdparty/ArduinoJson.h'
}
$got = (Get-FileHash 'thirdparty/ArduinoJson.h' -Algorithm SHA256).Hash.ToLower()
if ($got -ne $pins.ARDUINOJSON_SHA256.ToLower()) {
  throw "ArduinoJson.h checksum mismatch: got $got, expected $($pins.ARDUINOJSON_SHA256)"
}

# The web build needs HAL changes that are not upstream (cp_fb_* framebuffer
# exports for the 3D view, and the sleep/wake shim). Re-applying on an already
# patched tree is a no-op rather than an error.
#
# The reverse-check FAILS on a fresh clone (nothing to reverse), and git reports
# that on stderr. Windows PowerShell turns redirected native stderr into an
# error record, so with $ErrorActionPreference='Stop' the old
# `if (git apply --check --reverse ... 2>$null)` threw on exactly the common
# path -- bootstrap died before it ever applied the patch. Branch on the exit
# code instead, which is the only reliable signal.
Write-Host "`n[bootstrap] applying simulator web patch"
Push-Location simulator
try {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  git apply --check --reverse ../patches/simulator-web.patch 2>&1 | Out-Null
  $alreadyApplied = ($LASTEXITCODE -eq 0)
  $ErrorActionPreference = $prev

  if ($alreadyApplied) {
    Write-Host "  already applied"
  } else {
    git apply --verbose ../patches/simulator-web.patch
    if ($LASTEXITCODE -ne 0) {
      throw "patch failed to apply - is SIMULATOR_REF ($($pins.SIMULATOR_REF)) still the pinned commit?"
    }
  }
} finally {
  Pop-Location
}

if (-not (Test-Path 'emsdk')) {
  Write-Host "`n[bootstrap] installing emsdk $($pins.EMSDK_VERSION)"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
  if ($LASTEXITCODE -ne 0) { throw "emsdk clone failed" }
  # PowerShell resolves the extensionless name to emsdk.ps1 via PATHEXT.
  ./emsdk/emsdk install  $pins.EMSDK_VERSION
  if ($LASTEXITCODE -ne 0) { throw "emsdk install failed for $($pins.EMSDK_VERSION)" }
  ./emsdk/emsdk activate $pins.EMSDK_VERSION
  if ($LASTEXITCODE -ne 0) { throw "emsdk activate failed for $($pins.EMSDK_VERSION)" }
}

# PlatformIO normally runs these as pre: extra_scripts. build.py does not, so
# they must run here or the compile fails on missing i18n symbols.
Write-Host "`n[bootstrap] firmware codegen"
Push-Location firmware
try {
  python scripts/gen_i18n.py --strip-unused
  if ($LASTEXITCODE -ne 0) { throw "gen_i18n.py failed" }
  python scripts/build_html.py
  if ($LASTEXITCODE -ne 0) { throw "build_html.py failed" }
} finally {
  Pop-Location
}

if ($WithFs) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh CLI required for -WithFs" }
  Write-Host "`n[bootstrap] downloading SD tree"
  gh release download $pins.FS_CONTENT_TAG --pattern 'fs-content.tar.zst' --output fs.tar.zst --clobber
  if ($LASTEXITCODE -ne 0) {
    throw "could not download release '$($pins.FS_CONTENT_TAG)'. Create it first with: powershell -File scripts/pack-fs.ps1 -Upload"
  }
  New-Item -ItemType Directory -Force -Path fs_ | Out-Null
  tar --zstd -xf fs.tar.zst -C fs_
  if ($LASTEXITCODE -ne 0) { throw "extracting fs.tar.zst failed" }
  Remove-Item fs.tar.zst
  $n = (Get-ChildItem fs_ -Recurse -File | Measure-Object).Count
  Write-Host "  restored $n files into fs_/"
}

Write-Host @"

[bootstrap] done. To build:
  . .\emsdk\emsdk_env.ps1
  python build.py all           # all three models + page + fs
  python build.py model x4pro   # one model
  python build.py page          # html/js only
"@
