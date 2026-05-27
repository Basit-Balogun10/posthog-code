import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";

const execFileAsync = promisify(execFile);

export const GRAPHITE_MCP_NAME = "gt";

// `gt state` exits 0 when gt is installed and the directory is tracked by
// Graphite. ENOENT means gt is not installed; non-zero exit means the directory
// is not a Graphite repo.
async function isGraphiteRepo(cwd: string): Promise<boolean> {
  try {
    await execFileAsync("gt", ["state"], { cwd, timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Returns a stdio MCP server config for `gt mcp` when the project is a
 * Graphite-tracked repository. Returns undefined otherwise.
 *
 * `gt mcp` is the MCP server built into the Graphite CLI (≥1.6.7) that lets
 * the agent create and manage stacked PRs via the `gt` workflow.
 */
export async function createGraphiteMcpServer(
  cwd: string,
): Promise<McpServerConfig | undefined> {
  if (!(await isGraphiteRepo(cwd))) return undefined;
  return { type: "stdio", command: "gt", args: ["mcp"] };
}
