param([ValidateSet('main', 'fdroid')][string]$Variant = 'main', [switch]$TestsOnly)
$ErrorActionPreference = 'Stop'
$extensionRoot = Split-Path $PSScriptRoot -Parent
$workspaceRoot = Split-Path $extensionRoot -Parent
$env:JAVA_HOME = 'C:/Program Files/Android/Android Studio/jbr'
$env:MONICA_APP_INTEROP_SOURCE_MANIFEST = Join-Path $extensionRoot ".tmp/android-passkey-fixes-317/$Variant-build-source-manifest.json"
if ($Variant -eq 'fdroid') { $env:MONICA_APP_INTEROP_SOURCE_MANIFEST = Join-Path $extensionRoot '.tmp/android-passkey-fixes-317/fdroid-v2-build-source-manifest.json' }
$env:MONICA_ANDROID_PROJECT = (Get-Content -LiteralPath $env:MONICA_APP_INTEROP_SOURCE_MANIFEST -Raw | ConvertFrom-Json).sourceRoot
$env:MONICA_APP_INTEROP_BUILD_ROOT = Join-Path $extensionRoot ".tmp/android-passkey-$Variant-frozen-build-317"
$evidenceName = if ($Variant -eq 'main') { 'system' } else { 'fdroid' }
$env:MONICA_315_APP_FIXTURE = Join-Path $extensionRoot ".tmp/android-passkey-fixes-317/$evidenceName"
$env:MONICA_APP_INTEROP_TEST_SET = 'system-credentials'
$env:MONICA_APP_INTEROP_BUILD_APPLICATION = '1'
$env:MONICA_APP_INTEROP_PASSKEY_REGRESSIONS = '1'
$env:MONICA_APP_INTEROP_BUILD_OFFLINE = '1'
$env:MONICA_APP_INTEROP_HEAP_MB = '4096'
if ($Variant -eq 'fdroid') {
    $env:CARGO_BUILD_JOBS = '2'
    $env:CARGO_TARGET_DIR = Join-Path $extensionRoot '.tmp/android-passkey-fdroid-frozen-build-317/rust-target'
    $env:ANDROID_NDK_HOME = 'D:/AndroidSDK/ndk/28.2.13676358'
}
if ($TestsOnly) {
    $env:MONICA_APP_INTEROP_BUILD_APPLICATION = '0'
    $env:MONICA_APP_INTEROP_PASSKEY_REGRESSIONS = '0'
    $env:MONICA_APP_INTEROP_REUSE_BUILD_EVIDENCE = Join-Path $env:MONICA_315_APP_FIXTURE 'verified-application-build-evidence.json'
}
Set-Location -LiteralPath $extensionRoot
node scripts/interop-315-android-app.mjs build
exit $LASTEXITCODE
