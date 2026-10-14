[CmdletBinding()]
param(
  [switch]$SkipInstall,
  [string]$DouyinCookieFile,
  [string]$BilibiliCookieFile,
  [switch]$NonInteractive,
  [switch]$RotateToken
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$localRoot = Join-Path $projectRoot ".local"
$sidecarRoot = Join-Path $localRoot "Douyin_TikTok_Download_API"
$venvDirectory = Join-Path $sidecarRoot ".venv"
$venvPython = Join-Path $venvDirectory "Scripts\python.exe"
. (Join-Path $PSScriptRoot "sidecar-python.ps1")
$repositoryUrl = "https://github.com/Evil0ctal/Douyin_TikTok_Download_API.git"
$sidecarCommit = "42784ffc83a72a516bfe952153ad7e2a3998d16c"
$settings = Get-Content -Raw (Join-Path $PSScriptRoot "local-settings.json") | ConvertFrom-Json
$sidecarPort = [int]$settings.sidecarPort

function Assert-LastCommand([string]$message) {
  if ($LASTEXITCODE -ne 0) {
    throw $message
  }
}

function Write-Utf8File([string]$path, [string]$content) {
  [System.IO.File]::WriteAllText(
    $path,
    $content,
    [System.Text.UTF8Encoding]::new($false)
  )
}

function Protect-SecretFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    return
  }
  $resolvedPath = (Resolve-Path -LiteralPath $path).Path
  $currentIdentity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
  & icacls.exe $resolvedPath /inheritance:r /grant:r "${currentIdentity}:(F)" "*S-1-5-18:(F)" | Out-Null
  Assert-LastCommand "Could not restrict access to $resolvedPath."
}

function Get-OrCreateSidecarToken([string]$path, [switch]$Rotate) {
  if (-not $Rotate -and (Test-Path -LiteralPath $path -PathType Leaf)) {
    $value = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $path)).Trim()
  } else {
    $bytes = [byte[]]::new(32)
    $generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try {
      $generator.GetBytes($bytes)
    } finally {
      $generator.Dispose()
    }
    $value = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    Write-Utf8File $path $value
  }
  if ($value.Length -lt 32 -or $value.Contains("`r") -or $value.Contains("`n")) {
    throw "The sidecar token file must contain one value with at least 32 characters."
  }
  Protect-SecretFile $path
  return $value
}

function Set-YamlScalar([string]$path, [string]$key, [string]$value) {
  $content = [System.IO.File]::ReadAllText($path)
  $pattern = "(?m)^(\s*)" + [regex]::Escape($key) + "\s*:.*$"
  $regex = [regex]::new($pattern)
  if (-not $regex.IsMatch($content)) {
    throw "Missing config key '$key' in $path."
  }
  $updated = $regex.Replace(
    $content,
    [System.Text.RegularExpressions.MatchEvaluator]{
      param($match)
      return "$($match.Groups[1].Value)$key`: $value"
    },
    1
  )
  Write-Utf8File $path $updated
}

function Set-CookieValue([string]$path, [string]$value, [string]$keyName) {
  $content = [System.IO.File]::ReadAllText($path)
  $regex = [regex]::new('(?mi)^(\s*)[''"]?cookie[''"]?\s*:.*$')
  if (-not $regex.IsMatch($content)) {
    throw "Missing Cookie setting in $path."
  }
  $quotedValue = "'" + $value.Replace("'", "''") + "'"
  $updated = $regex.Replace(
    $content,
    [System.Text.RegularExpressions.MatchEvaluator]{
      param($match)
      return "$($match.Groups[1].Value)$keyName`: $quotedValue"
    },
    1
  )
  Write-Utf8File $path $updated
}

