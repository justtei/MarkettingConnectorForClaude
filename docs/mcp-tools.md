# MCP tools

_Generated from `packages/core/src/tools/registry.ts` by `pnpm docs:tools` — do not edit by hand._

43 tools. Money is always PKR (major units). Every write is recorded in the activity log.

## Account

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `get_account` | Sandalez ad account info: name, currency, timezone, status, amount spent, spend cap, configured Page/Instagram/pixel/WhatsApp. | _none_ | Read — no change | 1 |
| `list_pages` | Facebook Pages the system user can access, with linked Instagram accounts. | _none_ | Read — no change | 1 |
| `list_instagram_accounts` | Instagram accounts usable in ads (from the ad account and the Page). | _none_ | Read — no change | 1 |
| `list_pixels` | Meta pixels on the ad account and when they last fired. | _none_ | Read — no change | 1 |
| `check_token` | Token health: valid?, expiry (warns within 14 days), granted vs missing permissions, API version. | _none_ | Read — no change | 1 |
| `get_activity_log` | Recent changes made through the tool (MCP or dashboard): who, what, when, request/response and previous state. | `limit`? (integer) Default: `20`.<br>`object_id`? (string)<br>`action`? (string) | Read — no change | 1 |
| `get_safety_settings` | Current budget cap (PKR/day), max budget increase % per change, and default targeting. | _none_ | Read — no change | 1 |

## Targeting

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `search_interests` | Search Meta detailed-targeting interests (e.g. 'shoes', 'wedding'). Returns IDs to use in targeting.interests. | `query` (string)<br>`limit`? (integer) Default: `25`. | Read — no change | 1 |
| `search_locations` | Search Meta locations (e.g. 'Karachi'). Returns location keys for targeting.city_keys / region_keys. | `query` (string)<br>`location_types`? (array) Default: `["city"]`.<br>`country_code`? (string) — Limit to a country; default PK. Default: `"PK"`.<br>`limit`? (integer) Default: `10`. | Read — no change | 1 |
| `estimate_audience` | Estimated audience size for a targeting spec (e.g. Karachi, women 20-40). | `targeting` (object) — Simple targeting. Converted to a Meta targeting spec by core.<br>`optimization_goal`? (string) Default: `"CONVERSATIONS"`. | Read — no change | 1 |

## Assets

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `upload_image` | Upload an image to the ad account from a public URL (or base64). Returns the image_hash used in creatives. | `url`? (string)<br>`base64`? (string) — Base64 or data: URL, for files not on the web.<br>`name`? (string) | Draft — creates PAUSED objects, no spend | 1 |
| `upload_video` | Upload a video from a public URL (Meta downloads it). Returns video_id. Processing takes a minute or two. | `url` (string)<br>`name`? (string)<br>`wait_until_ready`? (boolean) — Wait for Meta to finish processing before returning. Default: `false`. | Draft — creates PAUSED objects, no spend | 1 |
| `list_assets` | Images and/or videos uploaded to the ad account. | `type`? (`image` | `video` | `all`) Default: `"all"`.<br>`include_archived`? (boolean) Default: `false`. | Read — no change | 1 |

