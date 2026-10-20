// Run one job by hand: pnpm --filter @sandalez/worker run-job sync|alerts|weekly_report|token_check|shop_sync
import { createCore } from "@sandalez/core";
import { alertsJob, shopSyncJob, syncJob, tokenCheckJob, weeklyReportJob } from "./jobs/index.js";

const jobs = { sync: syncJob, alerts: alertsJob, weekly_report: weeklyReportJob, token_check: tokenCheckJob, shop_sync: shopSyncJob } as const;
const name = process.argv[2] as keyof typeof jobs;
if (!jobs[name]) {
  console.error(`Usage: run-job ${Object.keys(jobs).join("|")}`);
  process.exit(1);
}
const core = createCore();
const result = await jobs[name](core.context("worker-manual", "worker"));
console.log(JSON.stringify(result, null, 2));
await core.db.$disconnect();
process.exit(result.ok ? 0 : 1);
