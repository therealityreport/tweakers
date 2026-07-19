$ErrorActionPreference = "Stop"

$Repo = if ($env:TWEAKER_REPO) { $env:TWEAKER_REPO } elseif ($env:CODEX_PLUSPLUS_REPO) { $env:CODEX_PLUSPLUS_REPO } else { "therealityreport/tweakers" }
$Ref = if ($env:TWEAKER_REF) { $env:TWEAKER_REF } elseif ($env:CODEX_PLUSPLUS_REF) { $env:CODEX_PLUSPLUS_REF } else { "main" }
$NewSource = Join-Path $HOME ".tweaker\source"
$LegacySource = Join-Path $HOME ".codex-plusplus\source"
$InstallDir = if ($env:TWEAKER_SOURCE_DIR) {
  $env:TWEAKER_SOURCE_DIR
} elseif ($env:CODEX_PLUSPLUS_SOURCE_DIR) {
  $env:CODEX_PLUSPLUS_SOURCE_DIR
} elseif ((Test-Path -LiteralPath $LegacySource) -and -not (Test-Path -LiteralPath $NewSource)) {
  $LegacySource
} else {
  $NewSource
}

function Fail($Message) {
  [Console]::Error.WriteLine("[!] $Message")
  [Console]::Error.WriteLine("    Paste this error into Codex if you need help.")
  exit 1
}

function Require-Command($Command, $Message) {
  if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
    Fail $Message
  }
}

Require-Command node "Node.js 20+ is required but node was not found."
Require-Command npm.cmd "npm is required to build tweaker from GitHub source."

$NodeMajorText = & node -p "Number(process.versions.node.split('.')[0])"
$NodeMajor = [int]$NodeMajorText
if ($NodeMajor -lt 20) {
  $NodeVersion = & node -v
  Fail "Node.js 20+ is required; found $NodeVersion."
}

$Work = Join-Path ([System.IO.Path]::GetTempPath()) ("tweaker." + [System.Guid]::NewGuid().ToString("N"))
$Archive = Join-Path $Work "source.zip"
$Extract = Join-Path $Work "extract"
$Next = Join-Path $Work "source"

try {
  New-Item -ItemType Directory -Force -Path $Work, $Extract | Out-Null

  $Url = "https://codeload.github.com/$Repo/zip/$Ref"
  Write-Host "Downloading tweaker from https://github.com/$Repo ($Ref)..."
  try {
    Invoke-WebRequest -Uri $Url -OutFile $Archive -UseBasicParsing
  } catch {
    Fail "Download failed from https://github.com/$Repo ($Ref). Check the repo, branch, and network connection."
  }

  try {
    Expand-Archive -Path $Archive -DestinationPath $Extract -Force
    $ExtractedRoot = Get-ChildItem -Path $Extract -Directory | Select-Object -First 1
    if (-not $ExtractedRoot) {
      Fail "Could not unpack the tweaker download."
    }
    Move-Item -Path $($ExtractedRoot.FullName) -Destination $Next
  } catch {
    Fail "Could not unpack the tweaker download."
  }

  Write-Host "Installing dependencies..."
  Push-Location $Next
  try {
    if (Test-Path "package-lock.json") {
      & npm.cmd ci --workspaces --include-workspace-root --ignore-scripts
      if ($LASTEXITCODE -ne 0) {
        [Console]::Error.WriteLine("npm ci failed; regenerating the downloaded lockfile and installing workspace dependencies.")
        Remove-Item -Force "package-lock.json"
        & npm.cmd install --workspaces --include-workspace-root --ignore-scripts
        if ($LASTEXITCODE -ne 0) {
          Fail "npm install failed while installing tweaker dependencies."
        }
      }
    } else {
      & npm.cmd install --workspaces --include-workspace-root --ignore-scripts
      if ($LASTEXITCODE -ne 0) {
        Fail "npm install failed while installing tweaker dependencies."
      }
    }
  } finally {
    Pop-Location
  }

  Write-Host "Building tweaker..."
  Push-Location $Next
  try {
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) {
      Fail "tweaker build failed."
    }
  } finally {
    Pop-Location
  }

  $InstallParent = Split-Path -Parent $InstallDir
  New-Item -ItemType Directory -Force -Path $InstallParent | Out-Null
  $Previous = "$InstallDir.previous"
  if (Test-Path $Previous) {
    Remove-Item -Recurse -Force $Previous
  }
  if (Test-Path $InstallDir) {
    Move-Item -Path $InstallDir -Destination $Previous
  }
  Move-Item -Path $Next -Destination $InstallDir

  Write-Host "Finalizing workspace links..."
  Push-Location $InstallDir
  try {
    & npm.cmd install --workspaces --include-workspace-root --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
      Fail "npm install failed while finalizing tweaker workspace links."
    }
  } finally {
    Pop-Location
  }

  Write-Host "Running installer..."
  & node (Join-Path $InstallDir "packages\installer\dist\cli.js") install @args
  if ($LASTEXITCODE -ne 0) {
    Fail "tweaker installer failed."
  }

  Write-Host ""
  Write-Host "tweaker source installed at: $InstallDir"
} finally {
  if (Test-Path $Work) {
    Remove-Item -Recurse -Force $Work
  }
}
