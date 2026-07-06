$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

$node = "C:\Program Files\nodejs\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
  $node = "node"
}

& $node "src\healthReport.js" @args
