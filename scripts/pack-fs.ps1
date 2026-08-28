# Pack the SD card tree into the release asset that bootstrap.ps1 and CI pull.
#
#   pwsh scripts/pack-fs.ps1              # build fs-content.tar.zst
#   pwsh scripts/pack-fs.ps1 -Upload      # ...and publish/replace the release
#
# fs_/ is ~134 MB of books, fonts and dictionaries. It is deliberately NOT in
# git: it is large, binary, and changes far less often than the code. A release
# asset gives it a stable URL without inflating every clone.

param([switch]$Upload)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

if (-not (Test-Path 'fs_')) { throw "fs_/ not found - nothing to pack" }

$pins = @{}
Get-Content pins.env | Where-Object { $_ -match '^\s*[A-Z_]+=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2; $pins[$k.Trim()] = $v.Trim()
}
$tag = $pins.FS_CONTENT_TAG

Write-Host "[pack-fs] compressing fs_/ ..."
tar --zstd -cf fs-content.tar.zst -C fs_ .
$mb = (Get-Item fs-content.tar.zst).Length / 1MB
"[pack-fs] fs-content.tar.zst  {0:N1} MB" -f $mb

if ($Upload) {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh CLI required" }
  # Recreate the asset in place so the tag keeps pointing at current content.
  if (gh release view $tag 2>$null) {
    gh release upload $tag fs-content.tar.zst --clobber
  } else {
    gh release create $tag fs-content.tar.zst `
      --title "SD card content" `
      --notes "Books, fonts and dictionaries mirrored into dist/fs at build time."
  }
  Write-Host "[pack-fs] uploaded to release $tag"
}
