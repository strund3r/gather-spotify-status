# SPDX-License-Identifier: GPL-3.0-or-later
# Install gather-spotify-status from GitHub Releases after verifying SHA256SUMS.

# Wrap in a child scope so "irm ... | iex" does not leak variables, functions,
# or preference settings ($ErrorActionPreference, $ProgressPreference) into
# the caller's interactive PowerShell session.
& {
  Set-StrictMode -Version Latest
  $ErrorActionPreference = "Stop"
  # Suppress per-chunk progress bars in Windows PowerShell 5.1 so downloads run at full speed.
  $ProgressPreference = "SilentlyContinue"

  # PowerShell 5.1 defaults to older SSL/TLS protocols; enable TLS 1.2 for GitHub.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  # ---------------------------------------------------------------------------
  # Configuration & environment overrides (GSS_* vars are primarily for
  # CI/tests or custom install locations/versions)
  # ---------------------------------------------------------------------------
  $AppName = "gather-spotify-status"
  $Repo = if ($env:GSS_REPO) { $env:GSS_REPO } else { "strund3r/gather-spotify-status" }
  $ApiBase = if ($env:GSS_GITHUB_API) { $env:GSS_GITHUB_API } else { "https://api.github.com" }
  $ReleaseBase = if ($env:GSS_RELEASE_BASE) { $env:GSS_RELEASE_BASE } else { "https://github.com" }
  $LocalAppData = if ($env:LOCALAPPDATA) { $env:LOCALAPPDATA } else { Join-Path $HOME "AppData\Local" }
  $InstallDir = if ($env:GSS_INSTALL_DIR) { $env:GSS_INSTALL_DIR } else { Join-Path $LocalAppData "Programs\$AppName" }
  # Prefer WOW64 real architecture when launched from a 32-bit PowerShell host.
  $Arch = if ($env:GSS_ARCH) { $env:GSS_ARCH } elseif ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $Version = $env:GSS_VERSION

  # Guard against malformed owner/repo strings before interpolating into URLs.
  if ($Repo -notmatch '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$') {
    throw "Invalid repository name: $Repo"
  }

  # Require HTTPS in normal usage; only allow loopback HTTP when mock endpoints
  # are explicitly injected via GSS_GITHUB_API / GSS_RELEASE_BASE.
  function Test-TrustedBaseUrl([string]$Url) {
    $Uri = [Uri]$Url
    $IsLoopback = ($Uri.Scheme -eq "http") -and ($Uri.Host -in @("127.0.0.1", "localhost")) -and ($env:GSS_GITHUB_API -or $env:GSS_RELEASE_BASE)
    if (-not ($Uri.Scheme -eq "https" -or $IsLoopback)) {
      throw "Insecure URL scheme: $Url"
    }
  }

  Test-TrustedBaseUrl $ApiBase
  Test-TrustedBaseUrl $ReleaseBase

  if ($Arch -notmatch '^(AMD64|x64)$') {
    throw "Unsupported architecture: $Arch (only windows-x64 is supported)"
  }

  # ---------------------------------------------------------------------------
  # Release version resolution & strict SemVer check
  # ---------------------------------------------------------------------------
  $Headers = @{ "User-Agent" = $AppName }
  if (-not $Version) {
    $ApiHeaders = @{ "User-Agent" = $AppName; "Accept" = "application/vnd.github+json" }
    $Release = Invoke-RestMethod -Uri "$($ApiBase.TrimEnd('/'))/repos/$Repo/releases/latest" -Headers $ApiHeaders
    $TagName = if ($null -ne $Release -and $Release.PSObject.Properties["tag_name"]) { [string]$Release.tag_name } else { "" }
    $Version = $TagName -replace '^v', ''
  } else {
    $Version = $Version -replace '^v', ''
  }

  # Reject pre-release/malformed tags or path-traversal attempts before constructing URLs.
  if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Invalid or missing release version: $Version"
  }

  # ---------------------------------------------------------------------------
  # Download SHA256SUMS + binary, verify SHA-256, and install atomically
  # ---------------------------------------------------------------------------
  $TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("gss-install-" + [System.Guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null

  try {
    $Asset = "$AppName-v$Version-windows-x64.exe"
    $DownloadBase = "$($ReleaseBase.TrimEnd('/'))/$Repo/releases/download/v$Version"
    $SumsPath = Join-Path $TempDir "SHA256SUMS"
    $AssetPath = Join-Path $TempDir $Asset

    Write-Host "Downloading $AppName v$Version (windows-x64)..."
    Invoke-WebRequest -Uri "$DownloadBase/SHA256SUMS" -OutFile $SumsPath -Headers $Headers -UseBasicParsing
    Invoke-WebRequest -Uri "$DownloadBase/$Asset" -OutFile $AssetPath -Headers $Headers -UseBasicParsing

    # Parse expected SHA-256 (supports both "<hash>  <file>" and "<hash> *<file>").
    $ExpectedHash = $null
    foreach ($Line in (Get-Content -Path $SumsPath)) {
      if ($Line.Trim() -match '^([0-9a-fA-F]{64})\s+\*?(.+)$') {
        if ($Matches[2].Trim() -eq $Asset) {
          $ExpectedHash = $Matches[1].ToLowerInvariant()
          break
        }
      }
    }
    if (-not $ExpectedHash) {
      throw "Could not find SHA-256 entry for $Asset in SHA256SUMS"
    }

    $ActualHash = (Get-FileHash -Path $AssetPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($ActualHash -ne $ExpectedHash) {
      throw "Checksum verification failed for $Asset (expected $ExpectedHash, got $ActualHash)"
    }

    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    $Target = Join-Path $InstallDir "$AppName.exe"
    $Staged = "$Target.new"
    $Backup = "$Target.old"

    # Stage first and swap; Windows allows renaming an existing .exe to .old even
    # when upgrading a running copy, and we roll back .old if the swap fails.
    Copy-Item -Path $AssetPath -Destination $Staged -Force
    $MovedToBackup = $false
    try {
      if (Test-Path -LiteralPath $Target) {
        if (Test-Path -LiteralPath $Backup) {
          Remove-Item -LiteralPath $Backup -Force -ErrorAction SilentlyContinue
        }
        Move-Item -LiteralPath $Target -Destination $Backup -Force
        $MovedToBackup = $true
      }
      Move-Item -LiteralPath $Staged -Destination $Target -Force
    } catch {
      if ($MovedToBackup -and (Test-Path -LiteralPath $Backup) -and -not (Test-Path -LiteralPath $Target)) {
        try {
          Move-Item -LiteralPath $Backup -Destination $Target -Force
        } catch {
          # best-effort rollback
        }
      }
      throw
    }

    Write-Host "Installed $AppName v$Version to $Target"
  } finally {
    Remove-Item -LiteralPath $TempDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  # ---------------------------------------------------------------------------
  # Persist $InstallDir to the User Path and update the active shell session
  # (skipped when GSS_SKIP_PATH=1)
  # ---------------------------------------------------------------------------
  if ($env:GSS_SKIP_PATH -ne "1") {
    $NormalizedDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\').ToLowerInvariant()
    $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if (-not $UserPath) { $UserPath = "" }
    $UserEntries = @($UserPath -split ';' | Where-Object { $_ -and $_.Trim() })
    $InUserPath = $false
    foreach ($Entry in $UserEntries) {
      try {
        if ([System.IO.Path]::GetFullPath($Entry.Trim()).TrimEnd('\').ToLowerInvariant() -eq $NormalizedDir) {
          $InUserPath = $true
          break
        }
      } catch {
        # skip invalid PATH entry
      }
    }
    if (-not $InUserPath) {
      $NewUserPath = if ($UserPath.TrimEnd(';')) { "$($UserPath.TrimEnd(';'));$InstallDir" } else { $InstallDir }
      [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
      Write-Host "Added $InstallDir to your user PATH (open a new terminal to use it)."
    }

    # Also expose the binary in the current PowerShell session immediately.
    $SessionPath = if ($env:Path) { $env:Path } else { "" }
    $SessionEntries = @($SessionPath -split ';' | Where-Object { $_ -and $_.Trim() })
    $InSessionPath = $false
    foreach ($Entry in $SessionEntries) {
      try {
        if ([System.IO.Path]::GetFullPath($Entry.Trim()).TrimEnd('\').ToLowerInvariant() -eq $NormalizedDir) {
          $InSessionPath = $true
          break
        }
      } catch {
        # skip invalid PATH entry
      }
    }
    if (-not $InSessionPath) {
      $env:Path = if ($SessionPath.TrimEnd(';')) { "$($SessionPath.TrimEnd(';'));$InstallDir" } else { $InstallDir }
    }
  }

  Write-Host "Run `"$AppName`" to get started."
}
