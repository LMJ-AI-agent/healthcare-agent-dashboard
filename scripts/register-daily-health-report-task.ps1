$ErrorActionPreference = "Stop"

$TaskName = "Healthcare Agent Daily Report"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $Root "scripts\run-daily-health-report.ps1"

if (-not (Test-Path -LiteralPath $Runner)) {
  throw "Runner script not found: $Runner"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" --yesterday --no-slack" `
  -WorkingDirectory $Root

$Trigger = New-ScheduledTaskTrigger -Daily -At "12:00"

$Settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -WakeToRun `
  -MultipleInstances IgnoreNew `
  -RestartCount 2 `
  -RestartInterval (New-TimeSpan -Minutes 5) `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

$Existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($Existing) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask `
  -TaskName $TaskName `
  -Action $Action `
  -Trigger $Trigger `
  -Settings $Settings `
  -Description "Refresh yesterday's healthcare data and publish the GitHub Pages dashboard daily at noon without posting to Slack." `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName
