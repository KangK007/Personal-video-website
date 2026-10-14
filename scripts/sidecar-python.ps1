function Test-SidecarPython([string]$PythonPath) {
  if (-not (Test-Path -LiteralPath $PythonPath -PathType Leaf)) {
    return $false
  }
  try {
    $version = & $PythonPath -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
    return $LASTEXITCODE -eq 0 -and ([string]$version).Trim() -eq "3.11"
  } catch {
    return $false
  }
}

function Test-SidecarModule([string]$PythonPath, [string]$ModuleName) {
  if (-not (Test-SidecarPython $PythonPath)) {
    return $false
  }
  try {
    & $PythonPath -m $ModuleName --version 2>$null | Out-Null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Test-SidecarPip([string]$PythonPath) {
  return Test-SidecarModule $PythonPath "pip"
}

function Test-SidecarEnsurePip([string]$PythonPath) {
  return Test-SidecarModule $PythonPath "ensurepip"
}

function Get-Python311 {
  $python = Get-Command python -ErrorAction SilentlyContinue
  if ($python -and (Test-SidecarPython $python.Source)) {
    return $python.Source
  }
  if ($env:LOCALAPPDATA) {
    $standardInstall = Join-Path $env:LOCALAPPDATA "Programs\Python\Python311\python.exe"
    if (Test-SidecarPython $standardInstall) {
      return $standardInstall
    }
  }
  $uv = Get-Command uv -ErrorAction SilentlyContinue
  if ($uv) {
    try {
      $candidate = & $uv.Source python find --managed-python 3.11 2>$null
      if ($LASTEXITCODE -eq 0) {
        $candidate = [string]($candidate | Select-Object -First 1)
        if (Test-SidecarPython $candidate) {
          return $candidate
        }
      }
    } catch {
      # An unavailable uv installation is handled by the actionable error below.
    }
  }
  throw "Python 3.11 was not found. Install it or run 'uv python install 3.11', then retry."
}
