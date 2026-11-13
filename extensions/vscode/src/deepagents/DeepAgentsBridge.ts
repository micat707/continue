/**
 * DeepAgentsBridge
 * ----------------
 * Bridges Continue's provider + tools into a Deep Agents (`deepagents`) LangGraph
 * agent, running in the VS Code extension host (node side) — NOT the webview.
 *
 * Architecture decision (see vscode-ai-extension-notes): replace ONLY the
 * orchestration layer (loop / planning / sub-agents / human-in-the-loop) with
 * deepagents; keep Continue's providers, tools, policy and editor integration.
 *
 * Status: SCAFFOLD. The model/tool adapters are stubbed and the
 * streamEvents -> ideMessenger -> gui Redux translation is TODO. `deepagents`
 * resolves to its TypeScript source (package.json `main`/`exports` point at
 * `src`), so edits to the clone hot-reload via `esbuild-watch` + Reload Window.
 */

import {
  createDeepAgent,
  type CreateDeepAgentParams,
  type DeepAgent,
} from "deepagents";

import { ContinueLLMAdapter } from "./ContinueLLMAdapter";

// Wraps Continue's `LLM` as a LangChain `BaseChatModel` (see ContinueLLMAdapter).
export type AdaptedModel = ContinueLLMAdapter;

// TODO(step 5): LangChain `StructuredTool[]` wrapping Continue's tool
// definitions, preserving client/core routing + evaluateToolCallPolicy.
export type AdaptedTools = any[];

export interface DeepAgentsBridgeOptions {
  model: AdaptedModel;
  tools?: AdaptedTools;
  systemPrompt?: string;
  /**
   * Human-in-the-loop. When enabled, risky operations (executing shell
   * commands, deleting files, reading/writing outside the workspace) pause for
   * user confirmation via LangGraph `interrupt()`. deepagents' own
   * FilesystemPermission only does static allow/deny by glob (read/write), so
   * command/delete confirmation must live here. See step 6.
   */
  enableHITL?: boolean;
}

export class DeepAgentsBridge {
  private agent: DeepAgent;

  constructor(options: DeepAgentsBridgeOptions) {
    // deepagents MERGES built-in filesystem tools with `tools`; to use ONLY
    // Continue's tools, the FilesystemMiddleware must be customized to drop
    // them. TODO: pass a customized FilesystemMiddleware.
    const params = {
      model: options.model,
      tools: options.tools,
      systemPrompt: options.systemPrompt,
    } as unknown as CreateDeepAgentParams;

    this.agent = createDeepAgent(params);
  }

  /**
   * Run the agent over a message list.
   * TODO(step 7): stream LangGraph events and translate them into ideMessenger
   * messages for the gui to render (token deltas, tool start/end, interrupts).
   */
  async run(messages: { role: string; content: string }[]): Promise<any> {
    const result = await this.agent.invoke({
      messages: messages as any,
    });
    return result;
  }
}
