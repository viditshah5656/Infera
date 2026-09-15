$ErrorActionPreference = "Stop"
$repo = "https://github.com/viditshah5656/Infera"
$zipUrl = "$repo/archive/refs/heads/main.zip"
$root = Join-Path $env:LOCALAPPDATA "Infera"
$tmp = Join-Path $env:TEMP ("Infera-" + [guid]::NewGuid().ToString())
$zip = "$tmp.zip"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Python 3 is required. Install Python first." }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 18+ is required. Install Node.js first." }
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Invoke-WebRequest -Uri $zipUrl -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like 'Infera-*' } | Select-Object -First 1
New-Item -ItemType Directory -Force -Path $root | Out-Null
Copy-Item -Path (Join-Path $src.FullName '*') -Destination $root -Recurse -Force
Push-Location $root
try {
  if (-not (Test-Path "$root\config.json")) { Copy-Item "$root\config.example.json" "$root\config.json" }
  if (-not (Test-Path "$root\.venv\Scripts\python.exe")) { python -m venv .venv }
  $py = "$root\.venv\Scripts\python.exe"
  & $py -m pip install --upgrade pip
  & $py -m pip install "httpx>=0.27.0"
  & $py -m pip install -r "$root\reverse-chatgpt\requirements.txt"
  npm install
  npm --prefix "$root\qwen2api" install
  Start-Process -FilePath $py -ArgumentList "gemini_web2api.py --port 8082" -WorkingDirectory $root
  Start-Process -FilePath $py -ArgumentList "-m uvicorn app:app --app-dir reverse-chatgpt --host 127.0.0.1 --port 5000" -WorkingDirectory $root
  Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory "$root\qwen2api"
  Start-Process -FilePath "npm.cmd" -ArgumentList "run router" -WorkingDirectory $root
  Start-Sleep -Seconds 5
  Start-Process "https://viditshah5656.github.io/Infera/"
} finally {
  Pop-Location
  Remove-Item -LiteralPath $tmp -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
}
