# smoke.ps1 -- Verify ota-manager syntax and check firmware storage.
# Usage: powershell -File smoke.ps1

$ErrorActionPreference = "Stop"
Set-Location "$PSScriptRoot\..\..\..\"

Write-Host "Checking index.js syntax..."
node --check index.js
if ($LASTEXITCODE -ne 0) { Write-Error "Syntax errors in index.js"; exit 1 }
Write-Host "Syntax OK"

$fwPath = if ($env:FIRMWARE_PATH) { $env:FIRMWARE_PATH } else { ".\firmware" }
if (Test-Path $fwPath) {
    Write-Host ""
    Write-Host "Firmware storage ($fwPath):"
    Get-ChildItem -Recurse $fwPath | Select-Object Name, Length, LastWriteTime
} else {
    Write-Host ""
    Write-Host "Firmware storage ($fwPath) does not exist yet -- created on first run."
}

Write-Host ""
Write-Host "OK"
