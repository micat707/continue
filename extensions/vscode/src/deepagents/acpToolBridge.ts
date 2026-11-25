/**
 * ACP-style tool bridge.
 *
 * Mirrors Kiro's `ClientCapabilityTool` split:
 *   - a tool DEFINITION (id / description / schema / method) that is model-facing
 *     and identical on every surface, and
 *   - an EXECUTOR registered per surface, reached via `dispatch(method, params)`
 *     (Kiro: `connection.extMethod(this.definition.method, {...})`).
 *
 * This is an in-process analogue of Kiro's ACP `extMethod` channel: the tool
 * wrapper only knows a method string; where the work actually runs depends on
 * which executor the current surface registered. That removes the need to
 * duplicate the tool list in every caller and lets a CLI/Web surface swap in a
 * different implementation without touching the tool definition.
 *
 * Deliberately additive: existing self-contained `DynamicStructuredTool`s keep
 * working; only tools migrated into a registry use this path.
 */

import { z } from "zod";
import { DynamicStructuredTool } from "@langchain/core/tools";

export type AcpSurface = "ide" | "webview" | "cli" | "web";

/**
 * Tool definition — the model-facing half. `method` is the stable ACP-style
 * id used to dispatch execution (Kiro uses e.g. "_kiro/fs/read_file").
 */
export interface AcpToolDefinition<S extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  title?: string;
  description: string;
  schema: S;
  method: string;
}

export interface AcpToolExecContext {
  surface: AcpSurface;
  sessionId?: string;
  workspaceRoot?: string;
}

export interface AcpToolResult {
  content: string;
  isError?: boolean;
}

export type AcpToolExecutor<I = any> = (
  input: I,
  ctx: AcpToolExecContext,
) => AcpToolResult | string | Promise<AcpToolResult | string>;

const normalizeResult = (value: AcpToolResult | string): AcpToolResult =>
  typeof value === "string" ? { content: value } : value;

/**
 * Registry of definitions + per-surface executors.
 *
 * `dispatch()` is the analogue of Kiro's `connection.extMethod(method, params)`.
 * The surface-specific executor is chosen at registration time, so the same
 * definition can run against local fs in the IDE and a sandbox fs on Web.
 */
export class AcpToolRegistry {
  private readonly definitions = new Map<string, AcpToolDefinition>();
  private readonly executors = new Map<string, AcpToolExecutor>();

  constructor(private readonly ctx: AcpToolExecContext) {}

  /** Register a definition together with this surface's executor. */
  define<S extends z.ZodTypeAny, I>(
    definition: AcpToolDefinition<S>,
    executor: AcpToolExecutor<I>,
  ): void {
    this.definitions.set(definition.name, definition);
    this.executors.set(definition.method, executor as AcpToolExecutor);
  }

  has(name: string): boolean {
    return this.definitions.has(name);
  }

  /** Kiro-style method dispatch. Extra `sessionId` mirrors ACP's envelope. */
  async dispatch(method: string, params: any): Promise<AcpToolResult> {
    const executor = this.executors.get(method);
    if (!executor) {
      return {
        content: `[${method}] no executor registered for surface "${this.ctx.surface}".`,
        isError: true,
      };
    }
    try {
      return normalizeResult(await executor(params, this.ctx));
    } catch (e) {
      const err = e as Error;
      return { content: `[${method}] failed: ${err.message}`, isError: true };
    }
  }

  /** Reify definitions as LangChain tools whose `func` only dispatches. */
  tools(): DynamicStructuredTool[] {
    const out: DynamicStructuredTool[] = [];
    for (const def of this.definitions.values()) {
      const method = def.method;
      const registry = this;
      out.push(
        new DynamicStructuredTool({
          name: def.name,
          description: def.description,
          schema: def.schema,
          func: async (input: any) => {
            const result = await registry.dispatch(method, input);
            if (result.isError) return `[Tool failed] ${result.content}`;
            return result.content;
          },
        }),
      );
    }
    return out;
  }
}
