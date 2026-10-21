<#
  Keeps the Windows install reachable. install.ps1 -Funnel runs this every 3 minutes (and at boot) as the
  scheduled task "Sandalez Watchdog", as SYSTEM.

  1. Starts PostgreSQL and any sandalez-* service that has stopped; restarts the MCP server if it stops answering.
  2. Tests the public address the way claude.ai reaches it: through Tailscale's public Funnel relays, not locally.
     When the router or internet line reconnects, the relays can keep a dead route to this PC ("Broken pipe")
     while everything looks fine here. If the test fails twice in a row, it re-publishes Funnel; if that
     doesn't help, it restarts Tailscale (at most once every 10 minutes).
  Log: logs\watchdog.log (only problems and repairs).
#>
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$Logs = Join-Path $Repo "logs"
$LogFile = Join-Path $Logs "watchdog.log"
$StateFile = Join-Path $Logs "watchdog.state.json"
$Tailscale = "C:\Program Files\Tailscale\tailscale.exe"
$Services = @("postgresql-x64-17", "sandalez-api", "sandalez-mcp", "sandalez-worker", "sandalez-web")

function Log($m) {
  New-Item -ItemType Directory -Force $Logs | Out-Null
  Add-Content -Path $LogFile -Value ("{0}  {1}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $m)
  $lines = Get-Content $LogFile
  if ($lines.Count -gt 2000) { $lines | Select-Object -Last 1000 | Set-Content $LogFile }
}
function Get-Code($url, [string[]]$extra = @()) {
  $code = & curl.exe -s -o NUL -m 15 -w "%{http_code}" @extra $url 2>$null
  if ($code) { return [int]$code } else { return 0 }
}
function Test-Public($dns) {
  # Resolve with public DNS (MagicDNS on this PC would give the tailnet address and skip the relays).
  $ips = @()
  foreach ($server in @("1.1.1.1", "8.8.8.8")) {
    try {
      $ips = @(Resolve-DnsName -Name $dns -Server $server -Type A -DnsOnly -ErrorAction Stop | Where-Object { $_.IPAddress } | ForEach-Object { $_.IPAddress })
      if ($ips.Count) { break }
    } catch {}
  }
  if (-not $ips.Count) { return $null }   # no internet: nothing here can fix that
  foreach ($ip in $ips) {
    if ((Get-Code "https://$dns/health" @("--resolve", "${dns}:443:$ip")) -eq 200) { return $true }
  }
  return $false
}
function Publish-Funnel {
  & $Tailscale serve reset 2>&1 | Out-Null
  & $Tailscale funnel --bg --yes 3001 2>&1 | Out-Null
  & $Tailscale funnel --bg --yes --set-path=/webhooks http://127.0.0.1:3002/webhooks 2>&1 | Out-Null
  & $Tailscale serve --bg --yes --https=8443 3000 2>&1 | Out-Null
}

$state = @{ failures = 0; lastTailscaleRestart = "2000-01-01T00:00:00" }
if (Test-Path $StateFile) {
  try { $s = Get-Content $StateFile -Raw | ConvertFrom-Json; $state.failures = [int]$s.failures; $state.lastTailscaleRestart = [string]$s.lastTailscaleRestart } catch {}
}

# 1. Services
foreach ($name in $Services + @("Tailscale")) {
  $svc = Get-Service $name -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -eq "Stopped") {
    Log "$name was stopped; starting it"
    Start-Service $name -ErrorAction SilentlyContinue
  }
}
if ((Get-Code "http://127.0.0.1:3001/health") -ne 200) {
  Start-Sleep -Seconds 20   # it may be starting
  if ((Get-Code "http://127.0.0.1:3001/health") -ne 200) {
    Log "MCP server not answering on 127.0.0.1:3001; restarting sandalez-mcp"
    $svcPid = (Get-CimInstance Win32_Service -Filter "Name='sandalez-mcp'").ProcessId
    if ($svcPid) { & taskkill.exe /PID $svcPid /T /F 2>&1 | Out-Null }
    Start-Sleep -Seconds 3
    Start-Service sandalez-mcp -ErrorAction SilentlyContinue
    exit 0   # test the public address on the next run
  }
}

# 2. Public address through the Funnel relays
if (-not (Test-Path $Tailscale)) { exit 0 }
$status = & $Tailscale status --json 2>$null | ConvertFrom-Json
$dns = if ($status -and $status.Self) { ([string]$status.Self.DNSName).TrimEnd(".") } else { "" }
if (-not $dns -or $status.BackendState -ne "Running") {
  Log "Tailscale is not running (state: $($status.BackendState)); restarting it"
  Restart-Service Tailscale -Force -ErrorAction SilentlyContinue
  exit 0
}

$ok = Test-Public $dns
if ($null -eq $ok) { exit 0 }
if ($ok) {
  if ($state.failures -gt 0) { Log "public address OK again" }
  $state.failures = 0
} else {
  $state.failures++
  Log "public address https://$dns not reachable through the Funnel relays (failure $($state.failures))"
  if ($state.failures -ge 2) {
    Log "re-publishing Funnel"
    Publish-Funnel
    Start-Sleep -Seconds 20
    $ok = Test-Public $dns
    $since = (Get-Date) - [datetime]$state.lastTailscaleRestart
    if ($ok -eq $false -and $since.TotalMinutes -ge 10) {
      Log "still unreachable; restarting Tailscale"
      Restart-Service Tailscale -Force -ErrorAction SilentlyContinue
      $state.lastTailscaleRestart = (Get-Date).ToString("s")
      Start-Sleep -Seconds 45
      $ok = Test-Public $dns
    }
    if ($ok) { Log "repaired: public address OK"; $state.failures = 0 } else { Log "still unreachable; will try again" }
  }
}
$state | ConvertTo-Json | Set-Content $StateFile
