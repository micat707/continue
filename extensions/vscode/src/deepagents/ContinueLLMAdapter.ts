/**
 * ContinueLLMAdapter
 * ------------------
 * Wraps a Continue `ILLM` (the thing that actually calls the model via 30+
 * providers) into a LangChain `BaseChatModel`, so it can be handed to
 * `createDeepAgent({ model })`.
 *
 * Design (agreed during planning):
 *  - This adapter is a message translator. It does NOT inject tool schemas
 *    into the system prompt — `createDeepAgent`/`createAgent` already injects
 *    tool descriptions from the `tools` array (native function calling or
 *    LangGraph's text fallback). The only addition is an optional dynamic
 *    `systemContext` appended to the first system message on every model call.
 *  - Provider-specific tool-call compatibility patching is handled by
 *    deepagents' built-in `createPatchToolCallsMiddleware`, not here.
 *  - The only non-trivial translation is turning Continue's
 *    `AssistantChatMessage.toolCalls` back into LangChain `AIMessage.tool_calls`
 *    so the graph can route to the right tool.
 *
 * Streaming: `_streamResponseChunks` is implemented so LangGraph's
 * `streamMode: "messages"` (and therefore deepagents' `run.messages` / `.text`)
 * receives real token deltas instead of one chunk at the very end. Tool-call
 * fragments are merged the same way in both `_generate` and
 * `_streamResponseChunks` via the shared helpers below.
 */

import {
  BaseChatModel,
  type BaseChatModelCallOptions,
  type ChatResult,
} from "@langchain/core/language_models/chat_models";
import {
  AIMessage,
  AIMessageChunk,
  HumanMessage,
  SystemMessage,
  ToolMessage,
  type BaseMessage,
  type MessageContent as LcMessageContent,
} from "@langchain/core/messages";
import { ChatGenerationChunk } from "@langchain/core/outputs";
import { toJsonSchema } from "@langchain/core/utils/json_schema";
import { randomUUID } from "node:crypto";
import * as vscode from "vscode";

import type {
  ILLM,
  ChatMessage,
  MessageContent,
  MessagePart,
  ToolCallDelta,
  CompletionOptions,
  Tool,
} from "core";

import { logLlmIo } from "./workspaceBackend";
import { registerRawApiLogger } from "core/llm/llms/rawApiLogger";

/**
 * Kiro keeps two names per built-in tool: a stable internal `id` and a short
 * `displayName`. The model-facing tool specification uses the id as its function
 * name (see `.kiro/compare/kiro_tools.txt`: `read_file`, `fs_write`, ...), while
 * the prose description refers to the displayName ("use glob or bash ls").
 *
 * Kiro's dispatcher accepts either spelling (`find(id) ?? find(displayName)`),
 * so we send the raw ids to the model and only normalize short display names
 * back to ids on the way in. That keeps our wire format identical to Kiro and
 * still tolerates models that follow the prose instead of the function name.
 */
const TOOL_DISPLAY_TO_ID: Record<string, string> = {
  glob: "file_search",
  grep: "grep_search",
  read: "read_file",
  write: "fs_write",
  edit: "str_replace",
  bash: "execute_pwsh",
  web_search: "remote_web_search",
};

// The raw wire-level (provider-format) logger lives in core but the on-disk
// writer (`logLlmIo`) is extension-only, so we bridge it once. The sink now
// receives a `sessionId` argument threaded from BaseLLM.streamChat's
// MessageOption down through this adapter, so RAW entries carry the SAME id as
// this instance's logApiJson entries — no module-level "latest adapter wins"
// guessing (that was removed because it mislabelled concurrent sessions).
let rawApiLoggerRegistered = false;

export interface ContinueLLMAdapterOptions {
  /** The Continue LLM instance that actually talks to the model. */
  llm: ILLM;
  /**
   * Owning chat session id, from DeepAgentLLM.wrapper.streamChat. Stamped on
   * every llm.log entry (adapter-level AND wire-level RAW) so all logs for one
   * conversation share a single id. Falls back to a random id if omitted.
   */
  sessionId?: string;
  /**
   * Optional dynamic context, evaluated on EVERY model call and appended to the
   * FIRST system message. Continue's `compileChatMessages` keeps only the
   * first system message and filters out the rest, so injecting a second
   * SystemMessage would silently lose it.
   */
  systemContext?: () => string;
}

/**
 * Default output-token budget, used ONLY when the model config
 * (config.yaml `models[].completionOptions.maxTokens`) leaves it unset.
 *
 * We do NOT override a smaller user value with a floor: if the budget is too
 * small the model output gets truncated, and `assertNotTruncated` turns that
 * into an explicit "超出最大 token" error instead of silently killing the
 * turn (which previously looked like "stopped during deep thinking").
 */
const DEFAULT_AGENT_MAX_TOKENS = 16384;

/**
 * A model stream that goes silent for this long (no chunk at all) is treated as
 * a dead provider connection — we abandon THIS attempt (abort its request) and
 * re-issue it, instead of hanging until the client's own multi-minute timeout
 * finally gives up. 60s is well above any legitimate thinking/thinking-only
 * gap but far below the provider's real stall window.
 */
const MODEL_STREAM_STALL_MS = 60_000;
/** Automatic retries after a stall / empty / errored attempt (1 ⇒ at most two
 *  model calls). One retry masks the transient provider drops we keep seeing on
 *  SiliconFlow/Qwen3-27B; more than one risks burning tokens on a real outage. */
const MAX_MODEL_RETRIES = 1;

export class ContinueLLMAdapter extends BaseChatModel {
  llm: ILLM;

