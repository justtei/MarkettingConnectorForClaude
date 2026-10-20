import { z } from "zod";

/** Pinned Meta Graph/Marketing API version. Review quarterly — Marketing API versions retire fast. */
export const META_API_VERSION_DEFAULT = "v26.0";

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  META_ACCESS_TOKEN: z.string().min(1, "META_ACCESS_TOKEN is required"),
  META_APP_ID: optionalString,
  META_APP_SECRET: optionalString,
  META_AD_ACCOUNT_ID: z.string().regex(/^act_\d+$/, "META_AD_ACCOUNT_ID must look like act_1234567890"),
  META_PAGE_ID: optionalString,
  META_INSTAGRAM_USER_ID: optionalString,
  META_PIXEL_ID: optionalString,
  META_BUSINESS_ID: optionalString,
  WHATSAPP_PHONE_NUMBER: optionalString.transform((v) => v?.replace(/[^\d]/g, "")),
  META_API_VERSION: z
    .string()
    .regex(/^v\d+\.\d+$/, "META_API_VERSION must look like v26.0")
    .default(META_API_VERSION_DEFAULT),
  META_GRAPH_BASE_URL: z.string().url().default("https://graph.facebook.com"),
  META_MAX_RETRIES: z.coerce.number().int().min(0).max(8).default(3),
  META_RETRY_BASE_MS: z.coerce.number().int().min(1).default(500),
  META_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  /** Video processing wait before a creative can use it. */
  META_VIDEO_READY_TIMEOUT_MS: z.coerce.number().int().min(0).default(180_000),

  /** Shopify order sync (optional): the store's myshopify.com domain and an Admin API access token (shpat_...). */
  SHOPIFY_STORE_DOMAIN: optionalString.transform((v) => v?.replace(/^https?:\/\//, "").replace(/\/.*$/, "")),
  SHOPIFY_ADMIN_TOKEN: optionalString,
  SHOPIFY_API_VERSION: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "SHOPIFY_API_VERSION must look like 2026-07")
    .default("2026-07"),
  /** Tests point this at the mock; normally https://<SHOPIFY_STORE_DOMAIN>. */
  SHOPIFY_BASE_URL: optionalString,
  /** Order tags that mean the customer refused the parcel (COD return), comma-separated, case-insensitive. */
  SHOPIFY_REFUSED_TAGS: z.string().default("refused,rto,returned,return to origin,cod refused"),
  /** How far back a WhatsApp chat from an ad still counts for an order from the same phone number. */
  ORDER_ATTRIBUTION_DAYS: z.coerce.number().int().min(1).max(90).default(28),

  MAX_DAILY_BUDGET_PKR: z.coerce.number().positive().default(2000),
  MAX_BUDGET_INCREASE_PCT: z.coerce.number().positive().default(30),
  DEFAULT_TIMEZONE: z.string().default("Asia/Karachi"),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  return parsed.data;
}
