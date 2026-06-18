# redis-cli.ps1 — 自動從 backend/.env 讀取 Redis 密碼
# 用法：.\redis-cli.ps1 FLUSHDB
#       .\redis-cli.ps1 DEL subscriptions:acs:ram::1039718494325483:role/AliyunCtrlReadOnly
#       .\redis-cli.ps1 KEYS "*"

param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Args)

$envFile = Join-Path $PSScriptRoot "backend\.env"
$pass = (Get-Content $envFile | Where-Object { $_ -match "^REDIS_PASS=" }) -replace "^REDIS_PASS=", ""

if (-not $pass) { Write-Error "REDIS_PASS not found in backend/.env"; exit 1 }

$env:REDISCLI_AUTH = $pass
docker exec -e "REDISCLI_AUTH=$pass" aliyun_redis redis-cli @Args
Remove-Item Env:\REDISCLI_AUTH -ErrorAction SilentlyContinue
