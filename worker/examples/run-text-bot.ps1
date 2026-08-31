$ErrorActionPreference = "Stop"

$workerRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$secretPath = Join-Path $workerRoot ".dev.vars"
if (-not (Test-Path -LiteralPath $secretPath)) {
    throw "Missing $secretPath"
}

$line = Get-Content -LiteralPath $secretPath |
    Where-Object { $_ -like "BOT_WS_TOKEN=*" } |
    Select-Object -First 1
if (-not $line) {
    throw "BOT_WS_TOKEN is missing from .dev.vars"
}

$env:BOT_WS_TOKEN = $line.Substring("BOT_WS_TOKEN=".Length)
$env:BOT_WS_URL = "wss://api.rettheory.top/ws/bot?channel=main&protocol=custom"
node (Join-Path $workerRoot "examples\text-bot.mjs")
