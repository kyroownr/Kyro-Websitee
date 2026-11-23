# Regenerates icons/icon16|32|48|128.png for EasyKyro.
# Usage: powershell -ExecutionPolicy Bypass -File tools/make-icons.ps1
Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$dir = Join-Path $root 'icons'
New-Item -ItemType Directory -Force -Path $dir | Out-Null

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = 2 * $r
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

$S = 512
$bmp = New-Object System.Drawing.Bitmap -ArgumentList $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.PixelOffsetMode = 'HighQuality'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::Transparent)

$path = New-RoundedPath 0 0 $S $S (0.22 * $S)
$rect = New-Object System.Drawing.Rectangle -ArgumentList 0, 0, $S, $S
$bg = New-Object System.Drawing.Drawing2D.LinearGradientBrush -ArgumentList $rect, ([System.Drawing.Color]::FromArgb(255, 30, 35, 46)), ([System.Drawing.Color]::FromArgb(255, 8, 9, 13)), 90
$g.FillPath($bg, $path)

$border = New-Object System.Drawing.Pen -ArgumentList ([System.Drawing.Color]::FromArgb(46, 255, 255, 255)), 6
$g.DrawPath($border, $path)

$glow = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(40, 41, 151, 255))
$g.FillEllipse($glow, $S * 0.16, $S * 0.16, $S * 0.68, $S * 0.68)

$font = New-Object System.Drawing.Font -ArgumentList 'Segoe UI', ($S * 0.5), ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$format = New-Object System.Drawing.StringFormat
$format.Alignment = 'Center'
$format.LineAlignment = 'Center'
$white = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 245, 245, 247))
$textRect = New-Object System.Drawing.RectangleF -ArgumentList 0, 0, $S, $S
$g.DrawString('K', $font, $white, $textRect, $format)

$dot = New-Object System.Drawing.SolidBrush -ArgumentList ([System.Drawing.Color]::FromArgb(255, 41, 151, 255))
$g.FillEllipse($dot, $S * 0.655, $S * 0.655, $S * 0.17, $S * 0.17)

$g.Dispose()

foreach ($size in 16, 32, 48, 128) {
  $out = New-Object System.Drawing.Bitmap -ArgumentList $size, $size
  $og = [System.Drawing.Graphics]::FromImage($out)
  $og.InterpolationMode = 'HighQualityBicubic'
  $og.PixelOffsetMode = 'HighQuality'
  $og.SmoothingMode = 'AntiAlias'
  $og.DrawImage($bmp, 0, 0, $size, $size)
  $og.Dispose()
  $target = Join-Path $dir ("icon$size.png")
  $out.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
  $out.Dispose()
  Write-Host "wrote $target"
}

$bmp.Dispose()
