[CmdletBinding()]
param(
  [Nullable[int]]$Port
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sidecarRoot = Join-Path $projectRoot ".local\Douyin_TikTok_Download_API"
$venvPython = Join-Path $sidecarRoot ".venv\Scripts\python.exe"
. (Join-Path $PSScriptRoot "sidecar-python.ps1")
$sidecarEntry = Join-Path $PSScriptRoot "sidecar-entry.py"
$sidecarTokenFile = Join-Path $projectRoot ".local\sidecar-token.txt"
$settings = Get-Content -Raw (Join-Path $PSScriptRoot "local-settings.json") | ConvertFrom-Json
$sidecarPort = if ($null -ne $Port) {
  $Port
} elseif ($env:SIDECAR_PORT) {
  [int]$env:SIDECAR_PORT
} else {
  [int]$settings.sidecarPort
}
$cookieSetting = if ($env:BILIBILI_COOKIE_FILE) { $env:BILIBILI_COOKIE_FILE } else { ".local/bilibili-cookie.txt" }
$cookieFile = if ([System.IO.Path]::IsPathRooted($cookieSetting)) {
  $cookieSetting
} else {
  Join-Path $projectRoot $cookieSetting
}

if ($sidecarPort -le 0 -or $sidecarPort -ge 65536) {
  throw "SIDECAR_PORT must be an integer between 1 and 65535."
}

if (-not (Test-SidecarPython $venvPython)) {
  throw "The local feed sidecar Python 3.11 environment is missing or cannot run. Run .\scripts\setup-sidecar.ps1 first."
}

Write-Host "Starting the feed sidecar at http://127.0.0.1:$sidecarPort. Press Ctrl+C to stop."
& $venvPython $sidecarEntry --sidecar-root $sidecarRoot --cookie-file $cookieFile --token-file $sidecarTokenFile --port $sidecarPort
