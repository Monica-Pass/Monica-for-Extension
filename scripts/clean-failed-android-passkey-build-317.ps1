$ErrorActionPreference = 'Stop'
$extensionRoot = [IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$failedBuildRoot = [IO.Path]::GetFullPath((Join-Path $extensionRoot '.tmp/android-passkey-fix-build-317'))
$allowedPrefix = $extensionRoot.TrimEnd('\') + '\'
if (!$failedBuildRoot.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Build outside extension workspace' }
# Both commands that used this build directory have finished. The current build has a different root.
if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($failedBuildRoot) }) { throw 'A process still references the failed build' }
$cacheNames = @('generated', 'intermediates', 'kotlin', 'kspCaches', 'tmp')
$targets = @(Get-ChildItem -LiteralPath $failedBuildRoot -Directory | ForEach-Object {
    Get-ChildItem -LiteralPath $_.FullName -Directory | Where-Object { $_.Name -in $cacheNames }
})
$protected = @(Get-ChildItem -LiteralPath $failedBuildRoot -File -Recurse | Where-Object {
    $_.Extension -in @('.apk', '.exe', '.pdb') -or $_.FullName.Contains('\outputs\')
} | ForEach-Object { @{ path = $_.FullName; sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash } })
$removedBytes = 0L
foreach ($target in $targets) {
    $absolute = [IO.Path]::GetFullPath($target.FullName)
    if (!$absolute.StartsWith($failedBuildRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Cache path escaped failed build' }
    $entries = @($target) + @(Get-ChildItem -LiteralPath $absolute -Recurse -Force)
    if ($entries | Where-Object { $_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) }) { throw 'Refusing linked cache tree' }
    if ($protected | Where-Object { $_.path.StartsWith($absolute + '\', [StringComparison]::OrdinalIgnoreCase) }) { throw 'Protected build output inside target' }
    $removedBytes += [long](($entries | Where-Object { !$_.PSIsContainer } | Measure-Object Length -Sum).Sum)
}
$drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($failedBuildRoot).Substring(0, 1))
$freeBefore = $drive.Free
foreach ($target in $targets) { Remove-Item -LiteralPath $target.FullName -Recurse -Force }
foreach ($item in $protected) {
    if ((Get-FileHash -LiteralPath $item.path -Algorithm SHA256).Hash -ne $item.sha256) { throw 'Protected output changed' }
}
$result = @{ at = [DateTime]::UtcNow.ToString('o'); root = $failedBuildRoot; targets = @($targets.FullName);
    removedLogicalBytes = $removedBytes; freeBefore = $freeBefore; freeAfter = (Get-PSDrive -Name $drive.Name).Free;
    protectedOutputHashes = $protected; protectedUnchanged = $true }
$result | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $extensionRoot '.tmp/android-passkey-fixes-317/failed-build-cleanup.json') -Encoding utf8
$result | Select-Object removedLogicalBytes, protectedUnchanged | ConvertTo-Json -Compress
