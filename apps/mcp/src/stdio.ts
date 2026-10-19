// Local stdio transport (Claude Desktop / Claude Code on the same machine as the database).
// Logs go to stderr so stdout stays clean for the protocol.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCore } from "@sandalez/core";
import { buildMcpServer } from "./app.js";

const core = createCore();
const server = buildMcpServer(core, "claude-mcp-local");
await server.connect(new StdioServerTransport());
