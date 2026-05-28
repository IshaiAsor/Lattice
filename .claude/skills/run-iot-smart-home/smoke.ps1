# smoke.ps1 — Validate the IoT smart home Docker Compose stack
# Run from the iot-smart-home/ project root

$projectRoot = "C:\Projects\iot-smart-home"
Set-Location $projectRoot

$errors = 0

# ── 1. Validate the compose file ─────────────────────────────────────────────
Write-Host "`n[1/3] Validating compose file..." -ForegroundColor Cyan
$configOutput = docker compose config --quiet 2>&1
$configExit = $LASTEXITCODE

# Filter out known "not set" warnings for optional migrate-profile vars
$warnings = $configOutput | Where-Object { $_ -match 'level=warning' -and $_ -notmatch 'OWNER_' }
if ($warnings) {
    Write-Host "WARN: Unexpected warnings from compose config:" -ForegroundColor Yellow
    $warnings | ForEach-Object { Write-Host "  $_" -ForegroundColor Yellow }
}

if ($configExit -eq 0) {
    Write-Host "OK  Compose file is valid." -ForegroundColor Green
} else {
    Write-Host "FAIL  Compose config validation failed (exit $configExit)." -ForegroundColor Red
    $errors++
}

# ── 2. Check service status ───────────────────────────────────────────────────
Write-Host "`n[2/3] Checking running services..." -ForegroundColor Cyan
$psOutput = docker compose ps 2>&1
$psExit = $LASTEXITCODE

if ($psExit -ne 0) {
    Write-Host "FAIL  'docker compose ps' failed (exit $psExit)." -ForegroundColor Red
    $errors++
} else {
    Write-Host $psOutput
}

# ── 3. Check expected core services are up ───────────────────────────────────
Write-Host "`n[3/3] Checking expected core services are Up..." -ForegroundColor Cyan

$expectedServices = @(
    @{ Name = "postgres_db";  Label = "PostgreSQL"  },
    @{ Name = "redis_cache";  Label = "Redis"        },
    @{ Name = "adminer_ui";   Label = "Adminer"      },
    @{ Name = "ota-manager";  Label = "OTA Manager"  }
)

# EMQX may take a while to start; list it separately so failure is informational
$optionalServices = @(
    @{ Name = "emqx"; Label = "EMQX" }
)

foreach ($svc in $expectedServices) {
    $line = $psOutput | Where-Object { $_ -match $svc.Name }
    if ($line -and $line -match '\bUp\b') {
        Write-Host "OK  $($svc.Label) ($($svc.Name)) is Up." -ForegroundColor Green
    } elseif ($line) {
        Write-Host "WARN  $($svc.Label) ($($svc.Name)) exists but may not be Up: $line" -ForegroundColor Yellow
        $errors++
    } else {
        Write-Host "INFO  $($svc.Label) ($($svc.Name)) is not running (stack may not be started)." -ForegroundColor DarkGray
    }
}

foreach ($svc in $optionalServices) {
    $line = $psOutput | Where-Object { $_ -match $svc.Name }
    if ($line -and $line -match '\bUp\b') {
        Write-Host "OK  $($svc.Label) ($($svc.Name)) is Up." -ForegroundColor Green
    } elseif ($line) {
        Write-Host "WARN  $($svc.Label) ($($svc.Name)) exists but may not be Up (it may still be starting): $line" -ForegroundColor Yellow
    } else {
        Write-Host "INFO  $($svc.Label) ($($svc.Name)) is not running." -ForegroundColor DarkGray
    }
}

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
if ($errors -eq 0) {
    Write-Host "Smoke check passed." -ForegroundColor Green
} else {
    Write-Host "Smoke check finished with $errors issue(s). Review output above." -ForegroundColor Red
}

Write-Host "`nService endpoints (when stack is running):"
Write-Host "  EMQX dashboard : http://localhost:18083"
Write-Host "  Adminer UI     : http://localhost:8080"
Write-Host "  OTA Manager    : http://localhost:3001"
Write-Host "  MQTT (plain)   : mqtt://localhost:1883"
Write-Host "  MQTT (TLS)     : mqtts://localhost:8883"
Write-Host "  PostgreSQL     : postgres://localhost:5432"
Write-Host "  Redis          : redis://localhost:6379"