  /** Stable id for THIS chat session (from wrapper.streamChat). Stamped on every
   *  llm.log header — adapter-level AND wire-level RAW — so the viewer groups a
   *  whole conversation under one id. Falls back to random if not provided. */
  private readonly sessionId: string;

  private readonly systemContext?: () => string;

  /** Lazy OutputChannel for raw request/response debugging. */
  private static debugOut: vscode.OutputChannel | undefined;

  /**
   * Build marker: bump this stamp whenever you rebuild the extension, so the
   * Extension Host Console shows unambiguously which source version is live.
   * Prints to console.log (not the OutputChannel) so it appears alongside the
   * stream errors users see in the Console tab.
   */
  private static readonly BUILD_STAMP =
    "2026-11-24-v4-startoffsetfix+stacktrace";
  private static logBuildMarker(
    path: string,
    isSpec: boolean,
    model: string,
  ): void {
    console.log(
      `[DeepAgentBuild] stamp=${ContinueLLMAdapter.BUILD_STAMP} path=${path} spec=${isSpec} model=${model}`,
    );
  }
  private static isSpecPrompt(continueMessages: ChatMessage[]): boolean {
    return continueMessages.some(
      (m) =>
        m.role === "system" &&
        typeof m.content === "string" &&
        (m.content.includes("SPEC WORKFLOW") ||
          m.content.includes("Specification Workflow") ||
          m.content.includes("Task Execution Orchestrator")),
    );
  }

  private static logDebug(...args: unknown[]): void {
    if (!ContinueLLMAdapter.debugOut) {
      ContinueLLMAdapter.debugOut =
        vscode.window.createOutputChannel("DeepAgent Debug");
    }
    for (const a of args) {
      ContinueLLMAdapter.debugOut.appendLine(
        typeof a === "string" ? a : JSON.stringify(a, null, 2),
      );
    }
  }

  constructor(fields: ContinueLLMAdapterOptions) {
    super({});
    this.llm = fields.llm;
    this.systemContext = fields.systemContext;
    this.sessionId = fields.sessionId ?? randomUUID();
    if (!rawApiLoggerRegistered) {
      rawApiLoggerRegistered = true;
      registerRawApiLogger((section: string, body: string, sid?: string) =>
        logLlmIo(section, body, undefined, sid),
      );
    }
  }

  _llmType(): string {
    return "continue-llm";
  }

  /**
   * Dump a model request/response as the exact JSON wire shape
   * (`{ model, messages, tools, ... }` / `{ content, toolCalls, ... }`) to
   * `<workspace>/tmp/llm.log` so the user can inspect what is actually sent to
   * / returned from the model — and decide what to trim to save tokens. Called
   * once per model invocation (an agent turn makes several), so the file shows
   * the request that carries each tool result too. Never let logging break a call.
   */
  private logApiJson(section: string, obj: unknown): void {
    try {
      logLlmIo(
        section,
        JSON.stringify(obj, null, 2),
        undefined,
        this.sessionId,
      );
    } catch {
      /* logging must never break a model call */
    }
  }

  /**
   * langgraph's `createAgent` requires the model to expose `bindTools` so it can
   * attach its tool classes. This langchain version provides `withConfig` (not
   * `bind`) for carrying extra config, so we use that. We don't inject tool
   * schemas into the system prompt (createDeepAgent already does that from its
   * `tools` array); we just carry the bound tools on the returned runnable so
   * `_generate` can see them. Real tool-calling translation (provider-native vs
   * code-block fallback) is step 5.
   */
  bindTools(tools: unknown[], kwargs?: Partial<BaseChatModelCallOptions>) {
    return this.withConfig({
      tools,
      ...kwargs,
    } as unknown as Partial<BaseChatModelCallOptions>);
  }

  /**
   * Convert the LangChain tools deepagents bound onto the model into Continue's
   * `Tool` format so they can be handed to `llm.streamChat` as native function
   * calling. Handles both OpenAI-format definitions and LangChain
   * `StructuredTool` instances. LangChain tools store their input schema either
   * as a Zod object or a JSON schema (no `parameters` getter in this version),
   * so we normalize via `toJsonSchema`, which handles both.
   */
  private toContinueTools(lcTools: unknown[]): Tool[] {
    const out: Tool[] = [];
    for (const t of lcTools ?? []) {
      const c = t as {
        function?: {
          name?: string;
          description?: string;
          parameters?: Record<string, unknown>;
        };
        name?: string;
        description?: string;
        parameters?: Record<string, unknown>;
        schema?: unknown;
      };
      // Already OpenAI/Continue function format.
      if (c.function?.name) {
        out.push({
          type: "function",
          function: {
            name: c.function.name,
            description: c.function.description,
            parameters: c.function.parameters ?? {
              type: "object",
              properties: {},
            },
          },
        });
        continue;
      }
      // LangChain StructuredTool.
      if (!c.name) continue;
      let parameters = c.parameters ?? c.schema;
      if (parameters) {
        try {
          parameters = toJsonSchema(parameters as never);
        } catch {
          parameters = { type: "object", properties: {} };
        }
      } else {
        parameters = { type: "object", properties: {} };
      }
      out.push({
        type: "function",
        function: {
          name: c.name,
          description: c.description,
          parameters: parameters as Record<string, unknown>,
        },
      });
    }
    return out;
  }

  // ---- LangChain messages -> Continue ChatMessage ----

  private toContinueMessages(messages: BaseMessage[]): ChatMessage[] {
    const converted = messages.map((m) => this.toContinueMessage(m));
    const context = this.systemContext?.().trim();
    if (!context) return converted;

    // Continue keeps only the FIRST system message, so append to it instead of
    // adding a second one. This happens at the translation boundary: the result
    // is a Continue ChatMessage[] that never flows back into LangGraph state,
    // so the context is rebuilt fresh on each model call and cannot accumulate
    // in the conversation history.
    for (const m of converted) {
      if (m.role === "system") {
        m.content = m.content ? `${m.content}\n\n${context}` : context;
        return converted;
      }
    }
    converted.unshift({ role: "system", content: context });
    return converted;
  }