## Campaigns

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `create_ctwa_campaign` | One call builds a complete click-to-WhatsApp campaign (all PAUSED): uploads media, creates campaign (OUTCOME_ENGAGEMENT), ad set (WhatsApp destination, CONVERSATIONS, city/age/gender targeting, daily budget in PKR), one creative + ad per media file, with the WhatsApp welcome message. Rolls back everything if any step fails. Budget must be within the cap. Activate later with set_status. | `name` (string) — Campaign name, e.g. SZ-KHI-Prospecting-WA<br>`adset_name`? (string)<br>`daily_budget` (number) — PKR per day for the ad set, e.g. 600<br>`city`? (string) — City name, default from Settings (Karachi).<br>`city_key`? (string) — Meta city key if already known.<br>`radius_km`? (number)<br>`age_min`? (integer)<br>`age_max`? (integer)<br>`gender`? (`all` | `female` | `male`)<br>`interests`? (array)<br>`advantage_audience`? (boolean) — Advantage+ audience (Meta treats age/gender as suggestions). Default: on when age_min is 25 or lower, else off.<br>`creatives` (array)<br>`headline`? (string) — Default headline for creatives that have none.<br>`primary_text`? (string) — Default primary text for creatives that have none.<br>`welcome_message`? (string) — Greeting shown when the WhatsApp chat opens.<br>`autofill_message`? (string) — Message pre-filled for the customer to send.<br>`icebreakers`? (array) — Up to 4 quick questions, e.g. 'Price?' | Draft — creates PAUSED objects, no spend | 1 |
| `create_campaign` | Create a campaign (always PAUSED). Default objective OUTCOME_ENGAGEMENT (used for click-to-WhatsApp). | `name` (string)<br>`objective`? (`OUTCOME_ENGAGEMENT` | `OUTCOME_TRAFFIC` | `OUTCOME_SALES` | `OUTCOME_LEADS` | `OUTCOME_AWARENESS` | `OUTCOME_APP_PROMOTION`) Default: `"OUTCOME_ENGAGEMENT"`.<br>`special_ad_categories`? (array) Default: `[]`.<br>`daily_budget`? (number) — Campaign budget (Advantage+ campaign budget) in PKR. Usually set on the ad set instead. | Draft — creates PAUSED objects, no spend | 1 |
| `create_adset` | Create an ad set (always PAUSED) with budget in PKR, targeting and destination. For WHATSAPP the Page + WhatsApp number are filled in automatically and optimization defaults to CONVERSATIONS. | `campaign_id` (string)<br>`name` (string)<br>`daily_budget`? (number) — PKR per day. Omit only if the campaign has its own budget.<br>`targeting` (object) — Simple targeting. Converted to a Meta targeting spec by core.<br>`destination`? (`WHATSAPP` | `WEBSITE` | `MESSENGER` | `INSTAGRAM_DIRECT` | `ON_AD`) Default: `"WHATSAPP"`.<br>`optimization_goal`? (`CONVERSATIONS` | `LINK_CLICKS` | `LANDING_PAGE_VIEWS` | `OFFSITE_CONVERSIONS` | `IMPRESSIONS` | `REACH` | `POST_ENGAGEMENT` | `THRUPLAY` | `VALUE`)<br>`billing_event`? (`IMPRESSIONS` | `LINK_CLICKS` | `THRUPLAY`) Default: `"IMPRESSIONS"`.<br>`bid_strategy`? (`LOWEST_COST_WITHOUT_CAP` | `LOWEST_COST_WITH_BID_CAP` | `COST_CAP`) Default: `"LOWEST_COST_WITHOUT_CAP"`.<br>`bid_amount`? (number) — PKR, required for bid cap / cost cap.<br>`start_time`? (string)<br>`end_time`? (string)<br>`is_dynamic_creative`? (boolean)<br>`promoted_object`? (object) — Advanced override. | Draft — creates PAUSED objects, no spend | 1 |
| `create_creative` | Create an ad creative: image, video, carousel (2-10 cards), instagram_post (reuse an existing IG post) or dynamic (DCO). Destination whatsapp adds the WhatsApp button and welcome message; media URLs are uploaded automatically. | `name` (string)<br>`format` (`image` | `video` | `carousel` | `instagram_post` | `dynamic`)<br>`destination`? (`whatsapp` | `website`) Default: `"whatsapp"`.<br>`page_id`? (string) — Defaults to the configured Sandalez Page.<br>`instagram_user_id`? (string) — Defaults to the configured Instagram account.<br>`image_hash`? (string)<br>`image_url`? (string)<br>`video_id`? (string)<br>`video_url`? (string)<br>`thumbnail_hash`? (string)<br>`thumbnail_url`? (string)<br>`headline`? (string)<br>`primary_text`? (string)<br>`description`? (string)<br>`link`? (string) — Website URL (destination website only).<br>`cta_type`? (`WHATSAPP_MESSAGE` | `SHOP_NOW` | `LEARN_MORE` | `ORDER_NOW` | `BUY_NOW` | `SEND_MESSAGE` | `CONTACT_US` | `SIGN_UP` | `GET_OFFER`)<br>`cards`? (array) — Carousel cards (format carousel).<br>`instagram_media_id`? (string) — Existing Instagram post ID to reuse (format instagram_post).<br>`dynamic`? (object) — Dynamic creative (DCO): Meta mixes these assets. The ad set must have is_dynamic_creative: true.<br>`welcome_message`? (string) — Greeting shown when the WhatsApp chat opens.<br>`autofill_message`? (string) — Message pre-filled for the customer to send.<br>`icebreakers`? (array) — Up to 4 quick questions, e.g. 'Price?' | Draft — creates PAUSED objects, no spend | 1 |
| `create_ad` | Create an ad (always PAUSED) from an ad set and a creative. | `adset_id` (string)<br>`creative_id` (string)<br>`name` (string) | Draft — creates PAUSED objects, no spend | 1 |
| `list_campaigns` | Campaigns on the ad account with status and budget (PKR). | `status`? (`ALL` | `ACTIVE` | `PAUSED` | `ARCHIVED` | `IN_REVIEW` | `ISSUES`) Default: `"ALL"`.<br>`limit`? (integer) Default: `100`. | Read — no change | 1 |
| `get_campaign_tree` | A campaign with its ad sets (budget, targeting) and ads (status, creative). | `campaign_id` (string) | Read — no change | 1 |
| `add_ad_to_adset` | Add a new ad (PAUSED) to an existing ad set, from an existing creative_id or a new creative definition. | `adset_id` (string)<br>`name` (string)<br>`creative_id`? (string)<br>`creative`? (object) | Draft — creates PAUSED objects, no spend | 2 |
| `duplicate_campaign` | Deep-copy a campaign with its ad sets and ads (PAUSED). Optionally rename it, retarget to another city (e.g. Lahore) and set a new daily budget. | `campaign_id` (string)<br>`new_name`? (string)<br>`city`? (string)<br>`city_key`? (string)<br>`daily_budget`? (number) — PKR per ad set | Draft — creates PAUSED objects, no spend | 2 |

