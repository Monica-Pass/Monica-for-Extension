param(
    [string]$GradleCache = $env:GRADLE_USER_HOME,
    [string]$JavaDirectory = $env:JAVA_HOME
)

$ErrorActionPreference = 'Stop'
if (-not $GradleCache -or -not $JavaDirectory) {
    throw 'Provide GradleCache and JavaDirectory; this probe only uses existing local runtimes.'
}
$interopExtensionRoot = (Resolve-Path (Join-Path $PSScriptRoot '../../../..')).Path
$interopClassRoot = (Resolve-Path (Join-Path $interopExtensionRoot '.tmp/android-app-build-315/app/tmp/kotlin-classes/debug')).Path
$interopLibraries = @(
    'org.jetbrains.kotlin/kotlin-stdlib/2.1.20',
    'org.jetbrains.kotlinx/kotlinx-serialization-core-jvm/1.6.0',
    'org.jetbrains.kotlinx/kotlinx-serialization-json-jvm/1.6.0'
)
$interopRuntimeJars = @($interopLibraries | ForEach-Object {
    $interopLibraryPath = Join-Path $GradleCache "caches/modules-2/files-2.1/$_"
    $interopJar = Get-ChildItem -LiteralPath $interopLibraryPath -Recurse -Filter '*.jar' |
        Where-Object { $_.Name -notmatch '-sources|-javadoc' } |
        Select-Object -First 1 -ExpandProperty FullName
    if (-not $interopJar) { throw "Missing existing runtime jar: $_" }
    $interopJar
})
$interopProbeClasspath = (@($interopClassRoot) + $interopRuntimeJars) -join [IO.Path]::PathSeparator
$interopJava = Join-Path $JavaDirectory 'bin/java.exe'
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $interopClassRoot 'takagi/ru/monica/utils/SecureItemRestoreTypeResolver.class') |
    Format-List Path, Hash
& $interopJava --class-path $interopProbeClasspath (Join-Path $PSScriptRoot 'SecureTypeProbe.java')
exit $LASTEXITCODE
