$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
  $node = "node"
}

$LogDir = Join-Path $Root "data\task-logs"
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogPath = Join-Path $LogDir ("daily-health-{0}.log" -f (Get-Date -Format "yyyyMMdd-HHmmss"))

& $node "src\healthReport.js" @args 2>&1 | Tee-Object -FilePath $LogPath
$NodeExitCode = $LASTEXITCODE

if ($NodeExitCode -ne 0) {
  "Daily health update failed with exit code $NodeExitCode." | Tee-Object -FilePath $LogPath -Append
}

exit $NodeExitCode
