param(
    [ValidateSet('device', 'ui', 'verify')][string]$Surface,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$OperationArguments
)
$ErrorActionPreference = 'Stop'
$extensionRoot = Split-Path $PSScriptRoot -Parent
$env:MONICA_CM_EVIDENCE_DIR = Join-Path $extensionRoot '.tmp/android-passkey-fixes-317/system'
Set-Location -LiteralPath $extensionRoot
& node (Join-Path $PSScriptRoot "interop-317-android-cm-$Surface.mjs") @OperationArguments
if ($LASTEXITCODE -ne 0) { throw "Credential Manager $Surface operation failed with exit code $LASTEXITCODE" }
exit $LASTEXITCODE
