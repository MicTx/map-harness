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
$records = @(Get-ChildItem -LiteralPath (Join-Path $root $target) -Filter 'map-harness*.json' -File)
if ($records.Count -ne 1) { throw 'start-web: expected one native build record; extract a clean package.' }
$record = $records[0]
if (($record.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'start-web: native build record is linked; extract a clean package.' }
$service = Join-Path $record.DirectoryName ([System.IO.Path]::GetFileNameWithoutExtension($record.Name) + $(if ($target -eq 'win-x64') { '.exe' } else { '' }))
$program = Get-Item -LiteralPath $service
if ($program.PSIsContainer -or ($program.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'start-web: native service is missing or linked; extract a clean package.' }
if ($args.Count -gt 0 -and $args[0] -eq 'manage') {
  & $service @args
} else {
  & $service --web-onboarding @args
}
exit $LASTEXITCODE
