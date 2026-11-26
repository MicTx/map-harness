$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$root = $PSScriptRoot
$installRoot = $null
for ($index = 0; $index -lt $args.Count; $index++) {
  if ($args[$index] -eq '--install-root') {
    if ($null -ne $installRoot) { throw 'uninstall-map: duplicate --install-root.' }
    $index++
    if ($index -ge $args.Count) { throw 'uninstall-map: --install-root needs a value.' }
    $installRoot = $args[$index]
  }
}
if ($null -ne $installRoot) {
  $launcher = Join-Path $installRoot 'map-harness.cmd'
  if (Test-Path -LiteralPath $launcher -PathType Leaf) {
    & $launcher manage uninstall @args
    exit $LASTEXITCODE
  }
  $launcherScript = Join-Path $installRoot 'map-harness.ps1'
  if (Test-Path -LiteralPath $launcherScript -PathType Leaf) {
    & $launcherScript manage uninstall @args
    exit $LASTEXITCODE
  }
}
$arch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if ([string]::IsNullOrEmpty($arch)) { $arch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
if ($arch -ne 'AMD64') { throw 'uninstall-map: native Windows x64 is required.' }
$directory = Join-Path $root 'win-x64'
if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'uninstall-map: linked native directory.' }
$candidates = @(Get-ChildItem -LiteralPath $directory -Filter 'map-harness-v*-win-x64.exe' | Where-Object { -not $_.PSIsContainer })
if ($candidates.Count -ne 1) { throw 'uninstall-map: exactly one native service is required.' }
$service = $candidates[0].FullName
$record = [IO.Path]::ChangeExtension($service, '.json')
foreach ($path in @($service, $record)) {
  if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'uninstall-map: linked service or metadata.' }
}
& $service manage uninstall @args
exit $LASTEXITCODE
