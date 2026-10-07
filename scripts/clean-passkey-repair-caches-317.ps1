$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Split-Path $PSScriptRoot -Parent))
$taskEvidence=Join-Path $taskRoot '.tmp/android-passkey-fixes-317/acceptance'
$taskBuildRoots=@('main','fdroid') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $taskRoot ".tmp/android-passkey-$_-frozen-build-317")) }
$taskProcesses=Get-CimInstance Win32_Process
foreach($taskBuild in $taskBuildRoots) {
    if (!$taskBuild.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Build root escaped workspace' }
    if ($taskProcesses | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($taskBuild) }) { throw 'Build root is still in use' }
}
$taskCacheNames=@('generated','intermediates','kotlin','kspCaches','tmp')
$taskTargets=@(foreach($taskBuild in $taskBuildRoots) {
    foreach($taskModule in @('app','mdbx-engine')) {
        $taskModulePath=Join-Path $taskBuild $taskModule
        Get-ChildItem -LiteralPath $taskModulePath -Directory | Where-Object { $_.Name -in $taskCacheNames }
    }
    $taskRust=Join-Path $taskBuild 'rust-target'
    if (Test-Path -LiteralPath $taskRust) { Get-ChildItem -LiteralPath $taskRust -Directory -Recurse | Where-Object Name -eq 'incremental' }
})
$taskAllFiles=@(foreach($taskBuild in $taskBuildRoots) { Get-ChildItem -LiteralPath $taskBuild -File -Recurse -Force })
$taskProtected=@($taskAllFiles | Where-Object { $_.Extension -in @('.apk','.exe','.pdb','.so') -or $_.FullName.Contains('\outputs\') -or $_.FullName.Contains('\test-results\') } | ForEach-Object {
    @{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
})
$taskProtected+=@(Get-ChildItem -LiteralPath (Join-Path $taskRoot '.tmp/android-passkey-fixes-317') -File -Recurse -Force | ForEach-Object {
    @{path=$_.FullName;sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash}
})
# JNI shared objects inside intermediates are generated duplicates. Keep their directories
# and all executable outputs; only prune cache targets with no protected descendants.
$taskTargets=@($taskTargets | Where-Object {
    $taskCandidate=$_.FullName
    !($taskProtected | Where-Object { $_.path.StartsWith($taskCandidate+'\',[StringComparison]::OrdinalIgnoreCase) })
})
$taskRemove=@()
foreach($taskTarget in $taskTargets) {
    $taskAbsolute=[IO.Path]::GetFullPath($taskTarget.FullName)
    if (!($taskBuildRoots | Where-Object { $taskAbsolute.StartsWith($_+'\',[StringComparison]::OrdinalIgnoreCase) })) { throw 'Cache target escaped allowed roots' }
    $taskEntries=@($taskTarget)+@(Get-ChildItem -LiteralPath $taskAbsolute -Recurse -Force)
    if ($taskEntries | Where-Object { $_.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint) }) { throw 'Refuse linked cache tree' }
    $taskRemove+=@{path=$taskAbsolute;directory=$true;bytes=[long](($taskEntries | Where-Object {!$_.PSIsContainer} | Measure-Object Length -Sum).Sum)}
}
# Cargo compile artifacts are reproducible; retain shared libraries and build-script executables.
foreach($taskFile in $taskAllFiles) {
    if (!$taskFile.FullName.Contains('\rust-target\') -or $taskFile.Extension -notin @('.rlib','.rmeta','.o','.obj','.d')) { continue }
    if ($taskRemove | Where-Object { $taskFile.FullName.StartsWith($_.path+'\',[StringComparison]::OrdinalIgnoreCase) }) { continue }
    $taskAbsolute=[IO.Path]::GetFullPath($taskFile.FullName)
    if (!($taskBuildRoots | Where-Object { $taskAbsolute.StartsWith($_+'\rust-target\',[StringComparison]::OrdinalIgnoreCase) })) { throw 'Cargo target escaped allowed roots' }
    $taskParent=$taskFile.Directory
    while($taskParent.FullName.StartsWith($taskRoot+'\',[StringComparison]::OrdinalIgnoreCase)) {
        if ($taskParent.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Linked Cargo path' }
        $taskParent=$taskParent.Parent
    }
    if ($taskFile.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'Linked Cargo artifact' }
    $taskRemove+=@{path=$taskAbsolute;directory=$false;bytes=$taskFile.Length}
}
$taskBytes=[long](($taskRemove | Measure-Object bytes -Sum).Sum)
$taskFreeBefore=(Get-PSDrive C).Free
foreach($taskTarget in $taskRemove) {
    if($taskTarget.directory){ Remove-Item -LiteralPath $taskTarget.path -Recurse -Force }
    else { Remove-Item -LiteralPath $taskTarget.path -Force }
}
foreach($taskFile in $taskProtected) {
    if((Get-FileHash -LiteralPath $taskFile.path -Algorithm SHA256).Hash -ne $taskFile.sha256) { throw 'Protected evidence/output changed' }
}
$taskReport=@{at=[datetime]::UtcNow.ToString('o');removedLogicalBytes=$taskBytes;targets=$taskRemove;protectedHashes=$taskProtected;protectedUnchanged=$true;freeBefore=$taskFreeBefore;freeAfter=(Get-PSDrive C).Free}
$taskReport | ConvertTo-Json -Depth 7 | Set-Content -LiteralPath (Join-Path $taskEvidence 'cache-cleanup.json') -Encoding utf8
@{removedLogicalBytes=$taskBytes;targets=$taskRemove.Count;protectedFiles=$taskProtected.Count;protectedUnchanged=$true} | ConvertTo-Json -Compress
