# Using the tool

There are two ways in: **Claude** (chat; it calls the 43 MCP tools for you) and the **dashboard** (web, works on a phone). Both use the same rules, data and audit log.

## Talking to Claude

Use plain language with real numbers: city, budget in PKR per day, ages, gender, product. Claude picks the tools. A few things always hold:

- **Anything new is created PAUSED.** Nothing spends until you say so.
- **Before spending money, Claude asks you first.** That covers activating, raising or lowering a budget, changing targeting, and bulk changes. Reply "yes" to go ahead. The server refuses these without that confirmation, whatever is typed.
- **Caps are enforced on the server:** at most PKR 2,000/day per ad set, and a budget can't rise by more than 30% in one change. The owner can change both in Settings.
- **Only the Sandalez ad account.** Other account IDs are refused.
- **Nothing is deleted.** You pause or archive instead.

### First things to try

| Ask | What happens |
|---|---|
| "Check my Meta token and show the ad account." | `check_token`, `get_account`: token health and expiry, plus currency, timezone and status |
| "How did my ads do in the last 7 days?" | `get_insights`: spend, chats, cost per chat, CTR, by campaign |
| "Which ads are tired?" | `detect_fatigue`: frequency and CTR drop, with what to do about it |
| "Where am I wasting money?" | `wasted_spend_report`, `placement_report` |

### Launch a click-to-WhatsApp campaign

> Make a Karachi click-to-WhatsApp campaign for the pearl flats video, PKR 600/day, women 20–40. Text: "Pearl flats, cash on delivery". Headline: "Order on WhatsApp".

Claude uploads the video (or uses one already uploaded) and calls `create_ctwa_campaign`. That makes the campaign, ad set, creative with the WhatsApp welcome message, and ad in one step, all PAUSED. If any step fails, the partial objects are removed. Claude then asks:

> Created SZ-KHI-Pearl-WA, PAUSED. Want me to activate it?

Reply **yes**. Meta reviews the ads (usually minutes to a few hours) before they run. Check in Ads Manager that the preview looks right the first time (see "Before the first real campaign" in the README).

More examples:

- "Copy the Karachi campaign for Lahore at PKR 500/day." → `duplicate_campaign` (PAUSED)
- "Add this new image as a second ad in the Karachi ad set." → `upload_image`, `add_ad_to_adset`
- "Make a carousel with these 3 product images." → `create_creative` (carousel)
- "Retarget people who visited the website in the last 30 days with the catalog." → `create_custom_audience`, `create_catalog_campaign`
- "Make a 1% lookalike of my customer list." → `create_custom_audience` (customer list; phone numbers and emails are normalised and hashed before upload), `create_lookalike`

### Instagram DMs, Messenger, or several apps at once

Ads can send people to WhatsApp, Instagram DMs or Messenger, or to several of them. With several, each ad gets one button per app and Meta picks the best one for each person.

> Make a Sales campaign for the "Which Pair Is Yours?" video, Instagram + WhatsApp, PKR 600/day, women 20–40 in Karachi, with 3 versions of the text.

Claude calls `create_ctwa_campaign` with `objective: OUTCOME_SALES`, `messaging_apps: ["whatsapp","instagram_direct"]` and `primary_texts`. The ad set and the ad must name the same apps: an Instagram + WhatsApp ad set (`MESSAGING_INSTAGRAM_DIRECT_WHATSAPP`) needs an ad with both buttons. If they don't match, the tool says which one to change before Meta is called. Meta doesn't let an ad set's destination change later, so switching apps means a new ad set.

Also available:

