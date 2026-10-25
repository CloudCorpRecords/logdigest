/**
 * logdigest MCP server. Tool: digest_log.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runCheck, VERSION } from "./core.js";

const server = new McpServer({ name: "logdigest", version: VERSION });

server.tool(
  "digest_log",
  "Digest a log file: finds error and failure lines (test failures, stack heads, nonzero exits, error keywords), groups them into sections with original line numbers, counts total lines versus kept lines, and returns a verdict of FAILURES-FOUND or NO-FAILURES plus the condensed digest.",
  {
    path: z.string().describe("Target path to check"),
  },
  async ({ path }) => {
    const report = runCheck(path);
    return { content: [{ type: "text" as const, text: JSON.stringify(report, null, 2) }] };
  },
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
