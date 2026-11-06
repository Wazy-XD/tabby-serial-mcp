# Installs (or upgrades) the tabby-serial-mcp Tabby plugin from a GitHub release.
#
#   iwr -useb https://raw.githubusercontent.com/Wazy-XD/tabby-serial-mcp/main/scripts/install.ps1 | iex
#
# Options:
#   -Repo <owner/name>   default Wazy-XD/tabby-serial-mcp
#   -Version <tag>       default "latest"
#   -NoRestart           copy the plugin but do not restart Tabby
param(
    [string]$Repo = 'Wazy-XD/tabby-serial-mcp',
    [string]$Version = 'latest',
    [switch]$NoRestart
)

$ErrorActionPreference = 'Stop'

$assetUrl = if ($Version -eq 'latest') {
    "https://github.com/$Repo/releases/latest/download/tabby-serial-mcp.zip"
} else {
    "https://github.com/$Repo/releases/download/$Version/tabby-serial-mcp.zip"
}

$stamp = [guid]::NewGuid().ToString('N')
$zip = Join-Path $env:TEMP "tabby-serial-mcp-$stamp.zip"
$staging = Join-Path $env:TEMP "tabby-serial-mcp-$stamp"

Write-Host "downloading $assetUrl"
Invoke-WebRequest -Uri $assetUrl -OutFile $zip -UseBasicParsing
Expand-Archive -LiteralPath $zip -DestinationPath $staging -Force

$source = Join-Path $staging 'tabby-serial-mcp'
if (-not (Test-Path -LiteralPath $source)) {
    throw "unexpected archive layout: $staging"
}

$pluginsRoot = Join-Path $env:APPDATA 'tabby\plugins\node_modules'
$target = Join-Path $pluginsRoot 'tabby-serial-mcp'
New-Item -ItemType Directory -Force -Path $pluginsRoot | Out-Null
if (Test-Path -LiteralPath $target) {
    Remove-Item -LiteralPath $target -Recurse -Force
}
Copy-Item -LiteralPath $source -Destination $pluginsRoot -Recurse -Force

Remove-Item -LiteralPath $zip -Force
Remove-Item -LiteralPath $staging -Recurse -Force

Write-Host "installed -> $target"

if ($NoRestart) {
    Write-Host 'restart Tabby to load the plugin.'
    return
}

$running = Get-Process -Name Tabby -ErrorAction SilentlyContinue
if ($running) {
    Write-Host 'stopping Tabby...'
    Stop-Process -Name Tabby -Force
    Start-Sleep -Seconds 3
}

$exe = @(
    'D:\Program Files\Tabby\Tabby.exe',
    (Join-Path $env:LOCALAPPDATA 'Programs\Tabby\Tabby.exe'),
    (Join-Path $env:ProgramFiles 'Tabby\Tabby.exe')
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

if (-not $exe) {
    $exe = (Get-Command Tabby.exe -ErrorAction SilentlyContinue).Source
}
if (-not $exe) {
    Write-Warning 'Tabby.exe not found; start Tabby manually.'
    return
}

Write-Host "starting $exe"
Start-Process -FilePath $exe
Start-Sleep -Seconds 10

try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3002/health' -TimeoutSec 8
    Write-Host ("MCP bridge: running={0} url={1}" -f $health.running, $health.url)
    Write-Host ("tools: {0}" -f ($health.tools -join ', '))
} catch {
    Write-Warning "health check failed: $($_.Exception.Message)"
    $log = Join-Path $env:APPDATA 'tabby\serial-mcp.log'
    if (Test-Path -LiteralPath $log) {
        Write-Host "---- $log (tail) ----"
        Get-Content -LiteralPath $log -Tail 40
    }
}
