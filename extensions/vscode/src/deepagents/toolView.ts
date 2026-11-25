/**
 * DeepAgent tools → Continue `Tool` views for the GUI.
 *
 * The DeepAgent tool definitions are the SINGLE source of truth. This module
 * reads them (the `createDeepAgentTools()` factories plus the deepagents
 * library's FilesystemMiddleware) and projects them into Continue's `Tool`
 * shape so the GUI Tools page, toolSettings and approval UI can display and
 * configure them. It never executes a tool and never defines one — it only
 * converts definitions.
 *
 * MCP tools are deliberately EXCLUDED here: their config lives in Continue
 * (mcpServerStatuses) and their views are still produced by doLoadConfig.ts.
 */

import type { Tool } from "core";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import type { StructuredToolInterface } from "@langchain/core/tools";
import { createFilesystemMiddleware } from "deepagents";
import { createDeepAgentTools, type AcpToolKitOptions } from "./acpToolKit";
import { SpecWorkflowController } from "./specWorkflow";
import type { AcpSurface } from "./acpToolBridge";

/** Tools that mutate state — shown as non-readonly in the GUI. */
const WRITE_TOOLS = new Set([
  "fs_write",
  "fs_append",
  "append_lines",
  "str_replace",
  "delete_file",
  "execute_pwsh",
  "control_pwsh_process",
  "create_hook",
  "update_session_information",
  "create_artifact",
  "start_spec_workflow",
  "run_spec_tasks",
]);

/** Map a DeepAgent tool name to a GUI display title. */
function displayTitle(name: string): string {
  return name
    .replace(/^mcp__.*__/, "")
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/** Convert one LangChain tool definition to a Continue Tool view. */
function lcToolToView(tool: StructuredToolInterface): Tool | undefined {
  const name = tool.name;
  if (!name) return undefined;
  let parameters: Record<string, unknown> = { type: "object", properties: {} };
  try {
    const schema = (tool as any).schema ?? (tool as any).parameters;
    if (schema)
      parameters = toJsonSchema(schema as never) as Record<string, unknown>;
  } catch {
    // keep the empty object schema
  }
  return {
    type: "function",
    function: {
      name,
      description: tool.description,
      parameters,
    },
    displayTitle: displayTitle(name),
    readonly: !WRITE_TOOLS.has(name),
    group: name.startsWith("mcp__") ? "MCP" : "Built-In",
  };
}

/**
 * Build GUI views for all DeepAgent-owned tools (self-contained + library fs).
 * Pass the same options used to build the real agent so surface-specific tools
 * match what the agent actually exposes.
 */
export function buildDeepAgentToolViews(options: AcpToolKitOptions): Tool[] {
  const seen = new Set<string>();
  const out: Tool[] = [];

  const add = (tool: StructuredToolInterface) => {
    if (!tool.name || seen.has(tool.name)) return;
    seen.add(tool.name);
    const view = lcToolToView(tool);
    if (view) out.push(view);
  };

  // Self-contained tools (definitions only; their funcs are never called here).
  for (const tool of createDeepAgentTools(options)) add(tool);

  // deepagents library built-ins (FilesystemMiddleware.tools is a static array).
  const fsMiddleware = createFilesystemMiddleware();
  for (const tool of (fsMiddleware.tools ?? []) as StructuredToolInterface[]) {
    add(tool);
  }

  return out;
}

/** Names of all tools that will appear in the GUI from DeepAgent definitions. */
export function listDeepAgentToolViewNames(
  options: AcpToolKitOptions,
): string[] {
  return buildDeepAgentToolViews(options).map((t) => t.function.name);
}

/**
 * Convenience: build views with no IDE deps. Only definitions are read — every
 * tool's `func` is discarded, so the stub controller/session are never used.
 * Used when patching config.tools at model-wrap time where no session exists.
 */
export function buildDeepAgentToolViewsLite(
  surface: AcpSurface = "ide",
): Tool[] {
  return buildDeepAgentToolViews({
    surface,
    sessionId: "__tool_view__",
    specController: new SpecWorkflowController(),
    kiroExtraDeps: {},
  });
}
