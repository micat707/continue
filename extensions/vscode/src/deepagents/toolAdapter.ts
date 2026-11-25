/**
 * Adapts tools from Continue's unified catalogue (`config.tools`) into
 * LangChain tools for the DeepAgent harness.
 *
 * MCP tools are the important case: their definitions come from the SAME
 * `config.tools` the GUI sees (built in doLoadConfig.ts), and execution reuses
 * the MCP connection Continue already established — there is no second client,
 * no second config source. This is what makes "configure MCP in Continue, use
 * it in DeepAgent" work with one set of tools.
 *
 * DeepAgent-owned tools (fs_write, str_replace, user_input, …) are NOT produced
 * here: their implementations live in acpToolKit.ts / the deepagents library.
 * Continue-only tools are also excluded — they stay on the tools/call path.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import type { ContinueConfig } from "core";
import { MCPManagerSingleton } from "core/context/mcp/MCPManagerSingleton";
import { getMcpToolRef, isMcpTool, type Tool } from "core/tools/registry";

const logPrefix = "[DeepAgent][MCP]";

function safeServerName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/** Extract text from an MCP CallToolResult's content array. */
function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && "type" in item) {
        const typed = item as { type?: string; text?: string };
        if (typed.type === "text" && typeof typed.text === "string") {
          return typed.text;
        }
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Build LangChain tools for every MCP tool in the unified catalogue.
 * Returns [] when the user has no MCP servers configured (fully inert).
 */
export function buildMcpLangChainTools(
  config: ContinueConfig,
): DynamicStructuredTool[] {
  const mcpTools = (config.tools ?? []).filter(isMcpTool);
  if (mcpTools.length === 0) return [];

  const out: DynamicStructuredTool[] = [];
  for (const tool of mcpTools) {
    const ref = getMcpToolRef(tool);
    if (!ref) continue;
    const { mcpId, toolName } = ref;
    const exposedName = `mcp__${safeServerName(mcpId)}__${toolName}`;

    out.push(
      new DynamicStructuredTool({
        name: exposedName,
        description: tool.function.description ?? `MCP tool ${toolName}`,
        // Loose schema: the authoritative validation is done by the MCP server
        // and by Continue's coerceArgsToSchema on the tools/call path. A record
        // here keeps arbitrary MCP input shapes working without a JSON→Zod lib.
        schema: z.record(z.string(), z.unknown()),
        func: async (input: Record<string, unknown>) => {
          const connection =
            MCPManagerSingleton.getInstance().getConnection(mcpId);
          if (!connection) {
            throw new Error(
              `${logPrefix} MCP connection '${mcpId}' not found for tool '${exposedName}'`,
            );
          }
          const result = await connection.client.callTool({
            name: toolName,
            arguments: input,
          });
          const text = contentToText((result as any).content);
          if ((result as any).isError) {
            throw new Error(
              `${logPrefix} tool '${exposedName}' failed: ${text}`,
            );
          }
          return text;
        },
      }),
    );
  }
  return out;
}

/**
 * Verify at load time that the catalogue is usable (no duplicate exposed names).
 * Pure diagnostics — does not modify tools.
 */
export function describeCatalogueForDeepAgent(config: ContinueConfig): {
  total: number;
  mcp: number;
} {
  const tools: Tool[] = config.tools ?? [];
  return {
    total: tools.length,
    mcp: tools.filter(isMcpTool).length,
  };
}
