# Orders: cost per order from real sales

Cost per chat says which ads start conversations. Cost per **delivered order** says which ads make money. The tool gets orders from two places and joins them to ads:

| Source | What it gives | Setup |
|---|---|---|
| **Shopify** (automatic) | Every order, its outcome (pending, delivered, refused, cancelled) and its value, every 30 minutes | [Connect Shopify](#1-connect-shopify) |
| **WhatsApp webhook** (automatic) | Which ad each WhatsApp chat came from (Meta adds the ad ID to the first message of a click-to-WhatsApp chat) | [Connect the WhatsApp webhook](#2-connect-the-whatsapp-webhook) |
| `log_orders` / dashboard Orders page (manual) | Daily totals you type in | none |

**How an order is linked to an ad:** when a Shopify order's phone number matches a WhatsApp chat that came from an ad in the 28 days before the order (`ORDER_ATTRIBUTION_DAYS`), the order counts for that ad. Orders without a matching chat still count in the totals, as "not linked to an ad". You or Claude can link one by hand with `link_shop_order` (for example when the customer named the ad).

With both connected, `get_cost_per_order` (group by ad), the sales alerts and the weekly report show real cost per delivered order per ad.

## 1. Connect Shopify

1. In Shopify admin, open **Settings → Apps and sales channels → Develop apps**. If asked, click **Allow custom app development**.
2. **Create an app** named `Sandalez Ads`.
3. **Configuration → Admin API integration → Configure**: tick **`read_orders`**, then **Save**.
4. **Protected customer data**: in the app's **API access** section, request access to **Protected customer data** and select the **Phone** field (also Name and Address if Shopify asks for them together). Without the phone, orders can't be linked to chats.
5. **API credentials → Install app**, then **Reveal token once** and copy the **Admin API access token** (starts with `shpat_`). It is shown once.
6. In `.env` on the machine that runs the tool:
   ```
   SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
   SHOPIFY_ADMIN_TOKEN=shpat_...
   ```
   The myshopify.com address is in **Settings → Domains**.
7. Restart the services (`docker compose up -d`, or on Windows `Restart-Service sandalez-*`), then check:
   ```bash
   pnpm setup:check --env .env      # section "4b. Shopify orders" should be OK
   ```
8. Ask Claude: **"Sync my Shopify orders and show the last 20."** The first sync reads the last 60 days.

### How the outcome is decided

| Status | When |
|---|---|
| `delivered` | a shipment is marked Delivered, or the order is Paid and Fulfilled (COD paid out by the courier) |
| `refused` | a refusal tag (`SHOPIFY_REFUSED_TAGS`, default `refused, rto, returned, return to origin, cod refused`), a completed return, a failed delivery, or cancelled after it was shipped |
| `cancelled` | cancelled before shipping; not counted as an order |
| `pending` | everything else (on the way) |

If your team marks returned parcels a different way, add that tag to `SHOPIFY_REFUSED_TAGS`. Refusal rate is worked out from settled orders only (delivered + refused), so orders still on the way don't hide refusals.

## 2. Connect the WhatsApp webhook

The webhook needs your number on the **WhatsApp Business Platform** (Cloud API). If you use the WhatsApp Business **app** on a phone, Meta's *coexistence* onboarding lets you keep using the app while the platform sends webhooks; WhatsApp Manager shows whether your number can use it.

1. In the Meta app the tool uses (developers.facebook.com → your app), **Add product → WhatsApp** and connect your WhatsApp Business account and number. Webhooks are signed with this app's secret (`META_APP_SECRET`), so it has to be the same app.
2. **WhatsApp → Configuration → Webhook → Edit**:
   - **Callback URL**: `https://<public address>/webhooks/whatsapp`. On the Windows + Tailscale install it is `https://<pc>.<tailnet>.ts.net/webhooks/whatsapp` (the installer publishes `/webhooks` through Funnel). On a VPS: `https://<DOMAIN>/webhooks/whatsapp`.
   - **Verify token**: the value of `WHATSAPP_WEBHOOK_VERIFY_TOKEN` in `.env`.
   - Click **Verify and save**, then subscribe to the **messages** field.
3. Test: tap one of your click-to-WhatsApp ads on a phone and send a message. Within a minute `get_cost_per_order` (group by ad) shows a chat for that ad, and the dashboard's Orders page counts it.

Only the first message per customer per day is stored (phone number, ad ID, first text), which is all the linking needs.

## 3. What to ask Claude

- "Which ad has the lowest cost per delivered order this month?"
- "Show orders that aren't linked to an ad." → `list_shop_orders` with `unlinked: true`
- "Order #1042 came from the pearl flats video ad." → `link_shop_order`
- "Alert me if cost per order goes above PKR 900 or refusals above 25%." → `set_alert` (`cost_per_order`, `refusal_rate`)
- "Is ROAS on delivered orders above 2 for the Karachi campaign?" → `get_cost_per_order` with `object_id`

If you also type daily totals with `log_orders` for days Shopify already covers, those orders are counted twice; the tool says so in its notes.
