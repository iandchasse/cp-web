# Pack the SD card tree into the release asset that bootstrap.ps1 and CI pull.
#
#   powershell -File scripts/pack-fs.ps1              # build fs-content.tar.zst
#   powershell -File scripts/pack-fs.ps1 -Upload      # ...and publish/replace it
#
# fs_/ is ~134 MB of books, fonts and dictionaries. It is deliberately NOT in
# git: it is large, binary, and changes far less often than the code. A release
# asset gives it a stable URL without inflating every clone.

param(
  [switch]$Upload,
  # Defaults to whatever `gh` infers from the git remote.
  [string]$Repo
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Test-Path 'fs_')) { throw "fs_/ not found - nothing to pack" }

# Digits matter: keys like ARDUINOJSON_SHA256 are dropped by [A-Z_]+.
$pins = @{}
Get-Content pins.env | Where-Object { $_ -match '^\s*[A-Z0-9_]+=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2; $pins[$k.Trim()] = $v.Trim()
}
$tag = $pins.FS_CONTENT_TAG
if (-not $tag) { throw "FS_CONTENT_TAG missing from pins.env" }

# gh reports "release not found" on STDERR. Windows PowerShell turns native
# stderr into an error record whenever it is redirected, and with
# $ErrorActionPreference='Stop' that *throws* -- so the old
# `if (gh release view $tag 2>$null)` blew up on the normal "does not exist yet"
# path instead of taking the else branch. Run gh with the preference relaxed and
# branch on $LASTEXITCODE, which is the only reliable signal.
#
# Two traps this function exists to contain:
#  - The parameter must not be called $Args. That is an automatic variable, and
#    binding it silently yields an empty array -- which makes `& gh @GhArgs` run
#    bare `gh`, exit 0, and report every release as existing.
#  - Nothing here may write to the PIPELINE. A function returns everything
#    emitted, so echoing gh's output would make the caller receive
#    @('...url...', 0) instead of 0, and `$rc -ne 0` would be true on success.
#    Progress goes to the host; only the exit code is returned.
function Invoke-Gh {
  param([string[]]$GhArgs, [switch]$Quiet)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = & gh @GhArgs 2>&1
    $code = $LASTEXITCODE
    if (-not $Quiet) { $out | ForEach-Object { Write-Host "  $_" } }
    return [int]$code
  } finally {
    $ErrorActionPreference = $prev
  }
}

$repoArgs = @()
if ($Repo) { $repoArgs = @('--repo', $Repo) }

Write-Host "[pack-fs] compressing fs_/ ..."
tar --zstd -cf fs-content.tar.zst -C fs_ .
if ($LASTEXITCODE -ne 0) { throw "tar failed with exit code $LASTEXITCODE" }
$mb = (Get-Item fs-content.tar.zst).Length / 1MB
"[pack-fs] fs-content.tar.zst  {0:N1} MB" -f $mb

if (-not $Upload) { return }

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh CLI required for -Upload" }
if ((Invoke-Gh -GhArgs (@('auth', 'status')) -Quiet) -ne 0) {
  throw "gh is not authenticated - run: gh auth login"
}

# Recreate the asset in place so the tag keeps pointing at current content.
$exists = (Invoke-Gh -GhArgs (@('release', 'view', $tag, '--json', 'tagName') + $repoArgs) -Quiet) -eq 0

if ($exists) {
  Write-Host "[pack-fs] release '$tag' exists - replacing asset"
  $rc = Invoke-Gh -GhArgs (@('release', 'upload', $tag, 'fs-content.tar.zst', '--clobber') + $repoArgs)
} else {
  # Deleting a release in the web UI leaves the git tag behind, so the tag can
  # outlive the release. `gh release create` reuses an existing tag rather than
  # failing, but say so -- otherwise "creating release" on a tag you can see in
  # the repo looks like the script is confused.
  $tagOrphaned = (Invoke-Gh -GhArgs (@('api', "repos/{owner}/{repo}/git/ref/tags/$tag") + $repoArgs) -Quiet) -eq 0
  if ($tagOrphaned) {
    Write-Host "[pack-fs] tag '$tag' exists but has no release - creating one on it"
  } else {
    Write-Host "[pack-fs] creating release '$tag'"
  }
  $rc = Invoke-Gh -GhArgs (@('release', 'create', $tag, 'fs-content.tar.zst',
                           '--title', 'SD card content',
                           '--notes', 'Books, fonts and dictionaries mirrored into dist/fs at build time. Consumed by .github/workflows/build.yml and scripts/bootstrap.ps1 -WithFs.') + $repoArgs)
}
if ($rc -ne 0) { throw "gh release upload/create failed with exit code $rc" }

# Confirm the asset is actually attached: `gh release create` can succeed at
# making the release while the upload fails, which would leave CI downloading
# nothing and silently building a reader with no books.
#
# Read stdout only. Merging stderr in here (2>&1) would let a gh warning line
# land in $assets and defeat the membership test.
$prev = $ErrorActionPreference
$ErrorActionPreference = 'Continue'
$assets = @(& gh release view $tag --json assets --jq '.assets[].name' @repoArgs 2>$null)
$viewCode = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($viewCode -ne 0) { throw "could not read back release '$tag' (gh exit $viewCode)" }
$assets = $assets | ForEach-Object { "$_".Trim() } | Where-Object { $_ }
if ($assets -notcontains 'fs-content.tar.zst') {
  throw "release '$tag' exists but has no fs-content.tar.zst asset (found: $($assets -join ', '))"
}

Write-Host "[pack-fs] OK - '$tag' now carries fs-content.tar.zst ($('{0:N1}' -f $mb) MB)"

