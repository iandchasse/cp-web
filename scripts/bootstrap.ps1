# Recreate the full build environment from a fresh clone.
#
#   pwsh scripts/bootstrap.ps1            # toolchain + sources
#   pwsh scripts/bootstrap.ps1 -WithFs    # also pull the SD tree release asset
#
# Everything here is derived from pins.env, so this and CI cannot drift.

param([switch]$WithFs)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# pins.env is plain KEY=VALUE so both bash (CI) and PowerShell can read it.
$pins = @{}
Get-Content pins.env | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $pins[$k.Trim()] = $v.Trim()
}
$pins.GetEnumerator() | Sort-Object Name | ForEach-Object { "  $($_.Name) = $($_.Value)" }

function Clone-At([string]$url, [string]$dir, [string]$ref) {
  if (-not (Test-Path $dir)) {
    Write-Host "`n[bootstrap] cloning $dir"
    git clone --filter=blob:none $url $dir
  }
  git -C $dir fetch --all --quiet
  git -C $dir checkout --detach $ref
}

Clone-At $pins.FIRMWARE_REPO  'firmware'  $pins.FIRMWARE_REF
Clone-At $pins.SIMULATOR_REPO 'simulator' $pins.SIMULATOR_REF

# The web build needs HAL changes that are not upstream (cp_fb_* framebuffer
# exports for the 3D view, and the sleep/wake shim). Re-applying on an already
# patched tree is a no-op rather than an error.
Write-Host "`n[bootstrap] applying simulator web patch"
Push-Location simulator
if (git apply --check --reverse ../patches/simulator-web.patch 2>$null) {
  Write-Host "  already applied"
} else {
  git apply --verbose ../patches/simulator-web.patch
}
Pop-Location

if (-not (Test-Path 'emsdk')) {
  Write-Host "`n[bootstrap] installing emsdk $($pins.EMSDK_VERSION)"
  git clone --depth 1 https://github.com/emscripten-core/emsdk.git
  ./emsdk/emsdk install  $pins.EMSDK_VERSION
  ./emsdk/emsdk activate $pins.EMSDK_VERSION
}

Write-Host "`n[bootstrap] firmware codegen"
Push-Location firmware
python scripts/gen_i18n.py --strip-unused
python scripts/build_html.py
Pop-Location

if ($WithFs) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh CLI required for -WithFs" }
  Write-Host "`n[bootstrap] downloading SD tree"
  gh release download $pins.FS_CONTENT_TAG --pattern 'fs-content.tar.zst' --output fs.tar.zst --clobber
  New-Item -ItemType Directory -Force -Path fs_ | Out-Null
  tar --zstd -xf fs.tar.zst -C fs_
  Remove-Item fs.tar.zst
}

Write-Host @"

[bootstrap] done. To build:
  . .\emsdk\emsdk_env.ps1
  python build.py all           # all three models + page + fs
  python build.py model x4pro   # one model
  python build.py page          # html/js only
"@
