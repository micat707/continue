/**
 * Unified tool catalogue.
 *
 * Continue's `config.tools` is the SINGLE source of truth for tool definitions.
 * It already contains:
 *   - built-in tools (core/tools/definitions/*)
 *   - MCP tools discovered from every connected MCP server
 *     (assembled in core/config/profile/doLoadConfig.ts:211-235)
 *   - user overrides / custom tools
 *
 * Both harnesses read from this one catalogue:
 *   - Continue native: `state.config.config.tools` (unchanged)
 *   - DeepAgent: toolAdapter.ts converts the same Tool[] into LangChain tools
 *
 * This module only classifies / queries the catalogue — it does not duplicate
 * any tool definitions. Adding a tool means adding it to core/tools/definitions
 * (built-in) or to an MCP server config; both flow into config.tools
 * automatically.
 */

import type { ContinueConfig, Tool } from "..";
import { decodeMCPToolUri } from "./callTool";

/** Result of decoding an MCP tool's `uri`. */
export interface McpToolRef {
  mcpId: string;
  toolName: string;
}

/** True when this Tool came from an MCP server (has an `mcp://...` uri). */
export function isMcpTool(tool: Tool): boolean {
  return typeof tool.uri === "string" && tool.uri.startsWith("mcp://");
}

/** Decode the server id + tool name from a Continue MCP Tool. */
export function getMcpToolRef(tool: Tool): McpToolRef | null {
  if (!isMcpTool(tool)) return null;
  return decodeMCPToolUri(tool.uri!);
}

/**
 * Tools the DeepAgent harness should NOT try to run itself.
 *
 * These are tools whose implementation lives in DeepAgent's own runtime
 * (filesystem middleware, web, spec workflow, user_input, MCP adapters, …),
 * so their definitions in config.tools are informational only. They are
 * provided to `createDeepAgent` from their dedicated factories instead.
 *
 * Everything else in config.tools that is NOT in this set and NOT an MCP tool
 * is a Continue-only tool (codebase, readSkill, createRuleBlock, …) — it stays
 * on the Continue `tools/call` path and is never offered to DeepAgent.
 */
export const DEEP_AGENT_OWNED_TOOL_NAMES = new Set([
  "read_file",
  "read_files",
  "read_file_range",
  "fs_write",
  "fs_append",
  "append_lines",
  "str_replace",
  "delete_file",
  "list_directory",
  "file_search",
  "grep_search",
  "execute_pwsh",
  "control_pwsh_process",
  "get_process_output",
  "list_processes",
  "web_fetch",
  "web_search",
  "user_input",
  "read_code",
  "create_hook",
  "update_session_information",
  "create_artifact",
  "task_list",
  "task_get",
  "task_update",
  "start_spec_workflow",
  "run_spec_tasks",
]);

/** DeepAgent-owned built-ins (not MCP, not Continue-only). */
export function isDeepAgentOwnedTool(tool: Tool): boolean {
  return DEEP_AGENT_OWNED_TOOL_NAMES.has(tool.function.name);
}

/** A Continue-only tool: leave it on the Continue `tools/call` path. */
export function isContinueOnlyTool(tool: Tool): boolean {
  return !isMcpTool(tool) && !isDeepAgentOwnedTool(tool);
}

/** All tools from the unified catalogue (config.tools). */
export function getAllTools(config: ContinueConfig): Tool[] {
  return config.tools ?? [];
}

/** MCP tools from the unified catalogue. */
export function getMcpTools(config: ContinueConfig): Tool[] {
  return getAllTools(config).filter(isMcpTool);
}
