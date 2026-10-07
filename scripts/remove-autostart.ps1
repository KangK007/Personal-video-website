$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
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
$startupFolder = [Environment]::GetFolderPath([Environment+SpecialFolder]::Startup)
$shortcutPath = Join-Path $startupFolder "$taskName.lnk"
if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
    Write-Host "No login startup shortcut found for this project: $shortcutPath"
    exit 0
}

Remove-Item -LiteralPath $shortcutPath -Force
Write-Host "Login startup shortcut removed: $shortcutPath"
Write-Host "The running website is unchanged. Run npm run stop:local to stop it."
