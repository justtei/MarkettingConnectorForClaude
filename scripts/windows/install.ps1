<#
  Native Windows install, no Docker: for PCs where Docker Desktop can't run (no WSL / virtualization).
  Installs PostgreSQL 17, builds the apps, and runs api, mcp, worker and web as Windows services (NSSM)
  that start at boot, before anyone signs in. Optionally publishes the MCP server with Tailscale Funnel.

  Run in PowerShell **as administrator**, from the repo folder:
    powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -OwnerEmail you@example.com
  Re-run it after `git pull` or after editing .env; it's safe to run again (idempotent).

  Options:
    -OwnerEmail you@x.com   first dashboard owner (needed only on the first run, when .env doesn't exist)
    -PgDir D:\PostgreSQL\17 where PostgreSQL goes (default: <repo drive>:\PostgreSQL\17)
    -Funnel                 publish the MCP server at https://<this PC>.<tailnet>.ts.net (claude.ai) and the
                            dashboard at https://<this PC>.<tailnet>.ts.net:8443 (your Tailscale devices only)
                            With -Funnel it also installs the "Sandalez Watchdog" task (scripts\windows\watchdog.ps1).
    -SkipBuild              only (re)write the services and restart them
    -Uninstall              remove the four services and the watchdog (keeps PostgreSQL, the database and .env)
  See docs/windows-native.md.
#>
param(
  [string]$OwnerEmail = "",
  [string]$PgDir = "",
  [switch]$Funnel,
  [switch]$SkipBuild,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
Set-Location $Repo
$EnvFile = Join-Path $Repo ".env"
$Logs = Join-Path $Repo "logs"
$Tools = Join-Path $Repo "tools"
$Services = @(
  @{ Name = "sandalez-api";    Dir = "apps\api";    Args = "--import tsx src/server.ts"; Db = $true },
  @{ Name = "sandalez-mcp";    Dir = "apps\mcp";    Args = "--import tsx src/server.ts"; Db = $true },
  @{ Name = "sandalez-worker"; Dir = "apps\worker"; Args = "--import tsx src/main.ts";   Db = $true },
  @{ Name = "sandalez-web";    Dir = "apps\web\.next\standalone\apps\web"; Args = "server.js"; Db = $false }
)
$PgService = "postgresql-x64-17"
$PgZipName = "postgresql-17.11-5-windows-x64-binaries.zip"
$Tailscale = "C:\Program Files\Tailscale\tailscale.exe"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok($m) { Write-Host "    $m" -ForegroundColor Green }
function Fail($m) { Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }
function Run($exe, [string[]]$argv) {
  & $exe @argv
  # Only the first argument is shown: later ones can be passwords.
  if ($LASTEXITCODE -ne 0) { Fail "$exe $($argv | Select-Object -First 1) ... exited with code $LASTEXITCODE" }
}
function Get-EnvValue($key) {
  if (-not (Test-Path $EnvFile)) { return "" }
  $m = Select-String -Path $EnvFile -Pattern "^$key=(.*)$" | Select-Object -First 1
  if ($m) { return $m.Matches[0].Groups[1].Value.Trim() } else { return "" }
}
function Set-EnvValue($key, $value) {
  $lines = [System.Collections.Generic.List[string]](Get-Content $EnvFile)
  $i = -1
  for ($n = 0; $n -lt $lines.Count; $n++) { if ($lines[$n] -match "^$key=") { $i = $n; break } }
  if ($i -ge 0) { $lines[$i] = "$key=$value" } else { $lines.Add("$key=$value") }
  [IO.File]::WriteAllLines($EnvFile, $lines)   # UTF-8 without BOM, which Node's --env-file expects
}
function New-Secret([int]$bytes) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return -join ($b | ForEach-Object { $_.ToString("x2") })
}
function Stop-App($name) {
  # Stop a service, but never hang on it: after 20 s, end its process tree.
  $svc = Get-Service $name -ErrorAction SilentlyContinue
  if (-not $svc -or $svc.Status -eq "Stopped") { return }
  if ($svc.Status -ne "StopPending") { Stop-Service $name -Force -NoWait -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(20)
  while ((Get-Service $name).Status -ne "Stopped" -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  if ((Get-Service $name).Status -ne "Stopped") {
    $svcPid = (Get-CimInstance Win32_Service -Filter "Name='$name'").ProcessId
    if ($svcPid) { & taskkill.exe /PID $svcPid /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 2
  }
}
function Find-Nssm {
  $local = Join-Path $Tools "nssm.exe"
  if (Test-Path $local) { return $local }
  $c = Get-Command nssm -ErrorAction SilentlyContinue
  if ($c) { $src = $c.Source }
  else { $src = Get-ChildItem "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\NSSM.NSSM*" -Recurse -Filter nssm.exe -ErrorAction SilentlyContinue | Where-Object FullName -like "*win64*" | Select-Object -First 1 -ExpandProperty FullName }
  if (-not $src) { return $null }
  New-Item -ItemType Directory -Force $Tools | Out-Null
  Copy-Item $src $local -Force   # a stable copy inside the repo, so the services don't depend on a user profile
  return $local
}

if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole("Administrators")) {
  Fail "Run this in PowerShell opened with 'Run as administrator'."
}

$Nssm = Find-Nssm
if ($Uninstall) {
  Step "Removing the services (PostgreSQL, the database and .env are kept)"
  foreach ($s in $Services) {
    if (Get-Service $s.Name -ErrorAction SilentlyContinue) { Stop-App $s.Name; & $Nssm remove $s.Name confirm | Out-Null; Ok "removed $($s.Name)" }
  }
  Unregister-ScheduledTask -TaskName "Sandalez Watchdog" -Confirm:$false -ErrorAction SilentlyContinue
  if (Test-Path $Tailscale) { & $Tailscale funnel reset 2>$null | Out-Null; & $Tailscale serve reset 2>$null | Out-Null }
  exit 0
}

# ------------------------------------------------------------------ tools
Step "Checking Node.js and pnpm"
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Fail "Node.js is not installed. Install Node.js 22 LTS or newer from https://nodejs.org and run this again." }
$nodeMajor = [int]((& $node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 22) { Fail "Node.js $(& $node --version) is too old; install Node.js 22 LTS or newer." }
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { Run "npm.cmd" @("install", "-g", "pnpm@10"); $pnpm = (Get-Command pnpm.cmd).Source }
Ok "node $(& $node --version) at $node; pnpm $(& $pnpm --version)"

if (-not $Nssm) {
  Step "Installing NSSM (runs the apps as Windows services)"
  Run "winget" @("install", "-e", "--id", "NSSM.NSSM", "--accept-source-agreements", "--accept-package-agreements", "--silent")
  $Nssm = Find-Nssm
  if (-not $Nssm) { Fail "NSSM installed but nssm.exe was not found. Download it from https://nssm.cc/download and copy win64\nssm.exe to $Tools." }
}
Ok "nssm at $Nssm"

# ------------------------------------------------------------------ .env
Step "Settings file (.env)"
if (-not (Test-Path $EnvFile)) {
  if (-not $OwnerEmail) { Fail "First run: pass -OwnerEmail you@example.com (the first dashboard login)." }
  Run $pnpm @("install", "--frozen-lockfile")
  Run $pnpm @("setup:env", "--local", "--owner-email", $OwnerEmail)
}
$pgPassword = Get-EnvValue "POSTGRES_PASSWORD"
if (-not $pgPassword) { $pgPassword = New-Secret 24; Set-EnvValue "POSTGRES_PASSWORD" $pgPassword }
Set-EnvValue "DATABASE_URL" "postgresql://sandalez:$pgPassword@localhost:5432/sandalez?schema=public"
Set-EnvValue "API_URL" "http://localhost:3002"
Ok ".env at $EnvFile (DATABASE_URL points at the local PostgreSQL)"

# ------------------------------------------------------------------ PostgreSQL
Step "PostgreSQL 17"
if (-not $PgDir) { $PgDir = (Split-Path -Qualifier $Repo) + "\PostgreSQL\17" }
if ($PgDir -match "\s") { Fail "-PgDir must not contain spaces (the PostgreSQL installer can't take a quoted path here)." }
$superPassword = Get-EnvValue "PG_SUPERUSER_PASSWORD"
$PgBin = Join-Path $PgDir "bin"
$PgData = Join-Path $PgDir "data"
if (-not (Get-Service $PgService -ErrorAction SilentlyContinue)) {
  # The official binaries zip, not the EDB installer: the installer fails on trimmed-down Windows builds.
  if (-not (Test-Path (Join-Path $PgBin "postgres.exe"))) {
    # Download and unpack on the same drive as PgDir (Move-Item can't move folders across drives).
    $work = Split-Path $PgDir
    New-Item -ItemType Directory -Force $work | Out-Null
    $zip = Join-Path $work $PgZipName
    if (-not (Test-Path $zip)) {
      Write-Host "    downloading $PgZipName (about 380 MB)"
      Run "curl.exe" @("-fsSL", "-o", $zip, "https://get.enterprisedb.com/postgresql/$PgZipName")
    }
    $unpack = Join-Path $work "pgsql-unpack"
    Remove-Item $unpack -Recurse -Force -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force $unpack | Out-Null
    Run "tar.exe" @("-xf", $zip, "-C", $unpack, "--exclude", "pgsql/pgAdmin 4", "--exclude", "pgsql/StackBuilder", "--exclude", "pgsql/doc", "--exclude", "pgsql/symbols")
    Move-Item (Join-Path $unpack "pgsql") $PgDir
    Remove-Item $unpack, $zip -Recurse -Force
  }
  if (-not (Test-Path (Join-Path $PgData "PG_VERSION"))) {
    if (-not $superPassword) { $superPassword = New-Secret 24; Set-EnvValue "PG_SUPERUSER_PASSWORD" $superPassword }
    $pwFile = Join-Path $env:TEMP "pg-pw.txt"
    [IO.File]::WriteAllText($pwFile, $superPassword)
    & (Join-Path $PgBin "initdb.exe") -D $PgData -U postgres --pwfile=$pwFile -E UTF8 --locale=C --auth=scram-sha-256 | Out-Null
    $code = $LASTEXITCODE
    Remove-Item $pwFile -Force
    if ($code -ne 0) { Fail "initdb failed (exit code $code)." }
  }
  # The service runs as NETWORK SERVICE, which needs full access to the data folder.
  & icacls $PgData /grant "*S-1-5-20:(OI)(CI)F" /T /Q | Out-Null
  Run (Join-Path $PgBin "pg_ctl.exe") @("register", "-N", $PgService, "-D", $PgData, "-S", "auto")
}
$psql = Join-Path $PgBin "psql.exe"
if (-not (Test-Path $psql)) { Fail "PostgreSQL's psql.exe was not found under $PgBin." }
Set-Service $PgService -StartupType Automatic
Start-Service $PgService
if (-not $superPassword) { Fail "PostgreSQL was already installed. Add its 'postgres' password to .env as PG_SUPERUSER_PASSWORD=... and run again." }
$env:PGPASSWORD = $superPassword
$roleSql = "DO `$`$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='sandalez') THEN CREATE ROLE sandalez LOGIN; END IF; END`$`$; ALTER ROLE sandalez WITH LOGIN PASSWORD '$pgPassword';"
Run $psql @("-h", "localhost", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-c", $roleSql)
$hasDb = & $psql -h localhost -U postgres -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname='sandalez'"
if ($hasDb -ne "1") { Run $psql @("-h", "localhost", "-U", "postgres", "-d", "postgres", "-q", "-c", "CREATE DATABASE sandalez OWNER sandalez") }
Remove-Item Env:PGPASSWORD
Ok "service $PgService running; database 'sandalez' ready"

# ------------------------------------------------------------------ build
if (-not $SkipBuild) {
  Step "Installing packages, migrating the database, building the dashboard (5-10 minutes the first time)"
  foreach ($s in $Services) { if (Get-Service $s.Name -ErrorAction SilentlyContinue) { Stop-App $s.Name } }
  Run $pnpm @("install", "--frozen-lockfile")
  $env:DATABASE_URL = Get-EnvValue "DATABASE_URL"
  Run $pnpm @("--filter", "@sandalez/db", "exec", "prisma", "generate")
  Run $pnpm @("--filter", "@sandalez/db", "exec", "prisma", "migrate", "deploy")
  $env:NEXT_TELEMETRY_DISABLED = "1"
  Run $pnpm @("--filter", "web", "build")
  # The standalone server needs the static files next to it (as in the Dockerfile).
  $standalone = Join-Path $Repo "apps\web\.next\standalone\apps\web"
  Copy-Item (Join-Path $Repo "apps\web\.next\static") (Join-Path $standalone ".next") -Recurse -Force
  if (Test-Path (Join-Path $Repo "apps\web\public")) { Copy-Item (Join-Path $Repo "apps\web\public") $standalone -Recurse -Force }
  Ok "build done"
}

# ------------------------------------------------------------------ Tailscale (optional)
$dns = ""
if ($Funnel) {
  Step "Tailscale Funnel (public MCP address) and Serve (dashboard for your Tailscale devices)"
  if (-not (Test-Path $Tailscale)) { Fail "Tailscale is not installed (https://tailscale.com/download)." }
  $dns = ((& $Tailscale status --json | ConvertFrom-Json).Self.DNSName).TrimEnd(".")
  $out = & $Tailscale funnel --bg --yes 3001 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $out -match "not enabled|visit") {
    Write-Host $out
    Fail "Funnel isn't enabled for this tailnet yet. Open the link above (or https://login.tailscale.com/admin/settings/features), enable HTTPS and Funnel, then run this again with -Funnel."
  }
  # Signed webhooks (WhatsApp chats -> ads, Shopify) go to the API; everything else on 443 is the MCP server.
  & $Tailscale funnel --bg --yes --set-path=/webhooks http://127.0.0.1:3002/webhooks 2>&1 | Out-Null
  & $Tailscale serve --bg --yes --https=8443 3000 2>&1 | Out-Null
  Set-EnvValue "DASHBOARD_URL" "https://${dns}:8443"
  Set-EnvValue "AUTH_URL" "https://${dns}:8443"
  Set-EnvValue "MCP_DOMAIN" $dns
  Set-EnvValue "DOMAIN" "${dns}:8443"
  Ok "MCP (public):        https://$dns/mcp"
  Ok "dashboard (tailnet): https://${dns}:8443"
  Ok "webhooks (public):   https://$dns/webhooks/whatsapp  (docs/orders.md)"

  # Router/line reconnects can leave the Funnel relays with a dead route to this PC; the watchdog repairs it.
  $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $Repo 'scripts\windows\watchdog.ps1')`""
  $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 3)
  $boot = New-ScheduledTaskTrigger -AtStartup
  $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  Register-ScheduledTask -TaskName "Sandalez Watchdog" -Action $action -Trigger @($every, $boot) -Settings $settings -Principal $principal -Force | Out-Null
  Ok "watchdog: checks the public address every 3 minutes and repairs it (log: logs\watchdog.log)"
}

# ------------------------------------------------------------------ services
Step "Windows services"
New-Item -ItemType Directory -Force $Logs | Out-Null
$metaReady = (Get-EnvValue "META_ACCESS_TOKEN") -ne ""
foreach ($s in $Services) {
  $name = $s.Name
  if (-not (Get-Service $name -ErrorAction SilentlyContinue)) { & $Nssm install $name $node | Out-Null }
  & $Nssm set $name Application $node | Out-Null
  & $Nssm set $name AppParameters "--env-file=`"$EnvFile`" $($s.Args)" | Out-Null
  & $Nssm set $name AppDirectory (Join-Path $Repo $s.Dir) | Out-Null
  & $Nssm set $name AppEnvironmentExtra "NODE_ENV=production" "NEXT_TELEMETRY_DISABLED=1" "PORT=3000" "HOSTNAME=127.0.0.1" "LISTEN_HOST=127.0.0.1" | Out-Null
  & $Nssm set $name DisplayName "Sandalez Ads - $($name.Split('-')[1])" | Out-Null
  & $Nssm set $name Start SERVICE_AUTO_START | Out-Null
  & $Nssm set $name AppStdout (Join-Path $Logs "$name.log") | Out-Null
  & $Nssm set $name AppStderr (Join-Path $Logs "$name.log") | Out-Null
  & $Nssm set $name AppRotateFiles 1 | Out-Null
  & $Nssm set $name AppRotateOnline 1 | Out-Null
  & $Nssm set $name AppRotateBytes 10485760 | Out-Null
  & $Nssm set $name AppExit Default Restart | Out-Null
  & $Nssm set $name AppRestartDelay 10000 | Out-Null
  if ($s.Db) { & $Nssm set $name DependOnService $PgService | Out-Null }
  if ($metaReady) { Stop-App $name; Start-Service $name; Ok "$name running (log: logs\$name.log)" }
  else { Stop-App $name; Ok "$name installed (not started: Meta values are still empty)" }
}

Step "Done"
if (-not $metaReady) {
  Write-Host "    Next: fill the META_* values in $EnvFile (docs/meta-setup.md), then run this script again with -SkipBuild." -ForegroundColor Yellow
} else {
  $mcpCheck = if ($dns) { "https://$dns" } else { "http://localhost:3001" }
  Write-Host "    Check everything:  pnpm setup:check --env .env --mcp $mcpCheck --api http://localhost:3002 --web http://localhost:3000"
}
