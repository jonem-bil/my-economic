# 自动备份记账数据库（由 serve.cmd 每次启动看板时调用）
# 路径优先级：命令行参数 > 环境变量 > 本文件所在目录下的相对路径
# 本机专属路径请写在 local-paths.cmd（已在 .gitignore 中排除），不要写进本文件
param(
    [string]$DbPath    = '',
    [string]$BackupDir = '',
    [int]$Keep         = 30
)
$ErrorActionPreference = 'SilentlyContinue'

$Root = $PSScriptRoot
if (-not $DbPath)    { $DbPath = $env:BOOKKEEPING_DB_PATH }
if (-not $DbPath)    { $DbPath = Join-Path $Root 'data\bookkeeping.db' }
if (-not $BackupDir) { $BackupDir = $env:BOOKKEEPING_BACKUP_DIR }
if (-not $BackupDir) { $BackupDir = Join-Path $Root 'backup' }

if (-not (Test-Path -LiteralPath $DbPath)) { exit 0 }
if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest  = Join-Path $BackupDir ("bookkeeping-$stamp.db")
Copy-Item -LiteralPath $DbPath -Destination $dest -Force

$files = @(Get-ChildItem -LiteralPath $BackupDir -Filter 'bookkeeping-*.db' | Sort-Object Name -Descending)
if ($files.Count -gt $Keep) { $files | Select-Object -Skip $Keep | Remove-Item -Force }
Write-Host ("[备份] " + $dest)
