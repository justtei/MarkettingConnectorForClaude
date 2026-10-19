# Commands reference

Run these from the project folder. On a **laptop** (after `pnpm setup:env --local`), plain `docker compose` already uses the laptop setup. On a **VPS**, `docker compose` uses `docker-compose.yml` with Caddy. The commands are the same for both.

## Stack

| Task | Command |
|---|---|
| Start, or apply changes to `.env` | `docker compose up -d` |
| Rebuild after `git pull` | `docker compose up -d --build` |
| Status and health | `docker compose ps` |
| Logs (follow) | `docker compose logs -f mcp` (or `api`, `web`, `worker`, `migrate`, `postgres`, `caddy`, `tunnel`, `quick-tunnel`) |
| Restart one service | `docker compose restart worker` |
| Stop (data kept) | `docker compose down` |
| Full health check | `docker compose exec api pnpm setup:check:stack` (VPS: add `--production --mcp https://<MCP_DOMAIN> --web https://<DOMAIN>`) |

## Setup

| Task | Command |
|---|---|
| Create or complete the env file | Laptop: `pnpm setup:env --local --owner-email you@x.com`. VPS: `pnpm setup:env --out .env --owner-email you@x.com --domain ads.x.com --mcp-domain mcp.x.com` |
| Check the env file and Meta values before starting | `pnpm setup:check --env .env` (add `--production` on a VPS) |
| Check a running MCP server from anywhere | `pnpm setup:check --env .env --mcp https://mcp.x.com` |

`setup:env` never overwrites a value that's already set and never prints secrets. `setup:check` is read-only; it ends with `READY` or a list of what to fix.

## Database

PostgreSQL 17 runs in the `postgres` container, and its data lives in the Docker volume `pgdata`, which survives `down`, restarts and rebuilds. **Migrations run automatically** (the `migrate` service runs `prisma migrate deploy` before the apps start), so after an update you only need `docker compose up -d --build`.

| Task | Command |
|---|---|
| Back up | `docker compose exec postgres pg_dump -U sandalez -d sandalez --clean --if-exists -f /tmp/backup.sql` then `docker compose cp postgres:/tmp/backup.sql ./backup-2026-10-19.sql` |
| Restore a backup (replaces current data) | `docker compose cp ./backup-2026-10-19.sql postgres:/tmp/restore.sql` then `docker compose exec postgres psql -U sandalez -d sandalez -v ON_ERROR_STOP=1 -f /tmp/restore.sql` |
| SQL shell | `docker compose exec postgres psql -U sandalez -d sandalez` |
| Migration status | `docker compose exec api pnpm --filter @sandalez/db exec prisma migrate status` |
| Run migrations by hand | `docker compose run --rm migrate` |
| **Erase everything** and start empty | `docker compose down -v` (deletes the `pgdata` volume, so back up first) |

The two-step backup (dump inside the container, then `cp` out) works the same in PowerShell, cmd, bash and zsh, and avoids PowerShell's UTF-16 `>` redirection. Keep backups off the machine as well (Google Drive, USB). Tables: campaigns, ad sets, ads and creatives mirrored from Meta; daily stats; orders; alerts and alert events; assets; WhatsApp chats; reports; settings; users; and the audit log.

## Users (dashboard logins)

| Task | Command |
|---|---|
| Add a staff user, or reset a password | `docker compose exec api pnpm user:add staff@x.com 'a-long-password' staff` |
| Add another owner | `docker compose exec api pnpm user:add partner@x.com 'a-long-password' owner` |

The first owner (`OWNER_EMAIL` / `OWNER_PASSWORD` from `.env`) is created on the first start. The owner can also add and remove users in the dashboard under Settings. Staff can see everything and log orders; creating, activating and changing budgets or targeting are owner-only.

## Worker jobs (run one now)

| Job | Command | Runs automatically |
|---|---|---|
| Sync from Meta | `docker compose exec worker pnpm job sync` | every 3 hours (`SYNC_CRON`) |
| Check alerts | `docker compose exec worker pnpm job alerts` | every 3 hours, at :15 (`ALERTS_CRON`) |
| Weekly report email | `docker compose exec worker pnpm job weekly_report` | Monday 09:00 (`WEEKLY_REPORT_CRON`) |
| Token expiry check | `docker compose exec worker pnpm job token_check` | daily 08:00 (`TOKEN_CHECK_CRON`) |

Times are Asia/Karachi. Change the schedules in `.env`, then `docker compose up -d`.

## Without Docker (development)

Needs Node 22, pnpm 10 and a Postgres. See the README's "Development" section: `pnpm dev:mock`, `pnpm dev:api`, `pnpm dev:mcp`, `pnpm dev:worker`, `pnpm dev:web`, plus `pnpm db:deploy` for migrations, `pnpm test`, `pnpm test:e2e`, `pnpm typecheck` and `pnpm docs:tools`.
