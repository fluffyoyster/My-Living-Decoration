# setup.ps1 - finds Node.js (or downloads a portable copy into .\runtime),
# installs Electron + the Win32 bridge on first run, then launches the engine.
#   powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 [-DebugMode] [-NoLaunch]
param(
  [switch]$DebugMode,
  [switch]$NoLaunch
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$runtime = Join-Path $root 'runtime'
$portableNode = Join-Path $runtime 'node'

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }

# ---------------------------------------------------------------- 1. Node.js
$nodeExe = $null
if (Test-Path (Join-Path $portableNode 'node.exe')) {
  $nodeExe = Join-Path $portableNode 'node.exe'
} else {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $nodeExe = $cmd.Source }
}

if (-not $nodeExe) {
  Write-Step 'Node.js not found - downloading a portable copy into .\runtime (about 30 MB, one time)'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $base = 'https://nodejs.org/dist/latest-v22.x'
  $sums = (Invoke-WebRequest "$base/SHASUMS256.txt" -UseBasicParsing).Content
  $zipName = [regex]::Match($sums, 'node-v[\d\.]+-win-x64\.zip').Value
  if (-not $zipName) { throw 'Could not work out the Node.js download name from nodejs.org.' }
  $zipPath = Join-Path $runtime 'node.zip'
  Write-Host "    $base/$zipName"
  Invoke-WebRequest "$base/$zipName" -OutFile $zipPath -UseBasicParsing
  Unblock-File $zipPath
  Expand-Archive -Path $zipPath -DestinationPath $runtime -Force
  Remove-Item $zipPath -Force
  $extracted = Get-ChildItem $runtime -Directory | Where-Object { $_.Name -like 'node-v*-win-x64' } | Select-Object -First 1
  if (-not $extracted) { throw 'The Node.js zip did not contain the expected folder.' }
  Rename-Item -Path $extracted.FullName -NewName 'node'
  $nodeExe = Join-Path $portableNode 'node.exe'
}
$nodeDir = Split-Path -Parent $nodeExe
$env:PATH = "$nodeDir;$env:PATH"
Write-Step "Node.js $(& $nodeExe -v)  ($nodeExe)"

# ---------------------------------------------------------------- 2. dependencies
$electronExe = Join-Path $root 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $electronExe)) {
  Write-Step 'First run: installing Electron and the Win32 bridge (about 120 MB, one time)'
  $npm = Join-Path $nodeDir 'npm.cmd'
  if (-not (Test-Path $npm)) { $npm = 'npm' }
  & $npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit code $LASTEXITCODE). Check your internet connection and run again." }
  if (-not (Test-Path $electronExe)) { throw 'npm finished but Electron did not download. Run start.bat again.' }
}

# ---------------------------------------------------------------- 3. launch
if ($NoLaunch) { Write-Step 'Setup complete.'; exit 0 }

if ($DebugMode) {
  Write-Step 'Starting in debug mode - the engine log appears below. Close this window to stop.'
  $env:WE_DEBUG = '1'
  & $electronExe "$root" --we-debug
} else {
  Write-Step 'Starting the wallpaper engine. It lives in the tray (right-click the icon to pause or quit).'
  Start-Process -FilePath $electronExe -ArgumentList "`"$root`"" -WorkingDirectory $root
}
