# Smoke test for hydro-vision-service
# Starts the server, polls /api/v1/health, asserts status:ok, then kills the server.

$ServiceDir = Resolve-Path "$PSScriptRoot\..\.."
$MaxRetries = 10
$RetryDelaySec = 1
$Port = 3000

Write-Host "=== Hydro Vision Service Smoke Test ===" -ForegroundColor Cyan
Write-Host "Service directory: $ServiceDir"

# Install dependencies if node_modules is missing
if (-not (Test-Path "$ServiceDir\node_modules")) {
    Write-Host "Installing dependencies..." -ForegroundColor Yellow
    Push-Location $ServiceDir
    npm install --silent
    Pop-Location
}

# Verify model file exists
if (-not (Test-Path "$ServiceDir\best.onnx")) {
    Write-Host "ERROR: best.onnx not found in $ServiceDir" -ForegroundColor Red
    exit 1
}

# Start server as a background job
Write-Host "Starting server on port $Port..." -ForegroundColor Yellow
$job = Start-Job -ScriptBlock {
    param($dir)
    Set-Location $dir
    node --loader ts-node/esm server.ts 2>&1
} -ArgumentList $ServiceDir

$serverStarted = $false
$attempt = 0

while ($attempt -lt $MaxRetries) {
    $attempt++
    Start-Sleep -Seconds $RetryDelaySec

    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$Port/api/v1/health" -Method GET -TimeoutSec 3 -ErrorAction Stop
        if ($response.status -eq "ok") {
            $serverStarted = $true
            Write-Host "Server responding on attempt $attempt — status: $($response.status)" -ForegroundColor Green
            break
        }
    } catch {
        Write-Host "Attempt $attempt/$MaxRetries — not ready yet..." -ForegroundColor DarkGray
    }
}

# Clean up background job
Stop-Job $job -ErrorAction SilentlyContinue
Remove-Job $job -Force -ErrorAction SilentlyContinue

if (-not $serverStarted) {
    Write-Host "FAIL: Service did not respond after $MaxRetries attempts" -ForegroundColor Red
    exit 1
}

Write-Host "PASS: hydro-vision-service health check succeeded" -ForegroundColor Green
exit 0
