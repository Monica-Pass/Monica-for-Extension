$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path $PSScriptRoot -Parent
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:MONICA_APP_INTEROP_SOURCE_MANIFEST = Join-Path $taskRoot '.tmp/android-passkey-fixes-317/main-build-source-manifest.json'
$env:MONICA_ANDROID_PROJECT = (Get-Content $env:MONICA_APP_INTEROP_SOURCE_MANIFEST -Raw | ConvertFrom-Json).sourceRoot
$env:MONICA_APP_INTEROP_BUILD_ROOT = Join-Path $taskRoot '.tmp/android-passkey-main-frozen-build-317'
$env:MONICA_315_APP_FIXTURE = Join-Path $taskRoot '.tmp/android-passkey-fixes-317/acceptance'
$env:MONICA_APP_INTEROP_TEST_SET = 'passkey-repairs'
$env:MONICA_APP_INTEROP_BUILD_APPLICATION = '0'
$env:MONICA_APP_INTEROP_PASSKEY_REGRESSIONS = '0'
$env:MONICA_APP_INTEROP_BUILD_OFFLINE = '1'
$env:MONICA_APP_INTEROP_HEAP_MB = '2048'
$env:MONICA_APP_INTEROP_REUSE_BUILD_EVIDENCE = Join-Path $taskRoot '.tmp/android-passkey-fixes-317/system/verified-application-build-evidence.json'
Set-Location -LiteralPath $taskRoot
node scripts/interop-315-android-app.mjs build
if ($LASTEXITCODE -ne 0) { throw 'Test-only build failed' }
