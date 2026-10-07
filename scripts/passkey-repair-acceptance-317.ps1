param([ValidateSet('device','ui','verify')][string]$Surface, [Parameter(ValueFromRemainingArguments=$true)][string[]]$OperationArguments)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$env:MONICA_CM_EVIDENCE_DIR=Join-Path $taskRoot '.tmp/android-passkey-fixes-317/acceptance'
$env:MONICA_CM_REPAIRS='1'
Set-Location -LiteralPath $taskRoot
node (Join-Path $PSScriptRoot "interop-317-android-cm-$Surface.mjs") @OperationArguments
if ($LASTEXITCODE -ne 0) { throw "Repair acceptance $Surface failed" }
