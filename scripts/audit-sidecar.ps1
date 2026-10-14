[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$sidecarRoot = Join-Path $projectRoot ".local\Douyin_TikTok_Download_API"
$requirements = Join-Path $sidecarRoot "requirements.txt"
$venvPython = Join-Path $sidecarRoot ".venv\Scripts\python.exe"
$auditPython = Join-Path $projectRoot ".local\audit-tools\Scripts\python.exe"
$sitePackages = Join-Path $sidecarRoot ".venv\Lib\site-packages"
. (Join-Path $PSScriptRoot "sidecar-python.ps1")

if (-not (Test-Path -LiteralPath $venvPython) -or -not (Test-Path -LiteralPath $requirements)) {
  throw "The pinned sidecar is not installed. Run setup-sidecar.ps1 first."
}

if (-not (Test-SidecarPip $venvPython)) {
  throw "The sidecar environment is missing pip. Run .\scripts\setup-sidecar.ps1 -NonInteractive to repair it, then retry the audit."
}

& $venvPython -m pip check
if ($LASTEXITCODE -ne 0) { throw "The sidecar environment has incompatible packages." }

$hasModule = (& $venvPython -c "import importlib.util; print('yes' if importlib.util.find_spec('pip_audit') else 'no')").Trim()
if ($hasModule -eq "yes") {
  & $venvPython -m pip_audit
} elseif ((Test-Path -LiteralPath $auditPython) -and (Test-SidecarPython $auditPython)) {
  & $auditPython -m pip_audit --path $sitePackages
} elseif (Get-Command uvx -ErrorAction SilentlyContinue) {
  uvx pip-audit --path $sitePackages
} elseif (Get-Command pipx -ErrorAction SilentlyContinue) {
  pipx run pip-audit --path $sitePackages
} else {
  throw "No usable pip-audit environment is available. Repair .local\audit-tools or install uv, then run 'uvx pip-audit --path $sitePackages' and retry."
}

if ($LASTEXITCODE -ne 0) {
  Write-Error "The sidecar dependency audit did not pass. Review the output above: it either reported vulnerabilities or could not reach the advisory database (offline or blocked network)." -ErrorAction Continue
  exit 1
}