function Set-EnvValue([string]$path, [string]$name, [string]$value) {
  $content = if (Test-Path -LiteralPath $path) {
    [System.IO.File]::ReadAllText($path)
  } else {
    ""
  }
  $line = "$name=$value"
  $regex = [regex]::new("(?m)^" + [regex]::Escape($name) + "=.*$")
  if ($regex.IsMatch($content)) {
    $content = $regex.Replace($content, $line, 1)
  } else {
    if ($content.Length -gt 0 -and -not $content.EndsWith([Environment]::NewLine)) {
      $content += [Environment]::NewLine
    }
    $content += $line + [Environment]::NewLine
  }
  Write-Utf8File $path $content
}

function Read-SecretText([string]$prompt) {
  $secureValue = Read-Host $prompt -AsSecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Get-CookieText([string]$path, [string]$prompt) {
  if ($path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Cookie file does not exist: $path"
    }
    $value = [System.IO.File]::ReadAllText((Resolve-Path -LiteralPath $path)).Trim()
  } elseif ($NonInteractive) {
    return ""
  } else {
    $value = Read-SecretText $prompt
  }
  if ($value.Length -gt 32768 -or $value.Contains("`r") -or $value.Contains("`n")) {
    throw "$prompt must be a single line no larger than 32 KB."
  }
  return $value
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git was not found. Install Git for Windows first."
}
New-Item -ItemType Directory -Path $localRoot -Force | Out-Null
if (-not (Test-Path -LiteralPath (Join-Path $sidecarRoot ".git"))) {
  if (Test-Path -LiteralPath $sidecarRoot) {
    throw "$sidecarRoot exists but is not a complete Git repository. Inspect it before retrying."
  }
  Write-Host "Downloading the local feed sidecar..."
  git clone --depth 1 --no-checkout $repositoryUrl $sidecarRoot
  Assert-LastCommand "Could not download the feed sidecar. Check the network and retry."
  git -C $sidecarRoot fetch --depth 1 origin $sidecarCommit
  Assert-LastCommand "Could not download the pinned sidecar revision."
  git -C $sidecarRoot checkout --detach $sidecarCommit
  Assert-LastCommand "Could not check out the pinned sidecar revision."
}

$currentSidecarCommit = (git -C $sidecarRoot rev-parse HEAD).Trim()
Assert-LastCommand "Could not identify the installed sidecar revision."
if ($currentSidecarCommit -ne $sidecarCommit) {
  throw "Unsupported sidecar revision $currentSidecarCommit. Expected $sidecarCommit."
}

$rebuildVenv = -not (Test-SidecarPython $venvPython)
if (-not $rebuildVenv -and -not (Test-SidecarPip $venvPython)) {
  if (Test-SidecarEnsurePip $venvPython) {
    Write-Host "Restoring pip in the existing sidecar Python environment..."
    & $venvPython -m ensurepip --upgrade
    if ($LASTEXITCODE -ne 0 -or -not (Test-SidecarPip $venvPython)) {
      Write-Host "The existing environment could not restore pip; replacing it..."
      $rebuildVenv = $true
    }
  } else {
    $rebuildVenv = $true
  }
}

