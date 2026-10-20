# Meta setup

The tool manages only your own ad account, so the default **Marketing API Access Tier** (**Limited Access**; called "Standard Access" before May 2026) and a System User token are enough to start. No App Review is needed for your own account.

**Access tiers (checked October 2026):** Limited Access is granted automatically when you add the Marketing API product. Meta describes it as heavily rate-limited and meant for development, with 1 system user + 1 admin system user. **Full Access** (formerly "Advanced") is lightly rate-limited. It needs at least 500 Marketing API calls in the last 15 days with an error rate under 15% over the last 500 calls. The worker's 3-hourly sync plus normal use reaches that in about two weeks; then request Full Access in the App Dashboard. Until then, expect occasional "rate limit" messages (the tool backs off and retries; Meta also allows only about 4 budget changes per ad set per hour).

## Checklist

1. **Business Manager:** the Sandalez Page, @sandalez_ Instagram, the ad account (PKR, Asia/Karachi), the pixel, and the WhatsApp number linked to the Page.
2. **Business verification** for Sandalez (Business Settings → Security Center).
3. **developers.facebook.com:** create an app of type **Business**, owned by the Sandalez Business Manager.
4. Add the **Marketing API** product to the app (grants Limited access to `ads_management` and `ads_read`).
5. **Business Settings → System users:** create one **admin** system user (the Limited tier allows 1 system user + 1 admin system user).
6. Assign the system user to the **ad account** (Manage campaigns), the **Page** (Advertise / create ads), the **pixel** and the **catalog**.
7. **Generate a token** for the app with: `ads_management`, `ads_read`, `business_management`, `pages_show_list`, `pages_read_engagement`, `pages_manage_ads` (+ `catalog_management` for catalog ads). Pick "never expires".
8. Put these into the server's `.env` (never into code):

   | Variable | Where to find it |
   |---|---|
   | `META_ACCESS_TOKEN` | the token from step 7 |
   | `META_APP_ID`, `META_APP_SECRET` | App dashboard → Settings → Basic |
   | `META_AD_ACCOUNT_ID` | Ads Manager URL `act=` (write it as `act_123…`) |
   | `META_PAGE_ID` | Page → About → Page transparency |
   | `META_INSTAGRAM_USER_ID` | `list_instagram_accounts` tool after the token works |
   | `META_PIXEL_ID` | Events Manager |
   | `META_BUSINESS_ID` | Business Settings → Business info |
   | `WHATSAPP_PHONE_NUMBER` | e.g. `923499066816` |

9. Turn on **two-factor authentication** on the admin Facebook account.
10. **Switch the app to Live.** In the App Dashboard, open **App settings → Basic**, fill in **Privacy Policy URL** (e.g. `https://sandalez.com/policies/privacy-policy`) and pick a **Category**, then turn the **App Mode** switch at the top from Development to **Live**. While the app is in development mode, Meta refuses ads whose post was made through it: "Ads creative post was created by an app that is in development mode. It must be in public to create this ad." Live mode needs no App Review for your own ad account.

Then run `pnpm setup:check --env .env`. It checks the token (valid, permissions, expiry), the ad account (PKR, Asia/Karachi, active) and that every ID above is visible to the token, and names the exact fix when one is not (e.g. "the token cannot see Page 123; assign the Page to the system user"). Once deployed, Claude's `check_token` tool should also say `healthy: true`.

## Optional integrations

**WhatsApp Cloud API webhook** (auto-counts chats per ad from click-to-WhatsApp referrals):

- App → WhatsApp → Configuration → Webhook URL `https://<DOMAIN>/webhooks/whatsapp`, verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Subscribe to `messages`.
- Requests are verified with `X-Hub-Signature-256` using `META_APP_SECRET`.

**Shopify → Conversions API** (Purchase events for optimization):

- Shopify Admin → Settings → Notifications → Webhooks → `Order creation`, JSON, URL `https://<DOMAIN>/webhooks/shopify/orders-create`.
- Put the signing secret Shopify shows in `SHOPIFY_WEBHOOK_SECRET`. Email and phone are SHA-256 hashed before they are sent; events are deduplicated by order ID.
- Test with `META_CAPI_TEST_EVENT_CODE` from Events Manager → Test events, then remove it.

## Limits to know

- The Limited tier is heavily rate-limited per ad account. The worker syncs every 3 hours and the dashboard reads the database, so normal use stays well under the limit. The current usage is shown in Settings.
- Marketing API versions retire quickly (a new one about every 4 months, at least 90 days' notice). `META_API_VERSION` is pinned to `v26.0` (released 29 July 2026; v24.0 was switched off on 6 October 2026); review it every quarter.

## What changed in v26.0 and how the tool handles it (checked October 2026)

- **Advantage+ audience flag must be explicit** for some ad sets (`ADS_TARGETING__REQUIRE_EXPLICIT_ADVANTAGE_AUDIENCE_FLAG`). Every ad set the tool creates states it: on by default, off when the minimum age is above 25 (Advantage+ audience does not allow a hard minimum above 25), off for catalog retargeting.
- **Delivery-estimate fields removed** (`daily_outcomes_curve`, `estimate_dau`, `budget_guardrail`, from 27 October 2026). The tool uses `reachestimate` and only the audience bounds of `delivery_estimate`.
- **Click-to-WhatsApp payload** follows Meta's current guide (updated May 2026): campaign `OUTCOME_ENGAGEMENT`, ad set `destination_type: WHATSAPP`, `optimization_goal: CONVERSATIONS`, `billing_event: IMPRESSIONS`, `promoted_object {page_id, whatsapp_phone_number}`, CTA `WHATSAPP_MESSAGE` with `app_destination: WHATSAPP`, and `page_welcome_message` as an object (`VISUAL_EDITOR`, version 2) inside `link_data` / `video_data`.
- Instagram Explore feed and Messenger Stories placements are gone; the tool only sets `publisher_platforms`, so nothing to change.
