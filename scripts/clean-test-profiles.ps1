[CmdletBinding(DefaultParameterSetName = 'Run')]
param(
    [Parameter(Mandatory, ParameterSetName = 'Run')][guid]$RunId,
    [Parameter(Mandatory, ParameterSetName = 'All')][switch]$AllInactive,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$root = [IO.Path]::GetFullPath((Join-Path $workspace '.tmp/edge-audit-profiles'))
if (-not (Test-Path -LiteralPath $root)) { return }
foreach ($parent in @($workspace, (Join-Path $workspace '.tmp'), $root)) {
    if ((Get-Item -LiteralPath $parent -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Refusing linked parent: $parent" }
}
try {
    $browsers = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '^(msedge|chrome|chromium)\.exe$' })
} catch {
    # WMI can fail after a browser exits. The native process API can safely
    # confirm there are no browsers; any remaining browser still requires its
    # command line to protect active profiles, so preserve the original denial.
    $nativeBrowsers = @(Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match '^(msedge|chrome|chromium)$' })
    if ($nativeBrowsers.Count) { throw }
    $browsers = @()
}
if (@($browsers | Where-Object { -not $_.CommandLine }).Count) { throw 'Cannot determine active browser profiles; nothing removed.' }
$live = @($browsers | ForEach-Object {
    if ($_.CommandLine -match '--user-data-dir=(?:"([^"]+)"|([^\s]+))') {
        $value = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
        [IO.Path]::GetFullPath($value).TrimEnd('\', '/')
    }
})
$results = [Collections.Generic.List[object]]::new()
foreach ($item in Get-ChildItem -LiteralPath $root -Directory -Force) {
    $target = [IO.Path]::GetFullPath($item.FullName)
    if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase) -or $item.Name -notmatch '^[a-f0-9-]{18}$') { continue }
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
    $markerPath = Join-Path $target '.monica-e2e-profile.json'
    if (-not (Test-Path -LiteralPath $markerPath -PathType Leaf)) { continue }
    $markerFile = Get-Item -LiteralPath $markerPath -Force
    if ($markerFile.Length -gt 1024 -or ($markerFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    try { $marker = Get-Content -LiteralPath $markerPath -Raw | ConvertFrom-Json } catch { continue }
    $ownerRun = [guid]::Empty
    $runnerPid = 0
    if ($marker.kind -ne 'monica-edge-test-profile-v1' -or -not [guid]::TryParse([string]$marker.runId, [ref]$ownerRun)) { continue }
    if (-not [int]::TryParse([string]$marker.runnerPid, [ref]$runnerPid) -or $runnerPid -le 0) { continue }
    if (-not $AllInactive -and $ownerRun -ne $RunId) { continue }
    # Manual cleanup may run alongside another suite; protect its runner, too.
    if ($live -contains $target -or ($AllInactive -and (Get-Process -Id $runnerPid -ErrorAction SilentlyContinue))) {
        $results.Add(@{path=$target;status='active-skipped'}); continue
    }
    try {
        $pending = [Collections.Generic.Stack[string]]::new()
        $pending.Push($target)
        while ($pending.Count) {
            $dir = $pending.Pop()
            if ([IO.File]::GetAttributes($dir) -band [IO.FileAttributes]::ReparsePoint) { throw 'Linked directory inside profile' }
            foreach ($child in [IO.Directory]::EnumerateDirectories($dir)) { $pending.Push($child) }
        }
        if ($DryRun) { $results.Add(@{path=$target;status='would-delete'}) }
        else {
            Remove-Item -LiteralPath $target -Recurse -Force
            $results.Add(@{path=$target;status='deleted'})
        }
    } catch { $results.Add(@{path=$target;status='failed';error=$_.Exception.Message}) }
}
$report = @{runId=if ($AllInactive) { 'all-inactive' } else { $RunId.ToString() };dryRun=[bool]$DryRun;profiles=$results.ToArray()}
$artifactDirectory = Join-Path $workspace '.artifacts'
New-Item -ItemType Directory -Path $artifactDirectory -Force | Out-Null
$report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $artifactDirectory "edge-cleanup-$($report.runId).json") -Encoding utf8
$counts = $results | Group-Object -Property { $_.status } | ForEach-Object { "$($_.Name)=$($_.Count)" }
if ($results.Count) { Write-Output "Edge test profiles: $($counts -join ', ')" }
else { Write-Output 'Edge test profiles: none to clean' }
if (@($results | Where-Object { $_.status -eq 'failed' }).Count) { throw 'Some test profiles could not be removed; see cleanup report.' }