## Management

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `set_status` | Change status of a campaign, ad set or ad. PAUSED is always allowed without confirmation. ACTIVE and ARCHIVED need confirm: true. Activating a campaign also activates its paused ad sets and ads (include_children) so it can deliver; budgets are checked against the cap. LIVE ACTION: can spend money. Before calling with confirm: true you MUST describe the change to the user and get their explicit yes in chat. | `object_id` (string) — Campaign, ad set or ad ID<br>`status` (`ACTIVE` | `PAUSED` | `ARCHIVED`)<br>`confirm`? (boolean) — Must be true to activate or archive. Ask the user first.<br>`include_children`? (boolean) — When activating a campaign or ad set, also activate its paused ad sets/ads so it can deliver. Default: `true`. | **Live — can spend; needs `confirm: true` after the user agrees** | 1 |
| `update_budget` | Change an ad set's (or campaign-budget campaign's) daily budget in PKR. Refused above the daily cap or above the max % increase per change. LIVE ACTION: can spend money. Before calling with confirm: true you MUST describe the change to the user and get their explicit yes in chat. | `object_id` (string) — Ad set ID (or campaign ID for campaign-budget campaigns)<br>`daily_budget` (number) — New daily budget in PKR<br>`confirm`? (boolean) — Must be true. Ask the user first. | **Live — can spend; needs `confirm: true` after the user agrees** | 1 |
| `update_targeting` | Change an ad set's targeting. Changes are merged into the current targeting unless replace: true. LIVE ACTION: can spend money. Before calling with confirm: true you MUST describe the change to the user and get their explicit yes in chat. | `adset_id` (string)<br>`changes` (object) — Simple targeting. Converted to a Meta targeting spec by core.<br>`replace`? (boolean) — Replace the whole targeting instead of merging with the current one. Default: `false`.<br>`confirm`? (boolean) — Must be true. Ask the user first. | **Live — can spend; needs `confirm: true` after the user agrees** | 1 |
| `bulk_update` | Change status and/or daily budget of several objects at once. Each item passes the same guards; pausing needs no confirmation. LIVE ACTION: can spend money. Before calling with confirm: true you MUST describe the change to the user and get their explicit yes in chat. | `items` (array)<br>`confirm`? (boolean) | **Live — can spend; needs `confirm: true` after the user agrees** | 2 |

