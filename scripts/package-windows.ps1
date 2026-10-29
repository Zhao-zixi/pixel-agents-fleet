# Windows x64 portable release. Run from a trusted checkout with Node.js 22 installed.
param([switch]$SkipBuild)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$Root = Split-Path $PSScriptRoot -Parent
Push-Location $Root
$Temp = Join-Path ([IO.Path]::GetTempPath()) ('pixel fleet ' + [guid]::NewGuid())
try {
    if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Build this package on Windows x64.' }
    $NodeVersion = (& node -p 'process.versions.node').Trim()
    $Arch = (& node -p 'process.arch').Trim()
    if ($LASTEXITCODE -ne 0 -or $Arch -ne 'x64' -or $NodeVersion.Split('.')[0] -ne '22') { throw 'Node.js 22 x64 is required.' }
    if (-not $SkipBuild) {
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
        & npm.cmd run package
        if ($LASTEXITCODE -ne 0) { throw 'Build failed' }
    }
    $Version = (Get-Content package.json -Raw | ConvertFrom-Json).version
    $Name = "pixel-agents-fleet-$Version-windows-x64"
    $Bundle = Join-Path $Temp $Name
    $App = Join-Path $Bundle 'app'
    New-Item -ItemType Directory -Force $App | Out-Null
    foreach ($File in @('package.json', 'package-lock.json', 'LICENSE', 'README.md', 'README.fleet.zh-CN.md', 'fleet.example.json', 'icon.png')) {
        Copy-Item (Join-Path $Root $File) $App
    }
    Copy-Item (Join-Path $Root 'dist') $App -Recurse
    Copy-Item (Join-Path $Root 'docs') (Join-Path $Bundle 'docs') -Recurse
    & node scripts/collect-release-licenses.mjs $Bundle
    if ($LASTEXITCODE -ne 0) { throw 'License collection failed' }
    # Keep locked production dependencies; exclude dev dependencies, lifecycle scripts and workspaces.
    Push-Location $App
    try {
        & npm.cmd ci --omit=dev --ignore-scripts --workspaces=false --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Production dependency installation failed' }
    } finally { Pop-Location }
    $Base = "https://nodejs.org/dist/v$NodeVersion"
    $RuntimeName = "node-v$NodeVersion-win-x64.zip"
    $RuntimeZip = Join-Path $Temp $RuntimeName
    Invoke-WebRequest "$Base/$RuntimeName" -UseBasicParsing -OutFile $RuntimeZip
    $Sums = (Invoke-WebRequest "$Base/SHASUMS256.txt" -UseBasicParsing).Content
    $Line = ($Sums -split "`n" | Where-Object { $_.Trim().EndsWith("  $RuntimeName") })
    if (-not $Line) { throw 'Official Node.js checksum not found' }
    $Expected = ($Line.Trim() -split '\s+')[0]
    if ((Get-FileHash $RuntimeZip -Algorithm SHA256).Hash.ToLower() -ne $Expected.ToLower()) { throw 'Node.js checksum mismatch' }
    Expand-Archive $RuntimeZip (Join-Path $Temp 'node')
    $Runtime = Join-Path $Temp "node/node-v$NodeVersion-win-x64"
    New-Item -ItemType Directory (Join-Path $Bundle 'runtime') | Out-Null
    Copy-Item (Join-Path $Runtime 'node.exe') (Join-Path $Bundle 'runtime')
    Copy-Item (Join-Path $Runtime 'LICENSE') (Join-Path $Bundle 'NODE-LICENSE.txt')
    Copy-Item (Join-Path $Root 'LICENSE') $Bundle
    Copy-Item (Join-Path $Root 'README.md') $Bundle
    Copy-Item (Join-Path $Root 'README.fleet.zh-CN.md') $Bundle
    Copy-Item (Join-Path $Root 'fleet.example.json') $Bundle
    @'
@echo off
setlocal
set "PATH=%~dp0runtime;%PATH%"
"%~dp0runtime\node.exe" "%~dp0app\dist\cli.js" %*
if errorlevel 1 (
  echo Pixel Agents Fleet failed. Review the error above.
  pause
  exit /b 1
)
'@ | Set-Content (Join-Path $Bundle 'start-fleet.cmd') -Encoding ASCII
    # Validate the exact directory that will ship, including Windows native PTY and HTTP.
    & node scripts/verify-windows-package.mjs $Bundle
    if ($LASTEXITCODE -ne 0) { throw 'Portable package smoke test failed' }
    $Output = Join-Path $Root 'release'
    New-Item -ItemType Directory -Force $Output | Out-Null
    $Archive = Join-Path $Output "$Name.zip"
    Compress-Archive -Path $Bundle -DestinationPath $Archive -Force
    $Hash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLower()
    "$Hash  $Name.zip" | Set-Content (Join-Path $Output "$Name.zip.sha256") -Encoding ASCII
    Write-Host "Verified package: $Archive"
} finally {
    Pop-Location
    if (Test-Path $Temp) { Remove-Item $Temp -Recurse -Force }
}
