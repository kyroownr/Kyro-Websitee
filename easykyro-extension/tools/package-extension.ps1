# Builds the Chrome Web Store upload zip for EasyKyro.
# Usage: powershell -ExecutionPolicy Bypass -File tools/package-extension.ps1
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$out = Join-Path (Split-Path -Parent $root) 'easykyro-extension.zip'

function Add-ZipEntry($archive, [string]$file, [string]$entryName) {
  $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
  $entry.LastWriteTime = (Get-Item $file).LastWriteTime
  $target = $entry.Open()
  $source = [System.IO.File]::OpenRead($file)
  try { $source.CopyTo($target) } finally { $source.Dispose(); $target.Dispose() }
}

if (Test-Path $out) { Remove-Item $out -Force }

$stream = [System.IO.File]::Open($out, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($stream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
  # Zip entry names must use forward slashes; Compress-Archive writes backslashes
  # on Windows, which the Chrome Web Store and some unzip tools mishandle.
  foreach ($file in 'manifest.json', 'popup.html', 'popup.css', 'popup.js', 'background.js', 'PRIVACY.md') {
    Add-ZipEntry $archive (Join-Path $root $file) $file
  }
  foreach ($dir in 'content', 'icons') {
    Get-ChildItem (Join-Path $root $dir) -File -Recurse | ForEach-Object {
      $relative = $_.FullName.Substring($root.Length + 1).Replace('\', '/')
      Add-ZipEntry $archive $_.FullName $relative
    }
  }
} finally {
  $archive.Dispose()
  $stream.Dispose()
}

$size = [math]::Round((Get-Item $out).Length / 1KB, 1)
Write-Host "wrote $out ($size KB)"
Write-Host 'Upload this zip at https://chrome.google.com/webstore/devconsole'
