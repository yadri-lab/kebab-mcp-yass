import { createMcpHandler } from "mcp-handler";
import { withLogging } from "@/core/logging";
import { checkMcpAuth } from "@/core/auth";
import { getEnabledPacks, logRegistryState } from "@/core/registry";

/**
 * Build a fresh MCP handler that reflects the current registry state.
 * Called per-request so that hot-env edits (via /api/config/env) are
 * picked up without needing a restart.
 *
 * Cost: a few ms to re-scan process.env + rebuild the tool list.
 */
function buildHandler() {
  return createMcpHandler(
    (server) => {
      const enabledPacks = getEnabledPacks();
      logRegistryState();

      for (const pack of enabledPacks) {
        for (const tool of pack.manifest.tools) {
          const desc = tool.deprecated
            ? `[DEPRECATED: ${tool.deprecated}] ${tool.description}`
            : tool.description;
          server.tool(
            tool.name,
            desc,
            tool.schema,
            withLogging(tool.name, async (params) => tool.handler(params))
          );
        }
      }
    },
    {
      serverInfo: {
        name: "MyMCP",
        version: "0.2.0",
      },
    },
    {
      basePath: "/api",
      maxDuration: 60,
    }
  );
}

async function handler(request: Request): Promise<Response> {
  const authError = checkMcpAuth(request);
  if (authError) return authError;
  const mcpHandler = buildHandler();
  return mcpHandler(request);
}

export { handler as GET, handler as POST, handler as DELETE };
