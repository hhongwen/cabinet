# 从 SVG 生成 .ico（用 Chrome headless 渲染成 PNG，再包成 ICO）
# 只在换了 logo 需要重新生成图标时才跑。

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ico = Join-Path $here 'icons'
$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles(x86)\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $chrome) { Write-Error 'No Chrome or Edge found'; exit 1 }
New-Item -ItemType Directory -Force -Path $ico | Out-Null

# 换成你自己的 svg 路径，或者把 svg 放进 icons\ 目录
$svgs = @{
  'light' = Join-Path $ico 'cabinet-pixel-light.svg'
  'dark'  = Join-Path $ico 'cabinet-pixel-dark.svg'
}

foreach ($k in $svgs.Keys) {
  $svgPath = $svgs[$k]
  if (-not (Test-Path $svgPath)) { Write-Warning "missing $svgPath"; continue }

  $html = Join-Path $ico "$k.html"
  $svg = Get-Content $svgPath -Raw
  @"
<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden}
svg{width:256px;height:256px;display:block}
</style></head><body>$svg</body></html>
"@ | Set-Content $html -Encoding UTF8

  $png = Join-Path $ico "$k.png"
  & $chrome --headless --disable-gpu "--screenshot=$png" --window-size=256,256 `
            --default-background-color=00000000 "file:///$($html -replace '\','/')" 2>$null | Out-Null
  Write-Host "[OK] $k.png"
}

Write-Host ''
Write-Host 'PNG 已生成。转 ICO 用 Python：'
Write-Host '  python -c "..."  或见 README 里的说明'
