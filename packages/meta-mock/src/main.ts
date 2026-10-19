// Standalone mock Graph API for local development: pnpm dev:mock
// Point the stack at it with META_GRAPH_BASE_URL=http://127.0.0.1:4010 and META_ACCESS_TOKEN=test-token.
import { MetaMock } from "./index.js";

const port = Number(process.env.MOCK_PORT ?? 4010);
const mock = new MetaMock({
  token: process.env.META_ACCESS_TOKEN ?? "test-token",
  appId: process.env.META_APP_ID,
  appSecret: process.env.META_APP_SECRET,
  accountId: process.env.META_AD_ACCOUNT_ID?.replace(/^act_/, ""),
  pageId: process.env.META_PAGE_ID,
  igUserId: process.env.META_INSTAGRAM_USER_ID,
  pixelId: process.env.META_PIXEL_ID,
  businessId: process.env.META_BUSINESS_ID,
  log: process.env.MOCK_LOG === "1",
});
const url = await mock.start(port, process.env.MOCK_HOST ?? "127.0.0.1", process.env.MOCK_PUBLIC_URL);
console.log(`Meta mock Graph API listening on ${url} (account ${mock.act})`);
