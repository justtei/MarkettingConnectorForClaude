# Deployment on a VPS (always on)

## Do I need to deploy?

| How you want to use it | Deploy? |
|---|---|
| **claude.ai** (web, desktop app, phone) | **It needs a public `https://` address**, because claude.ai calls the MCP server from Anthropic's servers: either this VPS, or a laptop with a Cloudflare Tunnel (last row). |
| The **dashboard** for you and staff from anywhere | A VPS, or a laptop with a Cloudflare Tunnel. |
| **Worker** jobs: sync every 3 hours, alerts, Monday email, token check | They run wherever the stack runs, but only while that machine is on. |
| **Claude Code** on your own PC only | No: run the stack on the laptop, see [local-laptop.md](local-laptop.md). Alerts and syncs then run only while the laptop is on. |
| claude.ai, but no server and no static IP | Run it on a laptop with a free Cloudflare Tunnel: [local-laptop.md, step 8](local-laptop.md#8-optional-reach-it-from-claudeai-or-other-laptops). The laptop must stay on. |

Recommended for always-on use: one small Linux VPS (2 vCPU, 2–4 GB RAM, about USD 5–12/month; e.g. Hetzner, DigitalOcean, Contabo, or AWS Lightsail in Mumbai or Singapore for low latency from Pakistan) with Docker, and two DNS records on your domain. Everything below runs on it, with automatic HTTPS.

**cPanel:** shared cPanel hosting can't run this (it needs long-running Node processes, PostgreSQL and Docker). A cPanel/WHM **VPS with root access** works: install Docker and follow the steps below, but because Apache already uses ports 80/443, either point the two subdomains to `127.0.0.1:3000` / `127.0.0.1:3001` with Apache reverse-proxy rules, or skip Caddy and use the Cloudflare Tunnel from [local-laptop.md](local-laptop.md) on the VPS.

## Steps

Docker Compose runs `postgres`, `migrate` (a one-shot `prisma migrate deploy`), `api`, `mcp`, `worker`, `web` and `caddy` (automatic HTTPS from Let's Encrypt).

1. **Server.** Create an Ubuntu 24.04 VPS, open ports 22, 80 and 443, and install Docker, Node and pnpm:
   ```bash
   curl -fsSL https://get.docker.com | sh
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
   sudo npm install -g pnpm@10
   ```
2. **DNS.** Point two A records at the VPS IP: `DOMAIN` (dashboard, e.g. `ads.sandalez.pk`) and `MCP_DOMAIN` (e.g. `mcp.sandalez.pk`).
3. **Code.**
   ```bash
   git clone https://github.com/justtei/MarkettingConnectorForClaude.git sandalez-ads && cd sandalez-ads
   pnpm install
   ```
4. **Env file.** `pnpm setup:env --out .env --owner-email you@example.com --domain ads.sandalez.pk --mcp-domain mcp.sandalez.pk` generates every secret the tool can make itself (`MCP_BEARER_TOKEN`, `MCP_PATH_SECRET`, `API_INTERNAL_SECRET`, `AUTH_SECRET`, `POSTGRES_PASSWORD`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, `OWNER_PASSWORD`). It never overwrites a value that's already set and never prints the secrets. It then lists what's still empty:
   - the Meta values (see [meta-setup.md](meta-setup.md)); only you can get these, from Business Manager
   - optional: `SMTP_*` for alerts and the Monday report, `SHOPIFY_WEBHOOK_SECRET`
5. **Check the file.** `pnpm setup:check --env .env --production` checks that every value is present and well-formed, that no dev/mock values are left, that the token is valid with all permissions, that the ad account is PKR / Asia/Karachi / active, and that the token can see the Page, Instagram account, pixel and business. Fix every `FAIL` it lists. (The database checks are skipped until the stack runs.)
6. **Start.** `docker compose up -d --build`. The first build takes a few minutes; the database is created and migrated automatically.
7. **Check the running stack.** `docker compose exec api pnpm setup:check:stack --production --mcp https://<MCP_DOMAIN> --web https://<DOMAIN>` checks the database and migrations, the SMTP login, and that Claude can connect over HTTPS with both the bearer token and the path-secret URL. It should end with `READY`.
8. **Sign in.** Open `https://<DOMAIN>` and sign in with `OWNER_EMAIL` / `OWNER_PASSWORD` (the password is in `.env`). Settings should show the token as valid. Press "Sync last 30 days".
9. **Connect Claude** ([connect-claude.md](connect-claude.md)), then see [usage.md](usage.md).

Secrets live only in `.env` on the server (`chmod 600 .env`). The browser never sees the Meta token or the internal API secret. The API service isn't exposed publicly; Caddy only forwards `/webhooks/*` to it.

Day-to-day commands (logs, restarts, users, worker jobs, database backup and restore) are in [commands.md](commands.md).

## Updating

```bash
git pull && docker compose up -d --build   # migrations run automatically before the apps start
```

## Backups

```bash
docker compose exec postgres pg_dump -U sandalez sandalez | gzip > backup-$(date +%F).sql.gz
```

Run it daily from cron (`crontab -e`: `0 3 * * * cd /root/sandalez-ads && docker compose exec -T postgres pg_dump -U sandalez sandalez | gzip > /root/backups/sandalez-$(date +\%F).sql.gz`) and copy the backups off the server. To restore, see [commands.md](commands.md#database).

## Demo / staging without a real ad account

`docker-compose.demo.yml` adds the Meta mock and publishes ports 3000 (dashboard), 3001 (MCP) and 3002 (API) without Caddy. Create `.env.demo` with the mock values:

```
META_ACCESS_TOKEN=test-token
META_APP_ID=1111111111
META_APP_SECRET=test-app-secret
META_AD_ACCOUNT_ID=act_1234567890
META_PAGE_ID=100200300400500
META_INSTAGRAM_USER_ID=17841400000000000
META_PIXEL_ID=555666777888999
META_BUSINESS_ID=999888777666555
WHATSAPP_PHONE_NUMBER=923499066816
META_GRAPH_BASE_URL=http://meta-mock:4010
API_URL=http://api:3002
POSTGRES_PASSWORD=demo
DOMAIN=localhost:3000
MCP_DOMAIN=localhost:3001
MCP_BEARER_TOKEN=<24+ chars>
API_INTERNAL_SECRET=<24+ chars>
AUTH_SECRET=<32+ chars>
OWNER_EMAIL=owner@example.com
OWNER_PASSWORD=<8+ chars>
```

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml --env-file .env.demo up -d --build
E2E_MEDIA_URL=http://meta-mock:4010/__mock/media/sample.jpg E2E_EMAIL=... E2E_PASSWORD=... pnpm test:e2e
```
