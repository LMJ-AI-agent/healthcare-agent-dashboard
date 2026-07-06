$ErrorActionPreference = "Stop"

$TaskName = "Healthcare Agent Daily Report"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Runner = Join-Path $Root "scripts\run-daily-health-report.ps1"

if (-not (Test-Path -LiteralPath $Runner)) {
  throw "Runner script not found: $Runner"
}

$Action = New-ScheduledTaskAction `
  -Execute "powershell.exe" `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$Runner`" --yesterday" `
  -WorkingDirectory $Root

$WeekdayTimes = @("07:00", "07:30", "08:00", "08:30", "09:00", "10:00", "11:00", "12:00")
$WeekendTimes = @("08:00", "08:30", "09:00", "09:30", "10:00", "11:00", "12:00")
$Triggers = @()
foreach ($Time in $WeekdayTimes) {
  $Triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At $Time
}
foreach ($Time in $WeekendTimes) {
  $Triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek Saturday,Sunday -At $Time
}

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
  -Trigger $Triggers `
  -Settings $Settings `
  -Description "Generate yesterday's healthcare report through Codex after required data is ready, then post it to Slack." `
  -Force | Out-Null

Get-ScheduledTask -TaskName $TaskName