## Insights

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `get_insights` | Performance: spend (PKR), impressions, reach, frequency, clicks, CTR, CPM, WhatsApp conversations started, cost per conversation, video watch (p25-p100). For the account or a campaign/ad set/ad; optional breakdowns (age, gender, publisher_platform, platform_position, region) and daily rows (time_increment: 1). | `object_id`? (string) — Campaign/ad set/ad ID. Omit for the whole ad account.<br>`level`? (`account` | `campaign` | `adset` | `ad`) Default: `"campaign"`.<br>`date_preset`? (`today` | `yesterday` | `last_3d` | `last_7d` | `last_14d` | `last_28d` | `last_30d` | `last_90d` | `this_month` | `last_month` | `this_week_mon_today` | `last_week_mon_sun` | `maximum`) — Relative range. Ignored when since/until are given.<br>`since`? (string)<br>`until`? (string)<br>`breakdowns`? (array)<br>`time_increment`? (mixed)<br>`limit`? (integer) Default: `100`. | Read — no change | 1 |
| `detect_fatigue` | Flags tired ads: CTR dropping in the last days vs before, frequency above a threshold, rising cost per chat. | `lookback_days`? (integer) Default: `14`.<br>`recent_days`? (integer) Default: `3`.<br>`frequency_threshold`? (number) Default: `3`.<br>`ctr_drop_pct`? (number) Default: `30`.<br>`min_impressions`? (integer) Default: `1000`. | Read — no change | 2 |
| `placement_report` | Spend, chats and cost per chat by placement (Facebook/Instagram, feed/stories/reels), flagging expensive placements. | `date_preset`? (`today` | `yesterday` | `last_3d` | `last_7d` | `last_14d` | `last_28d` | `last_30d` | `last_90d` | `this_month` | `last_month` | `this_week_mon_today` | `last_week_mon_sun` | `maximum`) — Relative range. Ignored when since/until are given.<br>`since`? (string)<br>`until`? (string)<br>`object_id`? (string) | Read — no change | 2 |
| `wasted_spend_report` | Ads that spent without getting chats, or whose cost per chat is far above average. | `date_preset`? (`today` | `yesterday` | `last_3d` | `last_7d` | `last_14d` | `last_28d` | `last_30d` | `last_90d` | `this_month` | `last_month` | `this_week_mon_today` | `last_week_mon_sun` | `maximum`) — Relative range. Ignored when since/until are given.<br>`since`? (string)<br>`until`? (string)<br>`min_spend`? (number) Default: `500`.<br>`cost_multiple`? (number) Default: `2`. | Read — no change | 2 |

## Orders

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `log_orders` | Record a day's WhatsApp results in the order log: chats, orders, refused (COD returns), revenue in PKR, optionally linked to an ad. | `date` (string)<br>`ad_id`? (string)<br>`chats` (integer)<br>`orders` (integer)<br>`refused`? (integer) Default: `0`.<br>`revenue` (number) — PKR<br>`note`? (string) | Own data — writes only the Sandalez database | 1 |
| `get_cost_per_order` | Joins ad spend with the order log: cost per chat, cost per order, cost per delivered order, refusal rate, ROAS. Group by total, day or ad. | `date_preset`? (`today` | `yesterday` | `last_3d` | `last_7d` | `last_14d` | `last_28d` | `last_30d` | `last_90d` | `this_month` | `last_month` | `this_week_mon_today` | `last_week_mon_sun` | `maximum`) — Relative range. Ignored when since/until are given.<br>`since`? (string)<br>`until`? (string)<br>`group_by`? (`total` | `day` | `ad`) Default: `"total"`.<br>`source`? (`meta` | `db`) — Spend from Meta live (default) or the synced database. Default: `"meta"`. | Read — no change | 1 |
| `list_orders` | Rows of the order log for a date range. | `since`? (string)<br>`until`? (string)<br>`ad_id`? (string)<br>`limit`? (integer) Default: `100`. | Read — no change | 1 |