if ($rebuildVenv) {
  if ($SkipInstall) {
    throw "The sidecar Python 3.11 environment is missing or cannot run. Retry without -SkipInstall to rebuild it."
  }
  $basePython = Get-Python311
  if (Test-Path -LiteralPath $venvDirectory) {
    $venvItem = Get-Item -LiteralPath $venvDirectory -Force
    $expectedPath = [System.IO.Path]::GetFullPath((Join-Path $sidecarRoot ".venv"))
    if (-not $venvItem.PSIsContainer `
      -or ($venvItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) `
      -or -not [string]::Equals($venvItem.FullName, $expectedPath, [StringComparison]::OrdinalIgnoreCase) `
      -or -not (Test-Path -LiteralPath (Join-Path $venvDirectory "pyvenv.cfg") -PathType Leaf)) {
      throw "The existing .venv is not a regular Python virtual environment. Inspect it before retrying."
    }
    Write-Host "Replacing the unusable sidecar Python environment..."
    Remove-Item -LiteralPath $venvItem.FullName -Recurse -Force
  }
  Write-Host "Creating an isolated Python 3.11 environment..."
  & $basePython -m venv $venvDirectory
  Assert-LastCommand "Could not create the Python virtual environment."
  if (-not (Test-SidecarPython $venvPython)) {
    throw "The new sidecar environment cannot run Python 3.11."
  }
}

if (-not $SkipInstall) {
  Write-Host "Installing sidecar dependencies. This can take a few minutes..."
  & $venvPython -m pip install --upgrade pip
  Assert-LastCommand "Could not update pip."
  & $venvPython -m pip install -r (Join-Path $sidecarRoot "requirements.txt")
  Assert-LastCommand "Could not install the sidecar dependencies."
}

# The validated security overlay is mandatory even when the slower base install is skipped.
& $venvPython -m pip install --upgrade -r (Join-Path $PSScriptRoot "sidecar-security-requirements.txt")
Assert-LastCommand "Could not install the validated sidecar security updates."
& $venvPython -m pip check
Assert-LastCommand "The updated sidecar dependencies are incompatible."

$rootConfig = Join-Path $sidecarRoot "config.yaml"
$douyinConfig = Join-Path $sidecarRoot "crawlers\douyin\web\config.yaml"
$douyinCookiePath = Join-Path $localRoot "douyin-cookie.txt"
$bilibiliCookiePath = Join-Path $localRoot "bilibili-cookie.txt"
$sidecarTokenPath = Join-Path $localRoot "sidecar-token.txt"
$sidecarToken = Get-OrCreateSidecarToken $sidecarTokenPath -Rotate:$RotateToken

Set-YamlScalar $rootConfig "PyWebIO_Enable" "false"
Set-YamlScalar $rootConfig "Host_IP" "127.0.0.1"
Set-YamlScalar $rootConfig "Host_Port" ([string]$sidecarPort)
Set-YamlScalar $rootConfig "Download_Switch" "false"

& $venvPython (Join-Path $PSScriptRoot "migrate-bilibili-cookie.py") `
  --sidecar-root $sidecarRoot `
  --cookie-file $bilibiliCookiePath `
  --token-file $sidecarTokenPath `
  --entry (Join-Path $PSScriptRoot "sidecar-entry.py") `
  --port $sidecarPort
Assert-LastCommand "Could not safely migrate the legacy Bilibili Cookie."

Write-Host "Provide cookies from your own signed-in browser. Interactive input stays hidden."
$douyinCookie = Get-CookieText $DouyinCookieFile "Douyin Cookie"
$bilibiliCookie = Get-CookieText $BilibiliCookieFile "Bilibili Cookie"

if ($douyinCookie.Length -gt 0) {
  Write-Utf8File $douyinCookiePath $douyinCookie
}
# Douyin is read by the browser adapter; do not duplicate its credential in the third-party service.
Set-CookieValue $douyinConfig "" "Cookie"
if ($bilibiliCookie.Length -gt 0) {
  Write-Utf8File $bilibiliCookiePath $bilibiliCookie
}
Protect-SecretFile $douyinCookiePath
Protect-SecretFile $bilibiliCookiePath

$environmentPath = Join-Path $projectRoot ".env.local"
Set-EnvValue $environmentPath "FEED_SIDECAR_URL" "http://127.0.0.1:$sidecarPort"
Set-EnvValue $environmentPath "DOUYIN_COOKIE_FILE" ".local/douyin-cookie.txt"
Set-EnvValue $environmentPath "BILIBILI_COOKIE_FILE" ".local/bilibili-cookie.txt"
Set-EnvValue $environmentPath "FEED_SIDECAR_TOKEN" $sidecarToken
Protect-SecretFile $environmentPath

Write-Host ""
Write-Host "The local feed sidecar is ready."
Write-Host "1. Open PowerShell and run: .\scripts\start-sidecar.ps1"
Write-Host "2. Open another PowerShell and run: npm run dev"
Write-Host "3. Open http://127.0.0.1:3000 and sync the feed."
