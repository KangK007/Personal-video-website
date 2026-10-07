$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$launcherPath = Join-Path $projectRoot "scripts\launch-local.mjs"
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = & $nodePath --version
$canonicalProjectRoot = [System.IO.Path]::GetFullPath($projectRoot).TrimEnd([char[]]@('\', '/')).ToLowerInvariant()
$hasher = [Security.Cryptography.SHA256]::Create()
try {
    $projectHash = [BitConverter]::ToString(
        $hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonicalProjectRoot))
    ).Replace("-", "").Substring(0, 10).ToLowerInvariant()
} finally {
    $hasher.Dispose()
}
$taskName = "JustFollowFeedLocal-$projectHash"
$settingsPath = Join-Path $projectRoot "scripts\local-settings.json"
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$appPortCandidate = [Environment]::GetEnvironmentVariable("APP_PORT", "Process")
if ([string]::IsNullOrEmpty($appPortCandidate)) {
    $appPortCandidate = [Environment]::GetEnvironmentVariable("APP_PORT", "User")
}
if ([string]::IsNullOrEmpty($appPortCandidate)) {
    $appPortCandidate = [Environment]::GetEnvironmentVariable("APP_PORT", "Machine")
}
if ([string]::IsNullOrEmpty($appPortCandidate)) {
    $appPortCandidate = [string]$settings.appPort
}
$appPortText = [string]$appPortCandidate
$appPort = 0
if ($appPortText -notmatch '\A[0-9]+\z' -or -not [int]::TryParse($appPortText, [ref]$appPort)) {
    throw "APP_PORT must be a decimal integer between 1 and 65535; found '$appPortText'"
}

if ($nodeVersion -notmatch "^v24\.") {
    throw "Node.js 24 is required for the startup task; found $nodeVersion"
}
if ($appPort -lt 1 -or $appPort -gt 65535) {
    throw "APP_PORT must be an integer between 1 and 65535; found $appPort"
}
if (-not (Test-Path -LiteralPath $launcherPath -PathType Leaf)) {
    throw "Local launcher not found: $launcherPath"
}

$startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
if (-not $startupFolder) {
    throw "Cannot locate the current user's Windows Startup folder."
}

New-Item -ItemType Directory -Path $startupFolder -Force | Out-Null
$shortcutPath = Join-Path $startupFolder "$taskName.lnk"

$previousProcessAppPort = [Environment]::GetEnvironmentVariable("APP_PORT", "Process")
try {
    [Environment]::SetEnvironmentVariable("APP_PORT", [string]$appPort, "Process")
    Start-Process `
        -FilePath $nodePath `
        -ArgumentList "`"$launcherPath`"" `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden
} finally {
    [Environment]::SetEnvironmentVariable("APP_PORT", $previousProcessAppPort, "Process")
}

$healthUrl = "http://127.0.0.1:$appPort/api/health"
$deadline = (Get-Date).AddMinutes(6)
$ready = $false
while ((Get-Date) -lt $deadline) {
    try {
        $health = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 2
        if ($health.ok -eq $true) {
            $ready = $true
            break
        }
    } catch {
        Start-Sleep -Seconds 2
    }
}

if (-not $ready) {
    throw "The website did not become ready; the existing login startup shortcut was left unchanged. Check .local\runtime\app-error.log and app.log."
}

$nodeLiteral = "'" + $nodePath.Replace("'", "''") + "'"
$launcherLiteral = "'" + $launcherPath.Replace("'", "''") + "'"
$loginLauncherContent = @"
`$ErrorActionPreference = "Stop"
`$env:APP_PORT = "$appPort"
& $nodeLiteral $launcherLiteral
exit `$LASTEXITCODE
"@
$loginLauncherEncoding = [Text.UTF8Encoding]::new($true)
$localRoot = Join-Path $projectRoot ".local"
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
$wrapperHasher = [Security.Cryptography.SHA256]::Create()
try {
    $wrapperHash = [BitConverter]::ToString(
        $wrapperHasher.ComputeHash($loginLauncherEncoding.GetBytes($loginLauncherContent))
    ).Replace("-", "").Substring(0, 12).ToLowerInvariant()
} finally {
    $wrapperHasher.Dispose()
}
$loginLauncherPath = Join-Path $localRoot "autostart-$projectHash-$wrapperHash.ps1"
[System.IO.File]::WriteAllText($loginLauncherPath, $loginLauncherContent, $loginLauncherEncoding)

$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$temporaryShortcutPath = Join-Path $startupFolder "$taskName.$PID.tmp.lnk"
$backupShortcutPath = Join-Path $startupFolder "$taskName.$PID.backup"
try {
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($temporaryShortcutPath)
    $shortcut.TargetPath = $powershellPath
    $shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$loginLauncherPath`""
    $shortcut.WorkingDirectory = $projectRoot
    $shortcut.WindowStyle = 7
    $shortcut.Description = "Starts the local Just Follow Feed website after this Windows user signs in."
    $shortcut.Save()

    if ([System.IO.File]::Exists($shortcutPath)) {
        [System.IO.File]::Replace($temporaryShortcutPath, $shortcutPath, $backupShortcutPath)
        if ([System.IO.File]::Exists($backupShortcutPath)) {
            Remove-Item -LiteralPath $backupShortcutPath -Force -ErrorAction SilentlyContinue
        }
    } else {
        [System.IO.File]::Move($temporaryShortcutPath, $shortcutPath)
    }
} catch {
    if ([System.IO.File]::Exists($backupShortcutPath) -and -not [System.IO.File]::Exists($shortcutPath)) {
        [System.IO.File]::Move($backupShortcutPath, $shortcutPath)
    }
    throw
} finally {
    if ([System.IO.File]::Exists($temporaryShortcutPath)) {
        Remove-Item -LiteralPath $temporaryShortcutPath -Force
    }
}

Write-Host "Login startup shortcut installed and running: $shortcutPath"
Write-Host "Local website: http://127.0.0.1:$appPort"
Write-Host "Personal backup directory: $(Join-Path $projectRoot '.local\personal-data\backups')"
