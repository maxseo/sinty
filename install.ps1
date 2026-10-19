# Installs the staged Sinty tree for the current user.
# Requires Node.js 24+ and a prior: node scripts/stage.mjs
$ErrorActionPreference = "Stop"
$node = (node -p "process.versions.node")
if ([version]($node.Split("-")[0]) -lt [version]"24.0.0") { throw "Node.js 24+ required, found $node" }
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$stage = Join-Path $root "build\stage"
if (-not (Test-Path (Join-Path $stage "integrity.json"))) { throw "missing $stage. Run: node scripts/stage.mjs" }
$dest = Join-Path $env:LOCALAPPDATA "Sinty\app"
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $stage "*") -Destination $dest -Recurse -Force
$bin = Join-Path $dest "bin"
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*${bin}*") {
  [Environment]::SetEnvironmentVariable("Path", "$userPath;$bin", "User")
  $env:Path = "$env:Path;$bin"
  Write-Host "added $bin to the user Path (new terminals pick it up)"
}
Write-Host "installed to $dest"
& node (Join-Path $dest "packages\cli\dist\bin.js") version
& node (Join-Path $dest "packages\cli\dist\bin.js") doctor
