$j = $input | ConvertFrom-Json
$fp = $j.tool_input.file_path
if ($fp -match 'backoffice[/\\]src[/\\].*\.(html|css|ts)$') {
    $r = & npm --prefix 'C:\Projects\iot-smart-home\backoffice' run lint 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        @{ decision = 'block'; reason = "Backoffice lint failed after editing $fp`:`n$r" } | ConvertTo-Json -Compress
        exit 1
    }
}
