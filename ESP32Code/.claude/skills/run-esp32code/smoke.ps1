# smoke.ps1 — Build the ESP32 firmware and verify the output binary exists.
# Usage: powershell -File smoke.ps1 [-Env esp32s3_mini-test]
# Requires PlatformIO at C:\Users\ishai\.platformio\penv\Scripts\pio.exe

param(
    [string]$Env = "esp32s3_mini-test"
)

$ErrorActionPreference = "Stop"
$PIO = "C:\Users\ishai\.platformio\penv\Scripts\pio.exe"

if (-not (Test-Path $PIO)) {
    Write-Error "PlatformIO not found at $PIO. Install from https://platformio.org/install/cli"
    exit 1
}

$root = Split-Path $PSScriptRoot -Parent | Split-Path -Parent | Split-Path -Parent
Set-Location $root

Write-Host "Building environment: $Env" -ForegroundColor Cyan
& $PIO run -e $Env
if ($LASTEXITCODE -ne 0) {
    Write-Error "Build FAILED for $Env"
    exit 1
}

$bin = ".pio\build\$Env\firmware.bin"
if (-not (Test-Path $bin)) {
    Write-Error "firmware.bin not found at $bin after successful build"
    exit 1
}

$size = (Get-Item $bin).Length
Write-Host ""
Write-Host "OK  firmware.bin  $([math]::Round($size/1KB, 1)) KB  (.pio\build\$Env\firmware.bin)" -ForegroundColor Green
