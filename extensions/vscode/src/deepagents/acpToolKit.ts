/**
 * Shared tool assembly for every surface.
 *
 * Mirrors Kiro's split: a single tool list built from surface-independent
 * definitions + surface-registered executors. Previously `DeepAgentLLM.ts` and
 * `DeepAgentChatPanel.ts` each duplicated the same array; both now call this
 * factory with their own `AcpSurface`, so adding/aligning a tool happens once.
 *
 * Tools migrated to the ACP bridge are registered here. Un-migrated tools keep
 * their self-contained factories and are simply appended — the bridge is
 * additive and does not require a big-bang rewrite.
 */

import type { StructuredToolInterface } from "@langchain/core/tools";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { AcpToolRegistry, type AcpSurface } from "./acpToolBridge";
import { WEB_FETCH_DEFINITION, webFetchExecutor } from "./webFetchTool";
import { createBackgroundProcessTools } from "./workspaceBackend";
import { createWebSearchTools } from "./webSearchTool";
import { createSpecTools } from "./specTools";
import {
  createStartSpecWorkflowTool,
  createRunSpecTasksTool,
  type SpecWorkflowController,
} from "./specWorkflow";
import {
  createKiroExtraTools,
  type KiroExtraToolsDeps,
} from "./kiroExtraTools";
import {
  USER_INPUT_DESCRIPTION,
  userInputSchema,
  requestUserInput,
  formatUserInputResult,
} from "./userInputTool";
import type { ContinueConfig } from "core";
import { buildMcpLangChainTools } from "./toolAdapter";

export interface AcpToolKitOptions {
  surface: AcpSurface;
  sessionId: string;
  rootOverride?: string;
  specController: SpecWorkflowController;
  kiroExtraDeps: KiroExtraToolsDeps;
  /** IDE-only: reads the unified tool catalogue (config.tools); absent in ChatPanel. */
  getConfig?: () => Promise<ContinueConfig | undefined>;
}

export function createDeepAgentTools(
  options: AcpToolKitOptions,
): StructuredToolInterface[] {
  const registry = new AcpToolRegistry({
    surface: options.surface,
    sessionId: options.sessionId,
    workspaceRoot: options.rootOverride,
  });

  // ACP-bridged tools: one definition, surface-registered executor.
  registry.define(WEB_FETCH_DEFINITION, webFetchExecutor);

  // Self-contained tools (not yet on the bridge).
  const userInputTool = new DynamicStructuredTool({
    name: "user_input",
    title: "User Input",
    description: USER_INPUT_DESCRIPTION,
    schema: userInputSchema,
    func: async (input: z.infer<typeof userInputSchema>) => {
      const answer = await requestUserInput(input, options.sessionId);
      return formatUserInputResult(input, answer);
    },
  });

  return [
    ...registry.tools(),
    userInputTool,
    ...createBackgroundProcessTools(),
    ...createWebSearchTools(),
    ...createSpecTools(),
    createStartSpecWorkflowTool(options.specController),
    createRunSpecTasksTool(options.specController),
    ...createKiroExtraTools(options.kiroExtraDeps),
  ];
}

/**
 * Async variant used by the IDE harness: appends MCP tools discovered through
 * the LangChain adapter so they execute inside the DeepAgent agent loop rather
 * than Continue's `tools/call` path. The ChatPanel keeps the synchronous
 * factory because it has no MCP config to honour.
 */
export async function createDeepAgentToolsAsync(
  options: AcpToolKitOptions,
): Promise<{
  tools: StructuredToolInterface[];
  mcpInfo: Array<{ name: string; requiresApproval: boolean }>;
}> {
  const base = createDeepAgentTools(options);
  if (!options.getConfig) return { tools: base, mcpInfo: [] };

  const config = await options.getConfig();
  if (!config) return { tools: base, mcpInfo: [] };

  // MCP tools come from the unified catalogue (config.tools), not a second
  // discovery pass. Continue has already connected to each server.
  const mcpTools = buildMcpLangChainTools(config);
  const protectedServerIds = new Set(
    (config.mcpServerStatuses ?? [])
      .filter((s) => s.isProtectedResource)
      .map((s) => s.id),
  );
  const mcpInfo = mcpTools.map((t) => ({
    name: t.name,
    requiresApproval: [...protectedServerIds].some((id) =>
      t.name.startsWith(`mcp__${id.replace(/[^a-zA-Z0-9_-]/g, "_")}__`),
    ),
  }));
  return { tools: [...base, ...mcpTools], mcpInfo };
}