  private toContinueMessage(m: BaseMessage): ChatMessage {
    const role = m._getType();

    if (role === "system") {
      return { role: "system", content: this.lcContentToString(m.content) };
    }
    if (role === "human") {
      return { role: "user", content: this.lcContentToContinue(m.content) };
    }
    if (role === "tool") {
      const tm = m as ToolMessage;
      return {
        role: "tool",
        content: this.lcContentToString(tm.content),
        toolCallId:
          (tm as unknown as { tool_call_id?: string }).tool_call_id ?? "",
      };
    }
    // assistant (or any other role) — also carries tool_calls when present.
    const am = m as AIMessage;
    const out: {
      role: "assistant";
      content: MessageContent;
      toolCalls?: ToolCallDelta[];
    } = {
      role: "assistant",
      content: this.lcContentToString(am.content),
    };
    if (am.tool_calls && am.tool_calls.length > 0) {
      out.toolCalls = am.tool_calls.map((tc) => ({
        id: tc.id,
        type: "function",
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args ?? {}),
        },
      }));
    }
    return out as ChatMessage;
  }

  private lcContentToString(content: LcMessageContent): string {
    if (typeof content === "string") return content;
    return content
      .map((p) => (typeof p === "string" ? p : p.type === "text" ? p.text : ""))
      .join("");
  }

  private lcContentToContinue(content: LcMessageContent): MessageContent {
    if (typeof content === "string") return content;
    const parts: MessagePart[] = [];
    for (const p of content) {
      if (typeof p === "string") {
        parts.push({ type: "text", text: p });
      } else if (p.type === "text") {
        parts.push({ type: "text", text: p.text });
      } else if (p.type === "image_url") {
        const url =
          typeof p.image_url === "string" ? p.image_url : p.image_url.url;
        parts.push({ type: "imageUrl", imageUrl: { url } });
      }
    }
    return parts;
  }

  // ---- Continue ChatMessage -> LangChain AIMessage ----

  private fromContinueAssistant(msg: ChatMessage): AIMessage {
    const m = msg as {
      content?: MessageContent;
      toolCalls?: ToolCallDelta[];
    };
    const tool_calls = (m.toolCalls ?? [])
      .filter((tc) => tc.function?.name)
      .map((tc) => ({
        id: tc.id ?? "",
        name: tc.function!.name!,
        args: this.safeParse(tc.function!.arguments),
        type: "tool_call" as const,
      }));
    return new AIMessage({
      content: this.lcContentToString(m.content ?? ""),
      tool_calls,
    });
  }

  private safeParse(s?: string): Record<string, unknown> {
    if (!s) return {};
    try {
      return JSON.parse(s);
    } catch {
      return {};
    }
  }

  /**
   * Extract tool calls the model emitted as TEXT instead of native
   * `tool_calls`. Handles:
   *  - Qwen3-Coder XML style: `<function=NAME><parameter=KEY>VALUE</parameter>...</function>`
   *  - Hermes/Qwen JSON style: `<tool_call>{"name":"...","arguments":{...}}</tool_call>`
   * Returns the extracted calls plus the content with those blocks stripped.
   */
  private parseTextToolCalls(content: string): {
    toolCalls: ToolCallDelta[];
    cleaned: string;
  } {
    const toolCalls: ToolCallDelta[] = [];
    let cleaned = content;
    const genId = () => `tool_${Math.random().toString(36).slice(2, 10)}`;

    // XML style (Qwen3-Coder's trained tool-call format).
    const xmlRe = /<function=([^>\n]+)>([\s\S]*?)<\/function>/g;
    cleaned = cleaned.replace(xmlRe, (_m, rawName: string, body: string) => {
      const args: Record<string, string> = {};
      const paramRe = /<parameter=([^>\n]+)>([\s\S]*?)<\/parameter>/g;
      let pm: RegExpExecArray | null;
      while ((pm = paramRe.exec(body)) !== null) {
        // Trim a single leading/trailing newline the template puts around values.
        args[pm[1].trim()] = pm[2]
          .replace(/^\r?\n/, "")
          .replace(/\r?\n[\s]*$/, "");
      }
      toolCalls.push({
        id: genId(),
        type: "function",
        function: { name: rawName.trim(), arguments: JSON.stringify(args) },
      });
      return "";
    });

    // JSON style wrapped in <tool_call> tags.
    const jsonRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
    cleaned = cleaned.replace(jsonRe, (m, body: string) => {
      if (body.includes("<function=")) return ""; // already extracted above
      const obj = this.safeParse(body) as {
        name?: string;
        arguments?: Record<string, unknown>;
      };
      if (obj && typeof obj.name === "string") {
        toolCalls.push({
          id: genId(),
          type: "function",
          function: {
            name: obj.name,
            arguments: JSON.stringify(obj.arguments ?? {}),
          },
        });
        return "";
      }
      return m; // not a tool call — keep it
    });

    cleaned = cleaned.replace(/<\/?tool_call>/g, "").trim();
    return { toolCalls, cleaned };
  }

  // ---- Shared response accumulation (used by both paths) ----

  /**
   * Merge one streamed tool-call fragment. OpenAI-style streams send the id and
   * name in the first chunk, then argument fragments with NO id/name (Continue's
   * `fromChatCompletionChunk` drops `index`), so we append to the last call.
   */
  private mergeToolCallFragment(
    mergedCalls: ToolCallDelta[],
    tc: ToolCallDelta,
  ): void {
    const name = tc.function?.name;
    const args = tc.function?.arguments ?? "";
    let target: ToolCallDelta | undefined;
    if (tc.id) {
      target = mergedCalls.find((m) => m.id === tc.id);
    }
    if (!target && (name || tc.id)) {
      target = {
        id: tc.id,
        type: "function",
        function: { name, arguments: args },
      };
      mergedCalls.push(target);
    } else if (!target && mergedCalls.length > 0) {
      target = mergedCalls[mergedCalls.length - 1];
    } else if (!target) {
      target = {
        type: "function",
        function: { name: undefined, arguments: args },
      };
      mergedCalls.push(target);
    }
    if (target.function?.name === undefined && name) {
      target.function = { ...target.function, name };
    }
    if (args) {
      target.function = {
        ...target.function,
        arguments: (target.function?.arguments ?? "") + args,
      };
    }
  }

  /**
   * Recover tool calls the model emitted as TEXT (or native calls with dropped
   * arguments) once the full content is known.
   */
  private finalizeResponse(
    content: string,
    mergedCalls: ToolCallDelta[],
    lcTools: unknown[] | undefined,
  ): { content: string; toolCalls: ToolCallDelta[] } {
    let toolCalls = mergedCalls;
    const nativeHasArgs = toolCalls.some(
      (tc) =>
        tc.function?.arguments &&
        tc.function.arguments.trim() !== "{}" &&
        tc.function.arguments.trim() !== "",
    );
    const contentHasToolMarker =
      content.includes("<function=") || content.includes("<tool_call>");
    const shouldParseText =
      lcTools &&
      lcTools.length > 0 &&
      (toolCalls.length === 0 || (!nativeHasArgs && contentHasToolMarker));

    let finalContent = content;
    if (shouldParseText) {
      const parsed = this.parseTextToolCalls(content);
      if (parsed.toolCalls.length > 0) {
        toolCalls = parsed.toolCalls;
        finalContent = parsed.cleaned;
        ContinueLLMAdapter.logDebug(
          "parsed TEXT-format tool calls:",
          JSON.stringify(toolCalls, null, 2),
        );
      }
    }
    return { content: finalContent, toolCalls };
  }

  /**
   * Build the Continue completion options shared by both call paths.
   *
   * maxTokens is config-driven: the model config's
   * `completionOptions.maxTokens` is honored as-is. We only fill in a default
   * when it is unset. We deliberately do NOT clamp a smaller user value up —
   * an undersized budget truncates the model output, and `assertNotTruncated`
   * reports that explicitly rather than letting the turn die silently.
   */
  private buildCompletionOptions(
    lcTools: unknown[] | undefined,
  ): CompletionOptions {
    const userMaxTokens = this.llm.completionOptions?.maxTokens;
    return {
      model: this.llm.model,
      ...this.llm.completionOptions,
      ...(userMaxTokens != null
        ? { maxTokens: userMaxTokens }
        : { maxTokens: DEFAULT_AGENT_MAX_TOKENS }),
      ...(lcTools && lcTools.length
        ? { tools: this.toContinueTools(lcTools) }
        : {}),
    } as CompletionOptions;
  }

  /**
   * Throw a clear "out of tokens" error when the model output was truncated.
   * Two signals:
   *   - `finishReason === "length"`: the provider reports a hard max-token hit.
   *   - a text-format tool-call marker (`<function=` / `<tool_call>`) appeared
   *     in the content but was never finalized into a tool call: the provider
   *     mislabeled truncation as "stop" and cut the stream mid-call.
   * Either way the turn would otherwise end with "no tool calls" and look like
   * an unexplained mid-thinking stop.
   */
  private assertNotTruncated(
    content: string,
    hasToolCalls: boolean,
    finishReason: string | undefined,
    maxTokens: number | undefined,
  ): void {
    const truncatedByLimit = finishReason === "length";
    const markerStarted = ["<function=", "<tool_call>"].some((m) =>
      content.includes(m),
    );
    const cutMidCall = markerStarted && !hasToolCalls;
    if (!truncatedByLimit && !cutMidCall) return;

    const budget = maxTokens != null ? String(maxTokens) : "未设置";
    throw new Error(
      `超出最大输出 token（maxTokens=${budget}）。模型输出被截断${cutMidCall ? "（工具调用未完成）" : ""}，` +
        `无法完成本轮工具调用或回复。请在 config.yaml 为该模型增大 completionOptions.maxTokens，` +
        `或关闭/减小模型的思考预算（thinking）。`,
    );
  }

  /**
   * Filter merged native tool calls. A streamed call can end up with NO
   * function name when the provider loses the first (id+name) fragment but
   * keeps the argument fragments, or truncates the stream while mislabeling
   * it finish_reason "stop". LangChain cannot match a nameless call to any
   * tool, silently drops it, and the agent run then ends with "no tool
   * calls" — an unexplained mid-task stop. Drop pure noise and surface real
   * losses loudly instead.
   */
  private sanitizeToolCalls(toolCalls: ToolCallDelta[]): ToolCallDelta[] {
    const kept = toolCalls.filter((tc) => {
      const name = tc.function?.name;
      const args = (tc.function?.arguments ?? "").trim();
      // Pure noise: no name AND no arguments — drop silently.
      if (!name && (args === "" || args === "{}")) return false;
      // Arguments arrived but the identifying (id+name) fragment never did:
      // the model tried to call a tool and the name was lost mid-stream.
      if (!name) {
        throw new Error(
          "模型发起了工具调用但函数名丢失（疑似 provider 流式截断或 tool_calls 分片解析异常）。" +
            `收到的参数片段: ${(tc.function?.arguments ?? "").slice(0, 200)}` +
            "。请重试；若复现，请检查该 provider 的 tool_calls 流式返回格式。",
        );
      }
      // Native tool_call arguments must be complete JSON. A provider can cut
      // the stream mid-arguments and still label it finish_reason "stop", so
      // `assertNotTruncated` (which only checks text markers) misses it. That
      // leaves a half-written JSON like `{"path":"...md"` being dispatched to
      // the tool (e.g. fs_write with no `text`). Detect it here so it surfaces
      // as a clear error the agent can retry instead of a silent bad write.
      if (args !== "" && args !== "{}") {
        try {
          JSON.parse(args);
        } catch {
          throw new Error(
            `工具 ${name} 的参数 JSON 不完整（疑似输出被截断：` +
              `maxTokens 或流式中断）。` +
              `收到的参数片段: ${args.slice(0, 300)}` +
              "。请在 config.yaml 增大 completionOptions.maxTokens 后重试。",
          );
        }
      }
      // Normalize empty arguments to a valid empty object for the tool runtime.
      if (args === "") tc.function!.arguments = "{}";
      return true;
    });
    // Kiro dispatch accepts either the tool id or its short displayName. The
    // model normally calls the id we sent, but descriptions mention names like
    // glob/grep/read/bash, so normalize those to ids before LangGraph dispatch.
    for (const tc of kept) {
      const fn = tc.function;
      if (fn?.name) fn.name = TOOL_DISPLAY_TO_ID[fn.name] ?? fn.name;
    }
    return kept;
  }

  /**
   * A turn that ends with NEITHER text NOR a usable tool call is a silent
   * failure: the agent loop treats the empty response as the final answer and
   * stops without any explanation ("怎么突然就停了"). Surface it instead.
   */
  private assertNotEmptyResponse(
    content: string,
    usableCallCount: number,
    finishReason: string | undefined,
  ): void {
    if (usableCallCount > 0 || content.trim() !== "") return;
    throw new Error(
      `模型返回了空响应（finish_reason=${finishReason ?? "absent"}，无正文且无可用工具调用）— ` +
        "通常是 provider 流式异常或上下文问题，请重试。",
    );
  }

  /** Extract plain text from a Continue message content field. */
  private contentDelta(content: ChatMessage["content"]): string {
    if (!content) return "";
    return typeof content === "string"
      ? content
      : content.map((p) => (p.type === "text" ? p.text : "")).join("");
  }

  // ---- Core: one model call ----

  /**
   * A signal that mirrors `parent` (so a user "Stop" still cancels everything)
   * but can ALSO be aborted locally — used to kill a single stalled attempt's
   * request without aborting the whole turn (which would leave the user unable
   * to retry).
   */
  private static linkedSignal(parent?: AbortSignal): {
    signal: AbortSignal;
    localAbort: () => void;
  } {
    const ctrl = new AbortController();
    if (parent) {
      if (parent.aborted) ctrl.abort(parent.reason);
      else
        parent.addEventListener("abort", () => ctrl.abort(parent.reason), {
          once: true,
        });
    }
    return { signal: ctrl.signal, localAbort: () => ctrl.abort("stalled") };
  }

  /**
   * Open `llm.streamChat` and wrap it with a stall watchdog: if no chunk
   * arrives for MODEL_STREAM_STALL_MS, the local abort fires (cancelling this
   * attempt's request) so the caller's retry loop can re-issue. The underlying
   * generator is then expected to throw, which the caller catches and retries.
   */
  private callModelStream(
    continueMessages: ChatMessage[],
    parentSignal: AbortSignal | undefined,
    completionOptions: CompletionOptions,
  ): AsyncGenerator<ChatMessage, void, unknown> {
    const { signal, localAbort } =
      ContinueLLMAdapter.linkedSignal(parentSignal);
    const gen = this.llm.streamChat(
      continueMessages,
      signal,
      completionOptions,
      { precompiled: false, sessionId: this.sessionId },
    );
    let lastChunkAt = Date.now();
    const watchdog = setInterval(
      () => {
        if (Date.now() - lastChunkAt >= MODEL_STREAM_STALL_MS) {
          clearInterval(watchdog);
          localAbort();
        }
      },
      Math.min(5_000, MODEL_STREAM_STALL_MS),
    );
    return (async function* () {
      try {
        for await (const chunk of gen) {
          lastChunkAt = Date.now();
          yield chunk;
        }
      } finally {
        clearInterval(watchdog);
      }
    })();
  }

  async _generate(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
    _runManager?: unknown,
  ): Promise<ChatResult> {
    const continueMessages = this.toContinueMessages(messages);
    const signal = (options as { signal?: AbortSignal }).signal;
    const lcTools = (options as { tools?: unknown[] }).tools;

    // We DO send the tool schema to `llm.streamChat` so the model retains
    // awareness of the available tools (otherwise it falls back to e.g. writing
    // Python instead of calling them). For models like Qwen3-Coder served via an
    // OpenAI-compatible endpoint, the native function-calling path sometimes
    // DROPS the arguments (returning `tool_calls` with `args: {}`) or emits the
    // call as TEXT. `parseTextToolCalls` recovers both cases below. Models that
    // support native function calling properly (GPT-4/Claude/well-configured
    // servers) simply use the native `tool_calls` as-is.
    const completionOptions = this.buildCompletionOptions(lcTools);

    ContinueLLMAdapter.logBuildMarker(
      "_generate",
      ContinueLLMAdapter.isSpecPrompt(continueMessages),
      String(this.llm.model ?? completionOptions.model ?? "?"),
    );

    // ---- Debug: dump the exact JSON request sent to the model ----
    this.logApiJson("REQUEST-TO-MODEL", {
      model: completionOptions.model,
      maxTokens: completionOptions.maxTokens,
      tools: (completionOptions.tools ?? []).map((t) => ({
        name: t.function?.name,
        description: t.function?.description,
        parameters: t.function?.parameters,
      })),
      messages: continueMessages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: (m as { toolCallId?: string }).toolCallId,
      })),
    });

    // ---- Debug: dump what we send to the model ----
    const systemMsg = continueMessages.find((m) => m.role === "system");
    ContinueLLMAdapter.logDebug(
      "================= DeepAgent request =================",
      "model:",
      this.llm.model,
      "systemPrompt:",
      systemMsg ? JSON.stringify(systemMsg.content).slice(0, 4000) : "(none)",
      "TOOLS sent to model (name + parameters):",
      JSON.stringify(
        (completionOptions.tools ?? []).map((t) => ({
          name: t.function.name,
          parameters: t.function.parameters,
        })),
        null,
        2,
      ),
      "numMessages:",
      continueMessages.length,
      "maxTokens:",
      completionOptions.maxTokens,
    );

    // Retry loop: a stalled stream (no data for MODEL_STREAM_STALL_MS ⇒ local
    // abort ⇒ throw) or an empty/degenerate response is auto-retried up to
    // MAX_MODEL_RETRIES times — these are transient provider drops on
    // SiliconFlow/Qwen3-27B, not a real failure worth killing the turn over.
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
      const gen = this.callModelStream(
        continueMessages,
        signal,
        completionOptions,
      );
      let content = "";
      let finishReason: string | undefined;
      const mergedCalls: ToolCallDelta[] = [];
      // RESPONSE-DEBUG tracking: distinguish a genuinely empty model output from
      // one whose entire reply was emitted as a "thinking" (reasoning) chunk that
      // we deliberately drop from `content`. If a turn ends with content="" but
      // reasoningChars>0, the model answered in reasoning-only form (a capture
      // gap / Qwen deep-think quirk), not a true empty response.
      let reasoningChars = 0;
      let reasoningSample = "";
      let reasoning = ""; // full (untruncated) thinking text, surfaced in llm.log
      let rawChunkCount = 0;
      try {
        for await (const chunk of gen) {
          rawChunkCount++;
          // Reasoning chunks must not leak into assistant content (see the
          // streaming path for how they are surfaced).
          if (chunk.role === "thinking") {
            const thinking =
              typeof chunk.content === "string" ? chunk.content : "";
            reasoningChars += thinking.length;
            reasoning += thinking;
            if (reasoningSample.length < 1500) {
              reasoningSample += thinking.slice(
                0,
                1500 - reasoningSample.length,
              );
            }
            continue;
          }
          content += this.contentDelta(chunk.content);
          if ((chunk as { finishReason?: string }).finishReason) {
            finishReason = (chunk as { finishReason?: string }).finishReason;
          }
          for (const tc of chunk.toolCalls ?? []) {
            this.mergeToolCallFragment(mergedCalls, tc);
          }
        }

        // rawResponse = model text BEFORE finalizeResponse strips text-format
        // tool-call markers — the literal response stream, kept as an unprocessed
        // copy for agent tuning (the `content` field below is the cleaned one).
        const rawResponse = content;
        const finalized = this.finalizeResponse(content, mergedCalls, lcTools);
        content = finalized.content;

        // ---- Debug: dump the exact JSON response returned by the model ----
        this.logApiJson("RESPONSE-FROM-MODEL", {
          content,
          rawResponse,
          reasoning,
          toolCalls: finalized.toolCalls,
          finishReason,
        });
        this.logApiJson("RESPONSE-DEBUG", {
          path: "generate",
          finishReason,
          contentChars: content.length,
          reasoningChars,
          reasoningSample,
          rawChunkCount,
          toolCalls: mergedCalls.length,
        });
        console.log(
          `[DeepAgentBuild] _generate result stamp=${ContinueLLMAdapter.BUILD_STAMP} contentChars=${content.length} toolCalls=${mergedCalls.length} finish=${finishReason ?? "none"}`,
        );

        this.assertNotTruncated(
          content,
          finalized.toolCalls.length > 0,
          finishReason,
          completionOptions.maxTokens,
        );
        const usableCalls = this.sanitizeToolCalls(finalized.toolCalls);
        this.assertNotEmptyResponse(content, usableCalls.length, finishReason);
        const toolCalls: ToolCallDelta[] | undefined =
          usableCalls.length > 0 ? usableCalls : undefined;

        // ---- Debug: dump what the model returned ----
        ContinueLLMAdapter.logDebug(
          "----------------- DeepAgent response ----------------",
          "content:",
          content.slice(0, 4000),
          "toolCalls (native):",
          JSON.stringify(toolCalls ?? [], null, 2),
          "=====================================================",
        );

        const aggregated: ChatMessage = {
          role: "assistant",
          content,
          ...(toolCalls ? { toolCalls } : {}),
        } as ChatMessage;

        const aiMessage = this.fromContinueAssistant(aggregated);
        return {
          generations: [{ text: content, message: aiMessage }],
        };
      } catch (e) {
        lastError = e;
        // A user "Stop" must not be retried — bail immediately.
        if (signal?.aborted) {
          this.logApiJson("RESPONSE-DEBUG", {
            path: "generate",
            note: "aborted-by-user",
          });
          this.logApiJson("ERROR-FROM-MODEL", {
            reason: "aborted-by-user",
            attempt: attempt + 1,
            partialContent: content,
            partialReasoning: reasoning,
            rawChunkCount,
          });
          break;
        }
        this.logApiJson("ERROR-FROM-MODEL", {
          reason: "generate-failed",
          attempt: attempt + 1,
          error: String(e),
          stack: e instanceof Error ? e.stack : undefined,
          partialContent: content,
          partialReasoning: reasoning,
          rawChunkCount,
        });
        const genErr = e instanceof Error ? e : new Error(String(e));
        console.error(
          `[DeepAgent] _generate attempt ${attempt + 1}/${MAX_MODEL_RETRIES + 1} failed:`,
          genErr.message,
          "\nSTACK:",
          genErr.stack,
        );
        ContinueLLMAdapter.logDebug(
          `[DeepAgent] _generate attempt ${attempt + 1}/${MAX_MODEL_RETRIES + 1} failed: ${genErr.message}\n${genErr.stack ?? ""}`,
        );
      }
    }
    throw lastError ?? new Error("DeepAgent model call failed after retries");
  }

  /**
   * Token-level streaming. This is what makes `streamEvents(..., {version:"v3"})`
   * → `run.messages` → `.text` deliver incremental deltas. Without it LangChain
   * falls back to `_generate` and emits ONE chunk when the whole response is
   * finished, which is why the chat UI used to show everything at once.
   *
   * Text deltas are yielded as they arrive. Only a possible *prefix* of a
   * text-format tool-call marker (`<function=` / `<tool_call>`, emitted by some
   * Qwen3-Coder endpoints) is held back, so ordinary prose has zero delay. If a
   * complete marker appears we stop emitting and let `finalizeResponse` strip it.
   * Tool calls are emitted once, at the end, as `tool_call_chunks` with fully
   * merged arguments so LangChain's `collapseToolCallChunks` can parse them.
   */
  async *_streamResponseChunks(
    messages: BaseMessage[],
    options: BaseChatModelCallOptions,
    _runManager?: unknown,
  ): AsyncGenerator<ChatGenerationChunk> {
    const continueMessages = this.toContinueMessages(messages);
    const signal = (options as { signal?: AbortSignal }).signal;
    const lcTools = (options as { tools?: unknown[] }).tools;
    const completionOptions = this.buildCompletionOptions(lcTools);

    ContinueLLMAdapter.logBuildMarker(
      "_stream",
      ContinueLLMAdapter.isSpecPrompt(continueMessages),
      String(this.llm.model ?? completionOptions.model ?? "?"),
    );

    // ---- Debug: dump the exact JSON request sent to the model ----
    this.logApiJson("REQUEST-TO-MODEL", {
      model: completionOptions.model,
      maxTokens: completionOptions.maxTokens,
      tools: (completionOptions.tools ?? []).map((t) => ({
        name: t.function?.name,
        description: t.function?.description,
        parameters: t.function?.parameters,
      })),
      messages: continueMessages.map((m) => ({
        role: m.role,
        content: m.content,
        toolCalls: m.toolCalls,
        toolCallId: (m as { toolCallId?: string }).toolCallId,
      })),
    });

    // Text-format tool-call markers some Qwen3-Coder endpoints emit. If the
    // accumulated content ends with a *prefix* of one of these, hold back just
    // that prefix until the next delta tells us whether it really is a marker.
    const MARKERS = ["<function=", "<tool_call>"];
    const markerPrefixLen = (s: string): number => {
      let hold = 0;
      for (const m of MARKERS) {
        for (let k = Math.min(m.length - 1, s.length); k > hold; k--) {
          if (s.endsWith(m.slice(0, k))) {
            hold = k;
            break;
          }
        }
      }
      return hold;
    };
    const textChunk = (text: string) =>
      new ChatGenerationChunk({
        message: new AIMessageChunk({ content: text }),
        text,
      });

    // Retry loop: a stalled stream (no data for MODEL_STREAM_STALL_MS ⇒ local
    // abort ⇒ throw) or an empty/degenerate response is auto-retried up to
    // MAX_MODEL_RETRIES times — transient SiliconFlow/Qwen3-27B drops, not a
    // real failure worth killing the turn over.
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_MODEL_RETRIES; attempt++) {
      const gen = this.callModelStream(
        continueMessages,
        signal,
        completionOptions,
      );
      let content = "";
      let finishReason: string | undefined;
      let emitted = 0;
      let suppressed = false;
      let streamedChunks = 0;
      const mergedCalls: ToolCallDelta[] = [];
      // RESPONSE-DEBUG tracking (see _generate for rationale): measure how much
      // of this turn's reply arrived as "thinking" blocks vs real content.
      let reasoningChars = 0;
      let reasoningSample = "";
      let reasoning = ""; // full (untruncated) thinking text, surfaced in llm.log
      let rawChunkCount = 0;
      try {
        for await (const chunk of gen) {
          rawChunkCount++;
          // The underlying Continue stream carries reasoning as separate
          // {role:"thinking"} chunks (SiliconFlow/Qwen3 reasoning_content).
          // contentDelta() would fold that text into assistant content — exactly
          // the bug that showed thinking as normal chat text. Emit it as a
          // standard "reasoning" CONTENT BLOCK instead: convertChunksToEvents
          // turns it into content-block/reasoning-delta events, LangGraph's
          // messages stream forwards them, and ChatModelStream exposes them via
          // its `.reasoning` projection. additional_kwargs.reasoning_content is
          // NOT an option — convertChunksToEvents ignores it entirely.
          // index: -1 keeps the block clear of the text block (hardcoded 0 in
          // convertChunksToEvents) and tool-call blocks (1..n in finalizeResponse).
          if (chunk.role === "thinking") {
            const thinking =
              typeof chunk.content === "string" ? chunk.content : "";
            if (thinking) {
              reasoningChars += thinking.length;
              reasoning += thinking;
              if (reasoningSample.length < 1500) {
                reasoningSample += thinking.slice(
                  0,
                  1500 - reasoningSample.length,
                );
              }
              yield new ChatGenerationChunk({
                message: new AIMessageChunk({
                  content: [
                    { type: "reasoning", reasoning: thinking, index: -1 },
                  ],
                }),
                text: "",
              });
            }
            continue;
          }

          if ((chunk as { finishReason?: string }).finishReason) {
            finishReason = (chunk as { finishReason?: string }).finishReason;
          }

          for (const tc of chunk.toolCalls ?? []) {
            this.mergeToolCallFragment(mergedCalls, tc);
          }

          const delta = this.contentDelta(chunk.content);
          if (!delta) continue;
          content += delta;

          if (suppressed) continue;

          if (MARKERS.some((m) => content.includes(m))) {
            // A text-format tool call started. Everything from the marker onward
            // is buffered; finalizeResponse will strip it and produce real tool
            // calls.
            suppressed = true;
            continue;
          }

          // Emit everything except a possible partial marker prefix at the tail.
          const safeEnd = content.length - markerPrefixLen(content);
          if (safeEnd > emitted) {
            streamedChunks += 1;
            yield textChunk(content.slice(emitted, safeEnd));
            emitted = safeEnd;
          }
        }

        ContinueLLMAdapter.logDebug(
          `streamed ${streamedChunks} text chunk(s), chars=${content.length}, toolCalls=${mergedCalls.length}, finishReason=${finishReason ?? "(none)"}`,
        );

        // rawResponse = model text BEFORE finalizeResponse strips text-format
        // tool-call markers — kept as an unprocessed copy (see _generate).
        const rawResponse = content;
        const finalized = this.finalizeResponse(content, mergedCalls, lcTools);

        // ---- Debug: dump the exact JSON response returned by the model ----
        this.logApiJson("RESPONSE-FROM-MODEL", {
          content: finalized.content,
          rawResponse,
          reasoning,
          toolCalls: finalized.toolCalls,
          finishReason,
        });
        this.logApiJson("RESPONSE-DEBUG", {
          path: "stream",
          finishReason,
          contentChars: content.length,
          reasoningChars,
          reasoningSample,
          rawChunkCount,
          textChunkCount: streamedChunks,
          toolCalls: mergedCalls.length,
        });
        console.log(
          `[DeepAgentBuild] _stream result stamp=${ContinueLLMAdapter.BUILD_STAMP} contentChars=${content.length} toolCalls=${mergedCalls.length} finish=${finishReason ?? "none"}`,
        );

        // Surface a hard max-token truncation explicitly instead of letting the
        // turn end with "no tool calls" (it would look like a mid-thinking stop).
        this.assertNotTruncated(
          content,
          finalized.toolCalls.length > 0,
          finishReason,
          completionOptions.maxTokens,
        );

        const usableCalls = this.sanitizeToolCalls(finalized.toolCalls);
        this.assertNotEmptyResponse(content, usableCalls.length, finishReason);

        // Emit the remaining prose (for text-format tool calls, emit only the
        // cleaned remainder, never the raw tool-call markup).
        const remaining = finalized.content.slice(
          Math.min(emitted, finalized.content.length),
        );

        if (usableCalls.length > 0) {
          // Text content always occupies block index 0 in convertChunksToEvents,
          // so tool-call blocks must start at 1 to avoid clobbering it.
          const toolCallChunks = usableCalls.map((tc, i) => ({
            type: "tool_call_chunk" as const,
            id: tc.id || `call_${i}`,
            name: tc.function?.name ?? "",
            args: tc.function?.arguments || "{}",
            index: i + 1,
          }));
          yield new ChatGenerationChunk({
            message: new AIMessageChunk({
              content: remaining,
              tool_call_chunks: toolCallChunks,
            }),
            text: remaining,
          });
        } else if (remaining) {
          yield textChunk(remaining);
        }
        return;
      } catch (e) {
        lastError = e;
        // A user "Stop" must not be retried — bail immediately.
        if (signal?.aborted) {
          this.logApiJson("RESPONSE-DEBUG", {
            path: "stream",
            note: "aborted-by-user",
          });
          // Leave a trace even when the turn produced no response, so a
          // "REQUEST with no RESPONSE" gap in llm.log explains itself.
          this.logApiJson("ERROR-FROM-MODEL", {
            reason: "aborted-by-user",
            attempt: attempt + 1,
            partialContent: content,
            partialReasoning: reasoning,
            rawChunkCount,
          });
          break;
        }
        // Same for a failed attempt (provider error / crash / stall): without
        // this, the log only shows the request and the missing response is
        // indistinguishable from "the model never answered".
        this.logApiJson("ERROR-FROM-MODEL", {
          reason: "stream-failed",
          attempt: attempt + 1,
          error: String(e),
          stack: e instanceof Error ? e.stack : undefined,
          partialContent: content,
          partialReasoning: reasoning,
          rawChunkCount,
        });
        const streamErr = e instanceof Error ? e : new Error(String(e));
        console.error(
          `[DeepAgent] stream attempt ${attempt + 1}/${MAX_MODEL_RETRIES + 1} failed:`,
          streamErr.message,
          "\nSTACK:",
          streamErr.stack,
        );
        ContinueLLMAdapter.logDebug(
          `[DeepAgent] stream attempt ${attempt + 1}/${MAX_MODEL_RETRIES + 1} failed: ${streamErr.message}\n${streamErr.stack ?? ""}`,
        );
      }
    }
    throw lastError ?? new Error("DeepAgent model stream failed after retries");
  }
}
