import { pino, destination } from "pino";

// Logs go to stderr so the MCP stdio transport keeps stdout clean (Docker collects both).
export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: ["access_token", "*.access_token", "token", "*.token", "headers.authorization", "appsecret_proof"],
      censor: "[redacted]",
    },
  },
  destination(2),
);

export type Logger = typeof logger;
