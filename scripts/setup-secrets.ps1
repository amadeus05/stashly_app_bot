<#
    Заливает секреты в Cloudflare и включает вебхук.

    Токен читается из .env локально и уходит прямо в wrangler — на экран
    не печатается и в историю команд не попадает.

    Запуск из корня проекта:
        powershell -ExecutionPolicy Bypass -File scripts/setup-secrets.ps1

    Идемпотентно: повторный запуск перезальёт секреты теми же значениями.
    Сгенерированные секреты дописываются в .env, чтобы не менялись.
#>

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$envPath = Join-Path $root '.env'
Set-Location $root

if (-not (Test-Path $envPath)) { throw ".env не найден: $envPath" }

# --- чтение .env -----------------------------------------------------------

$values = @{}
foreach ($line in Get-Content $envPath) {
    if ($line -match '^\s*#') { continue }
    if ($line -match '^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$') {
        $values[$matches[1]] = $matches[2].Trim('"').Trim("'")
    }
}

$token = $values['TG_API_TOKEN']
if (-not $token) { $token = $values['BOT_TOKEN'] }
if (-not $token) { throw 'В .env нет ни TG_API_TOKEN, ни BOT_TOKEN' }

# Токен Telegram выглядит как 123456789:AA... — проверяем форму, а не значение,
# чтобы не деплоить заведомо битый секрет и не искать потом причину в логах.
if ($token -notmatch '^\d+:[A-Za-z0-9_-]{30,}$') {
    throw 'TG_API_TOKEN не похож на токен Telegram (ожидается вида 123456789:AA...)'
}

# --- недостающие секреты ---------------------------------------------------

function New-Secret {
    $bytes = New-Object 'System.Byte[]' 24
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    # Только hex: WEBHOOK_SECRET по требованию Telegram может содержать
    # лишь латиницу, цифры, дефис и подчёркивание.
    return ([System.BitConverter]::ToString($bytes) -replace '-', '').ToLower()
}

$appended = @()
foreach ($name in @('WEBHOOK_SECRET', 'ADMIN_SECRET')) {
    if (-not $values[$name]) {
        $values[$name] = New-Secret
        $appended += "$name=$($values[$name])"
    }
}

if ($appended.Count -gt 0) {
    # Если в файле нет завершающего перевода строки, Add-Content приклеит
    # новый ключ к последней строке и склеит его со значением токена.
    $existing = [System.IO.File]::ReadAllText($envPath)
    if ($existing.Length -gt 0 -and -not $existing.EndsWith("`n")) {
        [System.IO.File]::AppendAllText($envPath, "`r`n")
    }
    Add-Content -Path $envPath -Value $appended -Encoding ascii
    Write-Host "Сгенерировано и дописано в .env: $($appended.Count)" -ForegroundColor DarkGray
}

# --- заливка ---------------------------------------------------------------

$secrets = [ordered]@{
    BOT_TOKEN      = $token
    WEBHOOK_SECRET = $values['WEBHOOK_SECRET']
    ADMIN_SECRET   = $values['ADMIN_SECRET']
}

foreach ($name in $secrets.Keys) {
    Write-Host "Заливаю $name... " -NoNewline

    # Никаких 2>$null на нативном exe: в PowerShell 5.1 перенаправление
    # stderr превращает каждую строку в ErrorRecord, и при
    # ErrorActionPreference = Stop безобидное предупреждение wrangler
    # роняет весь скрипт. Шум терпим, падение — нет.
    $secrets[$name] | npx wrangler secret put $name | Out-Null

    if ($LASTEXITCODE -ne 0) { throw "не удалось залить $name" }
    Write-Host 'готово' -ForegroundColor Green
}

# --- вебхук ----------------------------------------------------------------

$workerUrl = 'https://note-keeper.fishing-app.workers.dev'

# Каждый secret put создаёт новую версию воркера, и она подхватывается не
# мгновенно. Запрос сразу после заливки попадает в старую версию, где
# ADMIN_SECRET ещё нет, и получает 403. Поэтому повторяем с паузами.
Write-Host 'Включаю вебхук... ' -NoNewline
$response = $null
foreach ($attempt in 1..6) {
    try {
        $response = Invoke-RestMethod -Uri "$workerUrl/admin/set-webhook?secret=$($values['ADMIN_SECRET'])"
        break
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        if ($code -ne 403 -or $attempt -eq 6) { throw }
        Write-Host "." -NoNewline
        Start-Sleep -Seconds 5
    }
}

if (-not $response.ok) {
    Write-Host ''
    throw "Telegram отказал: $($response | ConvertTo-Json -Compress)"
}
Write-Host 'готово' -ForegroundColor Green

# --- проверка --------------------------------------------------------------

$info = Invoke-RestMethod -Uri "https://api.telegram.org/bot$token/getWebhookInfo"
Write-Host ''
Write-Host 'Вебхук:' $info.result.url
Write-Host 'Ожидает обработки:' $info.result.pending_update_count
if ($info.result.last_error_message) {
    Write-Host 'Последняя ошибка:' $info.result.last_error_message -ForegroundColor Yellow
}
Write-Host ''
Write-Host 'Готово. Напишите боту /start' -ForegroundColor Green
