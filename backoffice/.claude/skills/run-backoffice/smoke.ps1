# smoke.ps1 — Headless build smoke test for the backoffice Angular app.
# Runs `ng build` and verifies that the expected output files are present.
# Exit code: 0 = pass, 1 = failure.


# NOTE: Do NOT set $ErrorActionPreference = 'Stop' here.
# PowerShell 5.1 wraps native exe stderr as NativeCommandError ErrorRecords, which
# causes Stop mode to abort the script even when the process exits with code 0.
# We check $LASTEXITCODE explicitly instead.

$ProjectRoot = "C:\Projects\iot-smart-home\backoffice"
$DistDir     = "$ProjectRoot\dist\backoffice"

Write-Host "==> Running ng build (production)..."
Set-Location $ProjectRoot
npm run build 2>&1 | ForEach-Object { "$_" }   # flatten ErrorRecords to strings

if ($LASTEXITCODE -ne 0) {
    Write-Host "FAIL: ng build exited with code $LASTEXITCODE." -ForegroundColor Red
    exit 1
}

Write-Host "==> Verifying dist output at $DistDir ..."

$requiredFiles = @(
    "index.html",
    "favicon.ico"
)

$allGood = $true
foreach ($file in $requiredFiles) {
    $path = Join-Path $DistDir $file
    if (Test-Path $path) {
        Write-Host "  OK  $file" -ForegroundColor Green
    } else {
        Write-Host "  MISSING  $file" -ForegroundColor Red
        $allGood = $false
    }
}

# Check that at least one main JS bundle was produced
$mainJs = Get-ChildItem "$DistDir\main.*.js" -ErrorAction SilentlyContinue
if ($mainJs) {
    Write-Host "  OK  $($mainJs[0].Name)" -ForegroundColor Green
} else {
    Write-Host "  MISSING  main.<hash>.js" -ForegroundColor Red
    $allGood = $false
}

if ($allGood) {
    Write-Host "`nSMOKE TEST PASSED" -ForegroundColor Green
    exit 0
} else {
    Write-Host "`nSMOKE TEST FAILED" -ForegroundColor Red
    exit 1
}