| Ask | What it uses |
|---|---|
| "Target 3 km around Gulistan-e-Johar and DHA" | map pins (`pins`: latitude, longitude, radius) |
| "Give the ad 3 versions of the text and 2 headlines" | `primary_texts`, `headlines` |
| "Turn on text improvements and auto-crop, but not comments" | `creative_features` (Advantage+ creative features, one by one; Meta retired the old all-in-one "standard enhancements") |
| "Delete the empty WhatsApp-only ad set" | `delete_object`: only for paused things, after you say yes; it removes what's inside too and can't be undone. Past spend and orders stay in the dashboard |
| "Copy the 10 Oct campaign" | `duplicate_campaign`. If Meta's own copy refuses an older campaign, the tool rebuilds it piece by piece (`method: rebuilt`) |

### Day-to-day management

- "Pause the Lahore ad set." Pausing is safe, so it's done right away.
- "Raise the Karachi budget to 700." Claude confirms first; more than +30% or above the cap is refused with the reason.
- "Change the age range to 22–45." → `update_targeting`, after a confirmation.
- "Pause everything except Karachi." → `bulk_update`

### Orders and cost per order (COD)

Meta can't see cash-on-delivery orders that come through WhatsApp. Log them daily, from Claude or from the dashboard's Orders page:

> Log today: Karachi pearl flats ad, 12 chats, 5 orders, 1 refused, PKR 17,500 revenue.

Then ask "**What's my real cost per order this week, by ad?**" (`get_cost_per_order`) to see which ads actually sell, not just which get chats. If the WhatsApp Cloud API webhook is set up ([meta-setup.md](meta-setup.md#optional-integrations)), chat counts fill in automatically.

### Alerts and reports

- "Alert me if cost per chat goes above PKR 150." → `set_alert`. It's checked every 3 hours, shows up in the dashboard, and is emailed if SMTP is set.
- "Give me the weekly report." → `weekly_report`. It's also emailed every Monday at 09:00 if SMTP is set.
- "What changed in the last few days, and who did it?" → `get_activity_log`

### Tool permissions in claude.ai

Under Customize → Connectors → Sandalez Ads, set the tools that change live spend or delete (`set_status`, `update_budget`, `update_targeting`, `bulk_update`, `delete_object`) to **Needs approval** and the rest to **Always allow**. That way you also click "Allow" in Claude's UI on top of the server's own confirmation. In Claude Code, you approve each tool call unless you allow it in `/permissions`.

The full list of tools with every parameter is in [mcp-tools.md](mcp-tools.md).

## The dashboard

Open `http://localhost:3000` on a laptop, or `https://<DOMAIN>` on a VPS or tunnel, and sign in.

| Page | What it's for |
|---|---|
| Overview | Spend, chats, orders, cost per chat and per order and refusal rate for the chosen period; daily trend charts; "Sync from Meta" |
| Campaigns → ad detail | The campaign tree with stats; pause, activate, archive, duplicate and change budgets with a confirm dialog (owner) |
| New | A step-by-step click-to-WhatsApp campaign wizard (created PAUSED) |
| Orders | Log daily chats, orders, refusals and revenue per ad |
| Creatives | Upload images and videos (up to 40 MB each, or from a public URL); spend and cost per chat for each creative |
| Insights | Live from Meta: breakdowns by age and gender, placements, fatigue, wasted spend |
| Audiences | Custom and lookalike audiences |
| Alerts | Set thresholds, see fired alerts |
| Activity | The audit log: every change, by whom (Claude, dashboard user or worker), with before and after |
| Settings | Token status and permissions, rate-limit usage, budget caps, alert email, users (owner), weekly report "Generate now", "Sync last 30 days" |

**Staff** accounts see everything and can log orders. Creating, activating, and changing budgets or targeting are owner-only, in both the dashboard and Claude.

## Good habits

- Keep campaign names consistent, e.g. `SZ-<CITY>-<Product>-WA`. Claude follows this pattern too.
- Log orders every day. Cost per order is the number that matters for COD.
- When Claude reports a Meta error, it includes a `fbtrace_id`. Give that ID to Meta support if you need help.
- The Meta token is checked daily, and you get a warning before it expires. System user tokens normally don't expire.
