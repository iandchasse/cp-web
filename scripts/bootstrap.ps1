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
    if ($LASTEXITCODE -ne 0) { throw "clone failed: $dir" }
  }
  git -C $dir fetch --all --quiet
  if ($LASTEXITCODE -ne 0) { throw "fetch failed: $dir" }
  git -C $dir checkout --detach $ref
  if ($LASTEXITCODE -ne 0) { throw "checkout failed: $dir at $ref" }
  if ($Submodules) {
    # freeink-sdk (and its nested lucide-icons) supply headers the build needs;
    # without this the compile fails on missing FreeInkUI/Icons includes.
    git -C $dir submodule update --init --recursive --depth 1
    if ($LASTEXITCODE -ne 0) { throw "submodule update failed: $dir" }
  }
}

# Firmware variants, matching VARIANTS in build.py. Each is a separate
# upstream project with its own simulator and its own web patch.
$variants = @(
  @{ Name = 'crosspoint'; Firmware = 'firmware';           Simulator = 'simulator';           Patch = 'simulator-web.patch' }
  @{ Name = 'crossink';   Firmware = 'firmware-crossink';  Simulator = 'simulator-crossink';  Patch = 'crossink-simulator-web.patch' }
)

foreach ($v in $variants) {
  $prefix = $v.Name.ToUpper()
  Clone-At $pins["${prefix}_FIRMWARE_REPO"]  $v.Firmware  $pins["${prefix}_FIRMWARE_REF"] -Submodules
  Clone-At $pins["${prefix}_SIMULATOR_REPO"] $v.Simulator $pins["${prefix}_SIMULATOR_REF"]
}

# Single-header amalgamation the firmware and the simulator's WString.h both
# depend on. Fetched at the pinned version and checksum-verified.
if (-not (Test-Path 'thirdparty/ArduinoJson.h') -or
    (Get-FileHash 'thirdparty/ArduinoJson.h' -Algorithm SHA256).Hash.ToLower() -ne $pins.ARDUINOJSON_SHA256.ToLower()) {
  Write-Host "`n[bootstrap] fetching ArduinoJson $($pins.ARDUINOJSON_VERSION)"
  New-Item -ItemType Directory -Force -Path thirdparty | Out-Null
  $v = $pins.ARDUINOJSON_VERSION
  Invoke-WebRequest -Uri "https://github.com/bblanchon/ArduinoJson/releases/download/v$v/ArduinoJson-v$v.h" `
                    -OutFile 'thirdparty/ArduinoJson.h.download'
  $downloadHash = (Get-FileHash 'thirdparty/ArduinoJson.h.download' -Algorithm SHA256).Hash.ToLower()
  if ($downloadHash -ne $pins.ARDUINOJSON_SHA256.ToLower()) { throw 'ArduinoJson download checksum mismatch' }
  Move-Item -LiteralPath 'thirdparty/ArduinoJson.h.download' -Destination 'thirdparty/ArduinoJson.h' -Force
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
foreach ($v in $variants) {
  Write-Host "`n[bootstrap] applying web patch to $($v.Simulator)"
  Push-Location $v.Simulator
  try {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    git apply --check --reverse "../patches/$($v.Patch)" 2>&1 | Out-Null
    $alreadyApplied = ($LASTEXITCODE -eq 0)
    $ErrorActionPreference = $prev

    if ($alreadyApplied) {
      Write-Host "  already applied"
    } else {
      git apply --verbose "../patches/$($v.Patch)"
      if ($LASTEXITCODE -ne 0) {
        $ref = $pins["$($v.Name.ToUpper())_SIMULATOR_REF"]
        throw "patch failed to apply - is $($v.Name)'s SIMULATOR_REF ($ref) still the pinned commit?"
      }
    }
  } finally {
    Pop-Location
  }
}

if (-not (Test-Path 'emsdk')) {
  Write-Host "`n[bootstrap] installing emsdk $($pins.EMSDK_VERSION)"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
  if ($LASTEXITCODE -ne 0) { throw "emsdk clone failed" }
}
# Refresh version metadata and activate the pin even on an existing installation.
git -C emsdk pull --ff-only
if ($LASTEXITCODE -ne 0) { throw 'emsdk metadata update failed' }
./emsdk/emsdk install $pins.EMSDK_VERSION
if ($LASTEXITCODE -ne 0) { throw "emsdk install failed for $($pins.EMSDK_VERSION)" }
./emsdk/emsdk activate $pins.EMSDK_VERSION
if ($LASTEXITCODE -ne 0) { throw "emsdk activate failed for $($pins.EMSDK_VERSION)" }

# PlatformIO normally runs these as pre: extra_scripts. build.py does not, so
# they must run here or the compile fails on missing i18n symbols.
# The two firmwares name their web-asset step differently (build_html.py vs
# build_web.py), so run whichever exists rather than hardcoding one.
foreach ($v in $variants) {
  Write-Host "`n[bootstrap] $($v.Name) codegen"
  Push-Location $v.Firmware
  try {
    python scripts/gen_i18n.py --strip-unused
    if ($LASTEXITCODE -ne 0) { throw "gen_i18n.py failed for $($v.Name)" }
    foreach ($web in @('scripts/build_html.py', 'scripts/build_web.py')) {
      if (Test-Path $web) {
        python $web
        if ($LASTEXITCODE -ne 0) { throw "$web failed for $($v.Name)" }
      }
    }
  } finally {
    Pop-Location
  }
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
  python build.py all           # both firmwares + page + fs
  python build.py model x4pro   # one model
  python build.py page          # html/js only
"@
