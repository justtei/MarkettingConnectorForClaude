# Run it on a laptop (no server, no static IP)

The whole tool (database, MCP server, dashboard, API, worker) runs in Docker on your own Windows or Mac laptop. Claude Code on the same laptop connects to `http://localhost:3001/mcp`. You don't need a static IP, router changes, or a server.

You need a public address only if **claude.ai** or **other laptops** should reach it. A free Cloudflare Tunnel provides one; see [step 8](#8-optional-reach-it-from-claudeai-or-other-laptops).

| What you want | What to do |
|---|---|
| Claude Code on this laptop only | Steps 1–7 |
| claude.ai (web, desktop, phone), or Claude Code on other laptops | Steps 1–7, then step 8 |
| Always on, with nothing running on a laptop | Use a VPS instead: [deploy.md](deploy.md) |

## 1. Install the tools (once)

| Tool | Windows | Mac |
|---|---|---|
| Git | https://git-scm.com/download/win | `xcode-select --install` |
| Docker Desktop | https://www.docker.com/products/docker-desktop | same |
| Node.js 22 LTS | https://nodejs.org | same |
| pnpm 10 | `npm install -g pnpm@10` | same |
| Claude Code | `npm install -g @anthropic-ai/claude-code` | same |

The laptop needs at least 8 GB of RAM; Docker uses about 2–3 GB for this stack. Start Docker Desktop, and in Settings → General turn on **Start Docker Desktop when you sign in**.

## 2. Get the code

```bash
git clone https://github.com/justtei/MarkettingConnectorForClaude.git sandalez-ads
cd sandalez-ads
pnpm install
```

## 3. Create the settings file

```bash
pnpm setup:env --local --owner-email you@example.com
```

This writes `.env` with every password and secret generated for you. It never prints them, and running it again never overwrites them. It also points `docker compose` at the laptop setup, so later commands need no extra flags. At the end it lists what is still empty.

## 4. Add the Meta values

Open `.env` in any text editor and fill these from Meta Business Manager, following [meta-setup.md](meta-setup.md) step by step:

`META_ACCESS_TOKEN`, `META_APP_ID`, `META_APP_SECRET`, `META_AD_ACCOUNT_ID`, `META_PAGE_ID`, `META_INSTAGRAM_USER_ID`, `META_PIXEL_ID`, `META_BUSINESS_ID`, `WHATSAPP_PHONE_NUMBER`

Optional: the `SMTP_*` values for alert emails and the Monday report (a Gmail app password works).

Check them before starting anything:

```bash
pnpm setup:check --env .env
```

Fix every `FAIL` line; each one says exactly what's wrong (for example, "the token cannot see Page 999; visible: Sandalez (100200300400500)"). The database checks show `SKIP` at this point because the database isn't running yet.

## 5. Start it

```bash
docker compose up -d --build
```

The first build takes 5–10 minutes; later starts take seconds. The database is created and migrated automatically. Then check everything from inside the stack:

```bash
docker compose exec api pnpm setup:check:stack
```

It should end with `READY`.

- Dashboard: http://localhost:3000. Sign in with `OWNER_EMAIL` and `OWNER_PASSWORD` from `.env`.
- MCP server: http://localhost:3001/mcp

All ports listen on `127.0.0.1` only. Other devices on your Wi-Fi can't reach them.

## 6. Connect Claude Code

Windows (PowerShell), from the project folder:

```powershell
$t = (Select-String '^MCP_BEARER_TOKEN=(.*)' .env).Matches[0].Groups[1].Value
claude mcp add --scope user --transport http sandalez-ads http://localhost:3001/mcp --header "Authorization: Bearer $t"
```

Mac / Linux / Git Bash:

```bash
claude mcp add --scope user --transport http sandalez-ads http://localhost:3001/mcp \
  --header "Authorization: Bearer $(grep '^MCP_BEARER_TOKEN=' .env | cut -d= -f2)"
```

`--scope user` makes the tools available in every folder you open Claude Code in. Check the connection:

```bash
claude mcp list        # sandalez-ads: http://localhost:3001/mcp (HTTP) - ✔ Connected
```

Start a new `claude` session and ask: **"Check my Meta token and show the ad account."** See [usage.md](usage.md) for what to ask next.

## 7. Keep it running

- The containers restart by themselves when Docker Desktop starts, so after a reboot just sign in.
- The worker syncs from Meta every 3 hours and checks alerts only while the laptop is awake. On Windows, set Settings → System → Power → **Sleep when plugged in: Never**. On a Mac, use System Settings → Battery → Options → **Prevent automatic sleeping when the display is off**. A sync missed while the laptop slept runs on the next start (`RUN_SYNC_ON_START=true`).
- Back up the database weekly ([commands.md](commands.md#database)). Everything lives in a Docker volume on this laptop.

## 8. Optional: reach it from claude.ai or other laptops

claude.ai connects from Anthropic's servers, so it needs a public `https://` address. A Cloudflare Tunnel makes an outgoing connection from your laptop to Cloudflare, so it works behind any router, mobile hotspot or changing IP. Nothing is opened on your router.

### 8a. Quick tunnel: try it in 1 minute, no account

In `.env` set `COMPOSE_PROFILES=quick-tunnel`, then:

```bash
docker compose up -d
docker compose logs quick-tunnel | grep trycloudflare          # PowerShell: | Select-String trycloudflare
```

You get an address like `https://scotland-avenue-endorsed-earn.trycloudflare.com`. Your MCP server is `<that address>/mcp`. Check it:

```bash
docker compose exec api pnpm setup:check --mcp https://<that address>
```

The address **changes every time the tunnel restarts**, so use it for testing only. For daily use, set up 8b.

### 8b. Permanent tunnel on your domain (free Cloudflare account)

You need a domain whose DNS is managed by Cloudflare (adding a domain to Cloudflare is free; you change its nameservers once at your registrar).

1. Go to https://one.dash.cloudflare.com → **Networks → Tunnels → Create a tunnel** → **Cloudflared**. Name it `sandalez`.
2. On the "Install connector" page, copy the long token after `--token` (starts with `eyJ`). Put it in `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...
   COMPOSE_PROFILES=tunnel
   ```
3. Add the public hostnames (newer dashboards call them **Published application routes**). Keep them in this order:

   | Subdomain | Path | Service |
   |---|---|---|
   | `mcp.yourdomain.com` | *(empty)* | `HTTP` → `mcp:3001` |
   | `ads.yourdomain.com` | `webhooks/*` | `HTTP` → `api:3002` (only for WhatsApp / Shopify webhooks) |
   | `ads.yourdomain.com` | *(empty)* | `HTTP` → `web:3000` |

4. In `.env` set `DASHBOARD_URL=https://ads.yourdomain.com`, `DOMAIN=ads.yourdomain.com` and `MCP_DOMAIN=mcp.yourdomain.com`, then:
   ```bash
   docker compose up -d
   docker compose exec api pnpm setup:check:stack --mcp https://mcp.yourdomain.com --web https://ads.yourdomain.com
   ```
   It should end with `READY`. With `DASHBOARD_URL` set, open the dashboard at `https://ads.yourdomain.com`; sign-in redirects there.

The addresses stay the same across restarts, IP changes and Wi-Fi networks. Optional: in `.env` set `MCP_IP_ALLOWLIST=160.79.104.0/21` so only claude.ai's servers can call the MCP server. Don't set it if Claude Code on other laptops also connects, because their IPs change.

Then connect:

- **claude.ai**: [connect-claude.md](connect-claude.md#claudeai-web--desktop--mobile), using `https://mcp.yourdomain.com/mcp`.
- **Claude Code on another laptop**: on that laptop, run
  ```bash
  claude mcp add --scope user --transport http sandalez-ads https://mcp.yourdomain.com/mcp --header "Authorization: Bearer <MCP_BEARER_TOKEN>"
  ```
  Send the token privately (not over email or a group chat). Only the host laptop runs Docker; the others need Claude Code only.

Treat `MCP_BEARER_TOKEN` and `MCP_PATH_SECRET` like passwords: anyone holding one can use the tools (the spending guards still apply). To rotate one, clear it in `.env`, run `pnpm setup:env --local` and `docker compose up -d`, then re-add the connector everywhere.

## Updating

```bash
git pull
pnpm install
pnpm setup:env --local          # adds any new settings; keeps yours
docker compose up -d --build    # migrations run automatically
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `required variable DOMAIN is missing a value` | Run `pnpm setup:env --local` (it sets `DOMAIN=localhost:3000`). |
| `failed to connect to the docker API` | Docker Desktop isn't running; start it. |
| `claude mcp list` shows **Failed to connect** | `docker compose ps`: is `mcp` up and healthy? Re-run step 6 if you changed `MCP_BEARER_TOKEN`. |
| Something exits or restarts | `docker compose logs --tail 50 <service>` (`mcp`, `api`, `web`, `worker`, `migrate`, `postgres`, `tunnel`). |
| Login loops back to the sign-in page | Open the dashboard at the address in `DASHBOARD_URL` (or http://localhost:3000 when it's empty). |
| Tunnel shows `Unauthorized` / `invalid token` | Copy `CLOUDFLARE_TUNNEL_TOKEN` again; it's only the `eyJ...` part. |
| Containers stopped after Windows killed them for memory | Close other heavy apps, then `docker compose up -d`. In Docker Desktop → Settings → Resources, give it at least 4 GB. |
| Port 3000/3001/3002 already in use | Another app uses it; stop that app (on Windows, `netstat -ano | findstr :3001` shows its process ID). |
