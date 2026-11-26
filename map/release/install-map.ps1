$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 3.0
$root = $PSScriptRoot
$expected = $null
$managerDigest = $null
for ($index = 0; $index -lt $args.Count; $index++) {
  if ($args[$index] -in @('--expected', '--manager-sha256')) {
    $name = $args[$index]
    $index++
    if ($index -ge $args.Count) { throw 'install-map: expected an option value.' }
    if ($name -eq '--expected') {
      if ($null -ne $expected) { throw 'install-map: duplicate --expected.' }
      $expected = $args[$index]
    } else {
      if ($null -ne $managerDigest) { throw 'install-map: duplicate --manager-sha256.' }
      $managerDigest = $args[$index]
    }
  }
}
if ([string]::IsNullOrWhiteSpace($expected) -or -not (Test-Path -LiteralPath $expected -PathType Leaf)) {
  throw 'install-map: supply --expected with independently selected release identity.'
}
if ($managerDigest -cnotmatch '\A[a-f0-9]{64}\z') { throw 'install-map: supply --manager-sha256 from independent release checksums.' }
$arch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITEW6432')
if ([string]::IsNullOrEmpty($arch)) { $arch = [Environment]::GetEnvironmentVariable('PROCESSOR_ARCHITECTURE') }
if ($arch -ne 'AMD64') { throw 'install-map: native Windows x64 is required.' }
$directory = Join-Path $root 'win-x64'
if ((Get-Item -LiteralPath $directory).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'install-map: linked native directory.' }
$candidates = @(Get-ChildItem -LiteralPath $directory -Filter 'map-harness-v*-win-x64.exe' | Where-Object { -not $_.PSIsContainer })
if ($candidates.Count -ne 1) { throw 'install-map: exactly one native service is required.' }
$service = $candidates[0].FullName
$record = [IO.Path]::ChangeExtension($service, '.json')
foreach ($path in @($service, $record, $expected)) {
  if ((Get-Item -LiteralPath $path).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'install-map: linked service or metadata.' }
}
if ((Get-FileHash -LiteralPath $service -Algorithm SHA256).Hash.ToLowerInvariant() -cne $managerDigest) {
  throw 'install-map: native-manager checksum differs; no package code was executed.'
}
& $service manage install --package-root $root @args
exit $LASTEXITCODE
