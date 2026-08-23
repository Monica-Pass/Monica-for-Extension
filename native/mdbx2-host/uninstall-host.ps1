[CmdletBinding()]
param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA "Monica\Extension\MDBX2")
)

$ErrorActionPreference = "Stop"
$HostName = "com.monica_pass.mdbx2"
$WindowsHelloHostName = "com.monica_pass.windows_hello"
$RegistryKeys = @(
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$HostName",
    "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$WindowsHelloHostName",
    "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$WindowsHelloHostName"
)
foreach ($Key in $RegistryKeys) {
    if (Test-Path -LiteralPath $Key) {
        Remove-Item -LiteralPath $Key -Force
    }
}

$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$DriveRoot = [IO.Path]::GetPathRoot($InstallRoot)
if ($InstallRoot -eq $DriveRoot -or $InstallRoot.Length -le $DriveRoot.Length + 3) {
    throw "Refusing to delete an unsafe installation path."
}
if (Test-Path -LiteralPath $InstallRoot) {
    $ManifestPath = Join-Path $InstallRoot "$HostName.json"
    $WindowsHelloManifestPath = Join-Path $InstallRoot "$WindowsHelloHostName.json"
    $ExecutablePath = Join-Path $InstallRoot "monica-mdbx2-host.exe"
    if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf) -and -not (Test-Path -LiteralPath $WindowsHelloManifestPath -PathType Leaf) -and -not (Test-Path -LiteralPath $ExecutablePath -PathType Leaf)) {
        throw "The target directory does not contain Monica MDBX2 Host files."
    }
    Remove-Item -LiteralPath $InstallRoot -Recurse -Force
}

Write-Host "Monica MDBX2 Native Host was removed."
