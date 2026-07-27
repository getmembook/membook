#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * Entry point. Spawns on stdio, serves for the life of the session, exits.
 *
 * NOTHING may be written to stdout except MCP protocol frames — stdout IS the
 * transport, so a stray console.log corrupts the stream and the client sees a
 * parse error rather than a message. Diagnostics go to stderr.
 */
async function main(): Promise<void> {
  const root = process.env["MEMBOOK_ROOT"] ?? process.cwd();

  const server = createServer({
    root,
    ...(process.env["MEMBOOK_AGENT"]
      ? { agent: process.env["MEMBOOK_AGENT"] }
      : {}),
    ...(process.env["MEMBOOK_MODEL"]
      ? { model: process.env["MEMBOOK_MODEL"] }
      : {}),
    ...(process.env["MEMBOOK_SESSION"]
      ? { session: process.env["MEMBOOK_SESSION"] }
      : {}),
    ...(process.env["MEMBOOK_WORKSPACE"]
      ? { workspaceManifest: process.env["MEMBOOK_WORKSPACE"] }
      : {}),
  });

  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`membook-mcp failed to start: ${String(error)}\n`);
  process.exit(1);
});
