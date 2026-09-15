$ErrorActionPreference = "Stop"
$repo = "https://github.com/viditshah5656/Infera"
$zipUrl = "$repo/archive/refs/heads/main.zip"
$root = Join-Path $env:LOCALAPPDATA "Infera"
$tmp = Join-Path $env:TEMP ("Infera-" + [guid]::NewGuid().ToString())
$zip = "$tmp.zip"

Write-Host "Infera — local-first installer" -ForegroundColor Cyan
Write-Host "Install location: $root"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Python 3 is required. Install Python from python.org and run this installer again." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ is required. Install Node.js from nodejs.org and run this installer again." }
if (-not (Get-Command npm -ErrorAction SilentlyContinue)) { throw "npm is required with Node.js." }

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Write-Host "Downloading latest Infera package..." -ForegroundColor Yellow
Invoke-WebRequest -Uri $zipUrl -OutFile $zip

Write-Host "Extracting..." -ForegroundColor Yellow
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'Infera-*' } | Select-Object -First 1
if (-not $src) { throw "Could not find extracted Infera directory." }

New-Item -ItemType Directory -Force -Path $root | Out-Null
Copy-Item -Path (Join-Path $src.FullName '*') -Destination $root -Recurse -Force

Push-Location $root
try {
  if (-not (Test-Path "$root\config.json")) { Copy-Item "$root\config.example.json" "$root\config.json" }
  if (-not (Test-Path "$root\.venv\Scripts\python.exe")) {
    Write-Host "Creating Python environment..." -ForegroundColor Yellow
    python -m venv .venv
  }
  $py = "$root\.venv\Scripts\python.exe"
  Write-Host "Installing Python runtime..." -ForegroundColor Yellow
  & $py -m pip install --upgrade pip | Out-Host
  & $py -m pip install "httpx>=0.27.0" | Out-Host
  if (Test-Path "$root\reverse-chatgpt\requirements.txt") { & $py -m pip install -r "$root\reverse-chatgpt\requirements.txt" | Out-Host }

  Write-Host "Installing Node dependencies..." -ForegroundColor Yellow
  npm install | Out-Host
  if (Test-Path "$root\qwen2api\package.json") { npm --prefix "$root\qwen2api" install | Out-Host }

  $launcher = @'
$ErrorActionPreference = "Continue"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$py = Join-Path $root ".venv\Scripts\python.exe"
$localUrl = "http://127.0.0.1:8081"

# If the local gateway is already running, do not spawn duplicate services.
try {
  Invoke-WebRequest -Uri "$localUrl/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
  Start-Process "$localUrl/chat"
  exit 0
} catch {}

Start-Process -FilePath $py -ArgumentList "gemini_web2api.py --port 8082" -WorkingDirectory $root
Start-Process -FilePath $py -ArgumentList "-m uvicorn app:app --app-dir reverse-chatgpt --host 127.0.0.1 --port 5000" -WorkingDirectory $root
Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory (Join-Path $root "qwen2api")
Start-Process -FilePath "npm.cmd" -ArgumentList "run router" -WorkingDirectory $root

# Give the router a moment to bind, then open the local chat workspace.
for ($i = 0; $i -lt 30; $i++) {
  Start-Sleep -Milliseconds 500
  try {
    Invoke-WebRequest -Uri "$localUrl/health" -UseBasicParsing -TimeoutSec 2 | Out-Null
    Start-Process "$localUrl/chat"
    exit 0
  } catch {}
}

Start-Process "https://viditshah5656.github.io/Infera/"
'@
  Set-Content -Path "$root\Start-Infera.ps1" -Value $launcher -Encoding UTF8
  $cmd = '@echo off
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Infera.ps1" %*
'
  Set-Content -Path "$root\Start-Infera.cmd" -Value $cmd -Encoding ASCII

  # Register a private local URL scheme so the public Infera website can start
  # the local gateway without requiring a repository clone.
  $protocolRoot = "HKCU:\Software\Classes\infera"
  New-Item -Path $protocolRoot -Force | Out-Null
  Set-ItemProperty -Path $protocolRoot -Name '(default)' -Value 'URL:Infera Local Launcher'
  New-ItemProperty -Path $protocolRoot -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  New-Item -Path "$protocolRoot\shell\open\command" -Force | Out-Null
  $handler = "`"$root\Start-Infera.cmd`" `%1"
  Set-ItemProperty -Path "$protocolRoot\shell\open\command" -Name '(default)' -Value $handler

  Write-Host "Infera installed successfully." -ForegroundColor Green
  Write-Host "Local launcher: $root\Start-Infera.cmd" -ForegroundColor Cyan
  Write-Host "Protocol: infera://start" -ForegroundColor Cyan
  Write-Host "Gateway: http://127.0.0.1:8081" -ForegroundColor Cyan
  Start-Process "$root\Start-Infera.cmd"
} finally {
  Pop-Location
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}
