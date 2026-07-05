# PostToolUse hook: lint + format-check any Node-workspace TypeScript file Claude edits.
# Blocks the edit result so Claude self-corrects immediately. Style/typecheck of the full
# tree stays with pre-commit and CI; this is a fast single-file gate.
$j = $input | ConvertFrom-Json
$fp = $j.tool_input.file_path
if (-not $fp) { exit 0 }

$root = 'C:\Projects\iot-smart-home'
$isWorkspaceTs = $fp -match '[/\\]iot-smart-home[/\\](services|packages|tests|prisma)[/\\].*\.ts$'
$isExcluded = $fp -match '[/\\](dist|node_modules)[/\\]'
if (-not $isWorkspaceTs -or $isExcluded) { exit 0 }

$r = & npx --prefix $root eslint --no-warn-ignored $fp 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    @{ decision = 'block'; reason = "ESLint failed for ${fp}:`n$r" } | ConvertTo-Json -Compress
    exit 1
}

$r = & npx --prefix $root prettier --check $fp 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
    @{ decision = 'block'; reason = "Prettier check failed for ${fp} (run 'npx prettier --write' on it):`n$r" } | ConvertTo-Json -Compress
    exit 1
}