## Automation

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `set_alert` | Create an alert rule checked every few hours, e.g. cost_per_chat gt 150, frequency gt 3, spend_stopped. Alerts show on the dashboard and are emailed if SMTP is set. | `metric` (`cost_per_chat` | `spend` | `frequency` | `ctr` | `spend_stopped`) — cost_per_chat (PKR, today), spend (PKR, today), frequency (last 7 days), ctr (% today), spend_stopped (no spend today by noon while campaigns are active)<br>`operator`? (`gt` | `lt`) Default: `"gt"`.<br>`threshold`? (number) Default: `0`.<br>`object_id`? (string) — Campaign/ad set/ad; omit for the whole account.<br>`name`? (string) | Own data — writes only the Sandalez database | 2 |
| `list_alerts` | Alert rules and their most recent firings. | `events`? (integer) Default: `3`. | Read — no change | 2 |
| `weekly_report` | Last 7 days vs the previous 7: spend, chats, cost per chat, orders, cost per order, refusal rate, ROAS, best/worst ads, fatigue. Saved; optionally emailed. | `send_email`? (boolean) Default: `false`.<br>`email_to`? (string) | Own data — writes only the Sandalez database | 2 |
| `sync_now` | Pull campaigns, ad sets, ads and daily insights from Meta into the dashboard database now (normally every 3 hours). | `days`? (integer) Default: `7`. | Own data — writes only the Sandalez database | 2 |

## Audiences

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `list_audiences` | Custom and lookalike audiences with approximate sizes. | _none_ | Read — no change | 3 |
| `create_custom_audience` | Create a custom audience: website visitors (pixel event), Instagram/Page engagers, or a customer list (emails/phones, hashed before upload). | `name` (string)<br>`source` (`website` | `engagement` | `customer_list`)<br>`retention_days`? (integer) — Website: max 180. Engagement: max 365 (capped at 180 here). Default: `30`.<br>`website_event`? (`all_visitors` | `PageView` | `ViewContent` | `AddToCart` | `InitiateCheckout` | `Purchase`) — Website audiences: which pixel event. Default: `"all_visitors"`.<br>`engagement_source`? (`page` | `instagram`) — Engagement audiences: Facebook Page or Instagram. Default: `"instagram"`.<br>`customers`? (array) — Customer list: emails and/or phones (hashed with SHA-256 before upload).<br>`description`? (string) | Draft — creates PAUSED objects, no spend | 3 |
| `create_lookalike` | Create a lookalike audience (default top 1% in Pakistan) from a source custom audience. | `name` (string)<br>`origin_audience_id` (string)<br>`ratio`? (number) — 0.01 = top 1% most similar people. Default: `0.01`.<br>`country`? (string) Default: `"PK"`. | Draft — creates PAUSED objects, no spend | 3 |

## Catalog

| Tool | What it does | Inputs | Safety | Phase |
|---|---|---|---|---|
| `list_catalogs` | Product catalogs owned by the business (e.g. synced from Shopify) with their product sets. | _none_ | Read — no change | 3 |
| `create_product_set` | Create a product set in a catalog, optionally filtered (e.g. product_type contains 'flats'). | `catalog_id` (string)<br>`name` (string)<br>`filter`? (object) — Meta product filter, e.g. {"product_type":{"i_contains":"flats"}}. Omit for all products. | Draft — creates PAUSED objects, no spend | 3 |
| `create_catalog_campaign` | Dynamic product ads (all PAUSED): OUTCOME_SALES campaign + ad set (retargeting viewers/cart-adders or broad) + catalog creative + ad. Rolls back on failure. | `name` (string)<br>`catalog_id` (string)<br>`product_set_id` (string)<br>`daily_budget` (number) — PKR per day<br>`mode`? (`retargeting` | `broad`) — retargeting = people who viewed/added to cart but did not buy; broad = new people likely to buy. Default: `"retargeting"`.<br>`retargeting_days`? (integer) Default: `14`.<br>`targeting`? (object) — Location/age for broad mode (default: Pakistan).<br>`primary_text` (string)<br>`headline`? (string) Default: `"{{product.name}}"`.<br>`description`? (string) Default: `"{{product.price}}"`.<br>`link`? (string) — Fallback store URL. Product URLs come from the catalog. | Draft — creates PAUSED objects, no spend | 3 |

