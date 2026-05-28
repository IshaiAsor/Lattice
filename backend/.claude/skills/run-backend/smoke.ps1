# smoke.ps1 — build and verify the backend Express server
# Run from anywhere; uses absolute paths throughout.

$backendDir = "C:\Projects\iot-smart-home\backend"
$distIndex  = "$backendDir\dist\index.js"

Write-Host "=== Backend smoke test ===" -ForegroundColor Cyan
Write-Host "Working directory: $backendDir"

# ── 1. Build ──────────────────────────────────────────────────────────────────
Write-Host "`n[1/2] Running npm run build..." -ForegroundColor Yellow

Push-Location $backendDir
try {
    npm run build
    $buildExit = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($buildExit -ne 0) {
    Write-Host "`nBUILD FAILED (exit $buildExit)" -ForegroundColor Red
    exit 1
}

# ── 2. Verify dist/index.js ───────────────────────────────────────────────────
Write-Host "`n[2/2] Checking dist/index.js..." -ForegroundColor Yellow

if (Test-Path $distIndex) {
    $item = Get-Item $distIndex
    Write-Host "  FOUND: $distIndex" -ForegroundColor Green
    Write-Host "  Size : $($item.Length) bytes"
    Write-Host "  Modified: $($item.LastWriteTime)"
} else {
    Write-Host "  NOT FOUND: $distIndex" -ForegroundColor Red
    Write-Host "  tsc may have failed silently. Check TypeScript errors above."
    exit 1
}

Write-Host "`nBuild OK. To start the server:" -ForegroundColor Green
Write-Host "  1. Ensure Docker services are running:"
Write-Host "       docker compose -f C:\Projects\iot-smart-home\compose.yaml up -d"
Write-Host "  2. Start the server:"
Write-Host "       Set-Location '$backendDir'; npm start"
Write-Host "  3. Smoke-test (no /health endpoint; use root or login):"
Write-Host "       Invoke-WebRequest -Uri http://localhost:3000/ -UseBasicParsing"
Write-Host "       (Expect: 'Smart Home API is running...')"
