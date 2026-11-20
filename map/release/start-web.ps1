$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$runtime = [System.Runtime.InteropServices.RuntimeInformation]
$processor = [System.Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE')
if ([string]::IsNullOrEmpty($processor)) { $processor = [string]$runtime::ProcessArchitecture }
if ($runtime::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Windows)) { $target = 'win-x64' }
elseif ($runtime::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::OSX)) { $target = if ($processor -eq 'Arm64') { 'mac-arm64' } else { 'mac-x64' } }
elseif ($runtime::IsOSPlatform([System.Runtime.InteropServices.OSPlatform]::Linux)) { $target = if ($processor -eq 'Arm64') { 'linux-arm64' } else { 'linux-x64' } }
else { throw 'start-web: unsupported operating system.' }
$record = Get-ChildItem -LiteralPath (Join-Path $root $target) -Filter '*.json' | Select-Object -First 1
if ($null -eq $record) { throw 'start-web: native build record is missing.' }
$service = Join-Path $record.DirectoryName ([System.IO.Path]::GetFileNameWithoutExtension($record.Name) + $(if ($target -eq 'win-x64') { '.exe' } else { '' }))
& $service --web-onboarding @args
exit $LASTEXITCODE
