# Windows PC without Docker (+ Tailscale for claude.ai)

Use this when Docker Desktop can't run on the PC: trimmed-down Windows builds without WSL, older laptops with virtualization turned off, or less than 8 GB of RAM. The tool runs directly on Windows:

- **PostgreSQL 17** as a Windows service
- **api, mcp, worker, web** as Windows services (via [NSSM](https://nssm.cc)). They start at boot, before anyone signs in, and restart themselves if they crash.
- **Tailscale Funnel** gives the MCP server a fixed public HTTPS address for claude.ai, such as `https://desktop-c9qoopq.tailbcb433.ts.net/mcp`. You don't need a domain, a static IP or router changes. **Tailscale Serve** puts the dashboard at `https://desktop-c9qoopq.tailbcb433.ts.net:8443`, reachable only from your own Tailscale devices.

It uses less memory than Docker (about 1 GB in total).

## What the PC needs

- Windows 10 or 11, 8 GB RAM, about 3 GB free disk (put the repo on the drive with the most space)
- Node.js 22 LTS or newer (https://nodejs.org), Git (`winget install -e --id Git.Git`)
- Tailscale, signed in to your tailnet (https://tailscale.com/download), only for claude.ai / remote access
- An administrator account

`install.ps1` installs PostgreSQL 17 (from the official binaries zip, so it also works where the PostgreSQL installer fails), pnpm and NSSM (through winget) itself. It needs `curl.exe` and `tar.exe`, which are built into Windows 10 and 11.

## Install

In **PowerShell as administrator**:

```powershell
git clone https://github.com/justtei/MarkettingConnectorForClaude.git D:\sandalez-ads
cd D:\sandalez-ads
powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -OwnerEmail you@example.com
```

The first run takes about 10–15 minutes. It:

1. Creates `.env` with every secret generated (`pnpm setup:env --local`) and points `DATABASE_URL` at the local PostgreSQL.
2. Installs PostgreSQL 17 under `D:\PostgreSQL\17` (or `-PgDir`) with its data in `D:\PostgreSQL\17\data`, as the service `postgresql-x64-17`, and creates the `sandalez` database and user. The database passwords go into `.env`: `POSTGRES_PASSWORD` for the app, `PG_SUPERUSER_PASSWORD` for the `postgres` admin user.
3. Installs the packages, applies the database migrations and builds the dashboard.
4. Registers four services: **Sandalez Ads - api / mcp / worker / web**. Logs go to `D:\sandalez-ads\logs\`.

The services are created but not started until the Meta values are filled in. Next:

1. Open `D:\sandalez-ads\.env` in Notepad and fill the `META_*` values ([meta-setup.md](meta-setup.md)), plus `SMTP_*` if you want emails.
2. Check them: `pnpm setup:check --env .env`
3. Start everything, and publish it with Tailscale:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -SkipBuild -Funnel
   ```

### Turning on Tailscale Funnel (once per tailnet)

Funnel needs **HTTPS certificates** and the **funnel** permission in your tailnet:

1. https://login.tailscale.com/admin/dns: under HTTPS Certificates, click **Enable HTTPS**.
2. https://login.tailscale.com/admin/acls: the policy must give the PC the `funnel` attribute. New tailnets already have:
   ```json
   "nodeAttrs": [{ "target": ["autogroup:member"], "attr": ["funnel"] }]
   ```
   If it's missing, add it and click Save.

If either is missing, `install.ps1 -Funnel` prints Tailscale's link to fix it and stops. Run it again afterwards.

Funnel serves **only the MCP server** (port 3001) publicly, and every request still needs `MCP_BEARER_TOKEN` or the `MCP_PATH_SECRET` URL. The dashboard is on Serve, so only devices signed in to your tailnet can open it. To accept MCP calls only from claude.ai, set `MCP_IP_ALLOWLIST=160.79.104.0/21` in `.env` and re-run with `-SkipBuild`. Leave it empty if Claude Code on other laptops also connects through the public address.

## Check and connect

```powershell
pnpm setup:check --env .env --mcp https://<pc>.<tailnet>.ts.net --api http://localhost:3002 --web http://localhost:3000
```

It should end with `READY`. Then:

- **claude.ai**: Customize → Connectors → Add custom connector → URL `https://<pc>.<tailnet>.ts.net/mcp/<MCP_PATH_SECRET>`, Authentication **No sign-in**. If your dialog has Request headers, you can use `https://<pc>.<tailnet>.ts.net/mcp` with header `authorization: Bearer <MCP_BEARER_TOKEN>` instead. See [connect-claude.md](connect-claude.md).
- **Claude Code on any laptop in your tailnet**: `claude mcp add --scope user --transport http sandalez-ads https://<pc>.<tailnet>.ts.net/mcp --header "Authorization: Bearer <MCP_BEARER_TOKEN>"`
- **Dashboard**: `https://<pc>.<tailnet>.ts.net:8443` from any of your Tailscale devices. Sign in with `OWNER_EMAIL` / `OWNER_PASSWORD` from `.env`.

Then see [usage.md](usage.md).

## Day to day

| Task | Command (PowerShell as administrator, in `D:\sandalez-ads`) |
|---|---|
| Status | `Get-Service sandalez-*, postgresql-x64-17` |
| Restart after editing `.env` | `Restart-Service sandalez-*` |
| Logs | `Get-Content logs\sandalez-mcp.log -Tail 50` (also `-api`, `-web`, `-worker`) |
| Update to the latest code | `git pull` then `powershell -ExecutionPolicy Bypass -File scripts\windows\install.ps1 -Funnel` |
| Add a dashboard user | `pnpm user:add staff@x.com "a-long-password" staff` |
| Run a job now | `pnpm job sync` (or `alerts`, `weekly_report`, `token_check`, `shop_sync`) |
| Back up the database | `& "D:\PostgreSQL\17\bin\pg_dump.exe" -h localhost -U sandalez -d sandalez --clean --if-exists -f backup.sql` (password: `POSTGRES_PASSWORD` in `.env`) |
| Restore a backup | `& "D:\PostgreSQL\17\bin\psql.exe" -h localhost -U sandalez -d sandalez -v ON_ERROR_STOP=1 -f backup.sql` |
| SQL shell | `& "D:\PostgreSQL\17\bin\psql.exe" -h localhost -U sandalez -d sandalez` |
| Tailscale addresses | `tailscale funnel status` |
| Remove the services | `... install.ps1 -Uninstall` (keeps PostgreSQL, the data and `.env`) |

**Keep the PC on.** claude.ai can reach the tool only while the PC is running and online. Set Settings → System → Power & sleep → **Sleep: Never** (when plugged in), and turn on Tailscale's "Run unattended" option so it stays connected without anyone signed in.
