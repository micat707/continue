/**
 * Unified tool catalogue helpers.
 *
 * After the full consolidation, `config.tools` is a single catalogue:
 *   - built-in tool VIEWS generated from DeepAgent definitions (the authoritative
 *     source, projected by extensions/vscode/.../toolView.ts via ConfigHandler's
 *     toolViewPatcher)
 *   - MCP tools discovered from Continue-configured MCP servers
 *     (assembled in core/config/profile/doLoadConfig.ts)
 *
 * This module provides the only classification still needed: identifying MCP
 * tools by their `mcp://` uri and decoding that uri back to server + tool name.
 */

import type { Tool } from "..";
import { decodeMCPToolUri } from "./callTool";

/** Result of decoding an MCP tool's `uri`. */
export interface McpToolRef {
  mcpId: string;
  toolName: string;
}

/** True when this Tool came from a Continue-configured MCP server. */
export function isMcpTool(tool: Tool): boolean {
  return typeof tool.uri === "string" && tool.uri.startsWith("mcp://");
}

/** Decode the server id + tool name from a Continue MCP Tool. */
export function getMcpToolRef(tool: Tool): McpToolRef | null {
  if (!isMcpTool(tool)) return null;
  return decodeMCPToolUri(tool.uri!);
}
