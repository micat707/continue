import { selectActiveSession, selectSessionById } from "../slices/sessionSlice";
import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import React from "react";
import { LLMFullCompletionOptions, ModelDescription } from "core";
import { getRuleId } from "core/llm/rules/getSystemMessageWithRules";
import { ToCoreProtocol } from "core/protocol";
import { BUILT_IN_GROUP_NAME } from "core/tools/builtIn";
import { selectActiveTools } from "../selectors/selectActiveTools";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  abortStream,
  addPromptCompletionPair,
  clearDanglingMessages,
  ensureSessionAborter,
  errorToolCall,
  inSession,
  setActive,
  setAppliedRulesAtIndex,
  setContextPercentage,
  setInactive,
  setInlineErrorMessage,
  setIsPruned,
  setToolGenerated,
  streamUpdate,
} from "../slices/sessionSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import StreamErrorDialog from "../../pages/gui/StreamError";
import { ThunkApiType } from "../store";
import { constructMessages } from "../util/constructMessages";
import { getMicatEnvironmentContext } from "../util/environmentBlocks";

import { modelSupportsNativeTools } from "core/llm/toolSupport";
import { applyToolOverrides } from "core/tools/applyToolOverrides";
import { addSystemMessageToolsToSystemMessage } from "core/tools/systemMessageTools/buildToolsSystemMessage";
import { interceptSystemToolCalls } from "core/tools/systemMessageTools/interceptSystemToolCalls";
import { SystemMessageToolCodeblocksFramework } from "core/tools/systemMessageTools/toolCodeblocks";

import {
  selectCurrentToolCalls,
  selectPendingToolCalls,
} from "../selectors/selectToolCalls";
import { getBaseSystemMessage } from "../util/getBaseSystemMessage";
import { callToolById } from "./callToolById";
import { evaluateToolPolicies } from "./evaluateToolPolicies";
import { preprocessToolCalls } from "./preprocessToolCallArgs";
import { throttleChunkSave } from "./session";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

// Per-stream sequence id, stamped on every request/response marker so that
// concurrent LLM streams (parallel tool-call continuations) can be told apart
// when debugging "stream interrupted by a concurrent request" issues: each
// turn's request, first chunk, full completion and abort share the same id.
let streamRequestSeq = 0;

/**
 * Builds completion options with reasoning configuration based on session state and model capabilities.
 *
 * @param baseOptions - Base completion options to extend
 * @param hasReasoningEnabled - Whether reasoning is enabled in the session
 * @param model - The selected model with provider and completion options
 * @returns Completion options with reasoning configuration
 */
function buildReasoningCompletionOptions(
  baseOptions: LLMFullCompletionOptions,
  hasReasoningEnabled: boolean | undefined,
  model: ModelDescription,
): LLMFullCompletionOptions {
  if (hasReasoningEnabled === undefined) {
    return baseOptions;
  }

  const reasoningOptions: LLMFullCompletionOptions = {
    ...baseOptions,
    reasoning: !!hasReasoningEnabled,
  };

  // Add reasoning budget tokens if reasoning is enabled and provider supports it
  if (hasReasoningEnabled && model.underlyingProviderName !== "ollama") {
    // Ollama doesn't support limiting reasoning tokens at this point
    reasoningOptions.reasoningBudgetTokens =
      model.completionOptions?.reasoningBudgetTokens ?? 2048;
  }

  return reasoningOptions;
}

export const streamNormalInput = createAsyncThunk<
  void,
  {
    legacySlashCommandData?: ToCoreProtocol["llm/streamChat"][0]["legacySlashCommandData"];
    depth?: number;
    /** Owning chat session id. Captured once at the stream entry point and
     * threaded explicitly through every async step, so a background stream can
     * never be mistaken for whichever chat happens to be on screen. */
    sessionId?: string;
  },
  ThunkApiType
>(
  "chat/streamNormalInput",
  async (
    { legacySlashCommandData, depth = 0, sessionId },
    { dispatch, extra, getState },
  ) => {
    if (process.env.NODE_ENV === "test" && depth > 50) {
      const message = `Max stream depth of ${50} reached in test`;
      console.error(message, JSON.stringify(getState(), null, 2));
      throw new Error(message);
    }
    const state = getState();
    // Closure-captured owning session. All downstream async work must use this
    // value, never a fresh selectActiveSession(getState()).id (which changes on tab switch).
    const owningSessionId = sessionId ?? selectActiveSession(state).id;
    const selectedChatModel = selectSelectedChatModel(state);

    if (!selectedChatModel) {
      throw new Error("No chat model selected");
    }

    // Get tools and apply model-level overrides (disabled, description, etc.)
    let activeTools = selectActiveTools(state);
    if (selectedChatModel.toolOverrides?.length) {
      const { tools: overriddenTools, errors } = applyToolOverrides(
        activeTools,
        selectedChatModel.toolOverrides,
      );
      activeTools = overriddenTools;
      for (const error of errors) {
        if (!error.fatal) {
          console.warn(`Tool override warning: ${error.message}`);
        }
      }
    }

    // Use the centralized selector to determine if system message tools should be used
    const useNativeTools = state.config.config.experimental
      ?.onlyUseSystemMessageTools
      ? false
      : modelSupportsNativeTools(selectedChatModel);
    const systemToolsFramework = !useNativeTools
      ? new SystemMessageToolCodeblocksFramework()
      : undefined;

    // Construct completion options
    let completionOptions: LLMFullCompletionOptions = {};
    if (useNativeTools && activeTools.length > 0) {
      completionOptions = {
        tools: activeTools,
      };
    }

    const owningSession = selectSessionById(state, owningSessionId);
    completionOptions = buildReasoningCompletionOptions(
      completionOptions,
      owningSession.hasReasoningEnabled,
      selectedChatModel,
    );

    // Construct messages (excluding system message)
    const baseSystemMessage = getBaseSystemMessage(
      owningSession.mode,
      selectedChatModel,
      activeTools,
    );

    const systemMessage = systemToolsFramework
      ? addSystemMessageToolsToSystemMessage(
          systemToolsFramework,
          baseSystemMessage,
          activeTools,
        )
      : baseSystemMessage;

    const withoutMessageIds = owningSession.history.map((item) => {
      const { id, ...messageWithoutId } = item.message;
      return { ...item, message: messageWithoutId };
    });

    // Kiro-style environment context: system-level blocks (OS/shell/file tree
    // snapshot, cached per session) + open editor files for the last message.
    const environmentContext = await getMicatEnvironmentContext(
      extra.ideMessenger,
      owningSessionId ?? "default",
    );
    let openEditorFiles: string[] = [];
    let activeEditorFileName: string | undefined;
    try {
      openEditorFiles = await extra.ideMessenger.ide.getOpenFiles();
    } catch {
      // optional context
    }
    try {
      const currentFile = await extra.ideMessenger.ide.getCurrentFile();
      activeEditorFileName = currentFile?.path;
    } catch {
      // optional context
    }

    const { messages, appliedRules, appliedRuleIndex } = constructMessages(
      withoutMessageIds,
      systemMessage,
      state.config.config.rules,
      state.ui.ruleSettings,
      systemToolsFramework,
      environmentContext,
      openEditorFiles,
      activeEditorFileName,
    );

    // TODO parallel tool calls will cause issues with this
    // because there will be multiple tool messages, so which one should have applied rules?
    dispatch(
      inSession(
        setAppliedRulesAtIndex({
          index: appliedRuleIndex,
          appliedRules: appliedRules,
        }),
        owningSessionId,
      ),
    );

    dispatch(inSession(setActive(), owningSessionId));
    dispatch(inSession(setInlineErrorMessage(undefined), owningSessionId));

    const precompiledRes = await extra.ideMessenger.request("llm/compileChat", {
      messages,
      options: completionOptions,
    });

    if (precompiledRes.status === "error") {
      if (precompiledRes.error.includes("Not enough context")) {
        dispatch(
          inSession(setInlineErrorMessage("out-of-context"), owningSessionId),
        );
        dispatch(inSession(setInactive(), owningSessionId));
        return;
      } else {
        throw new Error(precompiledRes.error);
      }
    }

    const { compiledChatMessages, didPrune, contextPercentage } =
      precompiledRes.content;

    const start = Date.now();
    const requestId = ++streamRequestSeq;

    // Request preview (debug): print each message's role + a TRUNCATED content
    // preview (full dumps are huge). The #N id is the important bit — it lets
    // the request be correlated with its first chunk / completion / abort even
    // across concurrent streams.
    console.log(
      `[streamNormalInput] ── request #${requestId} to model (${compiledChatMessages.length} messages) ──`,
    );
    compiledChatMessages.forEach((m, i) => {
      const preview =
        typeof m.content === "string"
          ? m.content.slice(0, 300)
          : Array.isArray(m.content)
            ? m.content
                .map((p) =>
                  p.type === "text"
                    ? String((p as { text?: unknown }).text ?? "").slice(0, 200)
                    : p.type,
                )
                .join(" | ")
            : typeof m.content;
      console.log(
        `[streamNormalInput]   [#${requestId}][${i}] role=${m.role} contentPreview=${JSON.stringify(preview)}`,
      );
    });

    dispatch(inSession(setIsPruned(didPrune), owningSessionId));
    dispatch(
      inSession(setContextPercentage(contextPercentage), owningSessionId),
    );

    // Bind this turn's AbortController to the OWNING session, not the global
    // single slot. This is the GUI side of session-scoped cancellation: a Stop
    // in another chat signals a different controller and leaves this stream
    // untouched. `ensureSessionAborter` is idempotent across tool continuations.
    dispatch(ensureSessionAborter(owningSessionId));
    const ownerSession = selectSessionById(getState(), owningSessionId);
    const streamAborter =
      ownerSession.streamAborters?.[owningSessionId] ??
      ownerSession.streamAborter;
    // Captured so the turn-end branch (below, outside this try) can print the
    // full reply when the model returns plain text with no tool call. Must be
    // declared OUTSIDE the try — the turn-end branch references it.
    let finalCompletion = "";
    try {
      // Diagnostics for "the turn is stuck": these four markers tell whether
      // the request was ever sent, whether the model answered at all, and
      // whether the stream finished, was aborted or threw. Open the webview
      // console with "Developer: Open Webview Developer Tools".
      console.log(
        `[continue] → LLM request #${requestId}`,
        selectedChatModel.title,
        `messages=${compiledChatMessages.length}`,
        // Which tool protocol is in play, and how many tools are attached.
        // native + tools>0 but the model never calls any → the ENDPOINT is
        // dropping/ignoring the `tools` param (e.g. vLLM without
        // --enable-auto-tool-choice/--tool-call-parser).
        `mode=${systemToolsFramework ? "system-message" : "native"}`,
        `activeTools=${activeTools.length}`,
        `cap.tools=${selectedChatModel.capabilities?.tools}`,
        // The actual tool names attached to the request — confirms e.g.
        // whether a "read file" tool is present among the 13.
        `tools=[${activeTools.map((t) => t.function.name).join(", ")}]`,
      );
      let gen = extra.ideMessenger.llmStreamChat(
        {
          completionOptions,
          title: selectedChatModel.title,
          messages: compiledChatMessages,
          sessionId: owningSessionId,
          legacySlashCommandData,
          messageOptions: {
            precompiled: true,
            sessionId: owningSessionId,
          },
        },
        streamAborter.signal,
      );
      if (systemToolsFramework && activeTools.length > 0) {
        gen = interceptSystemToolCalls(
          gen,
          streamAborter,
          systemToolsFramework,
        );
      }

      // Watchdog: a silently-dropped connection (network cut overnight, proxy
      // killing an idle SSE stream) delivers NO chunk and NO error, so the
      // bare `await gen.next()` hangs forever with isStreaming stuck true and
      // the tool-call chip spinning — the "卡了一晚上" report. Race every read
      // against an inactivity timer; on stall, clean up exactly like the Stop
      // button (setInactive + abortStream + clearDanglingMessages) and tell
      // the user what happened.
      const STREAM_INACTIVITY_TIMEOUT_MS = 3 * 60_000;
      const readNext = () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        return Promise.race([
          gen.next(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `[continue] LLM stream stalled: no chunks for ${STREAM_INACTIVITY_TIMEOUT_MS / 1000}s — connection presumed dead`,
                  ),
                ),
              STREAM_INACTIVITY_TIMEOUT_MS,
            );
          }),
        ]).finally(() => clearTimeout(timer));
      };
      const handleStalledStream = (e: unknown): boolean => {
        if (
          !(e instanceof Error) ||
          !e.message.includes("LLM stream stalled")
        ) {
          return false;
        }
        console.error("[continue] ✕", e.message, `#${requestId}`);
        dispatch(inSession(setInactive(), owningSessionId));
        dispatch(abortStream(owningSessionId));
        dispatch(inSession(clearDanglingMessages(), owningSessionId));
        dispatch(
          setDialogMessage(
            React.createElement(StreamErrorDialog, {
              error: new Error(
                "模型响应流中断：超过 3 分钟没有收到任何数据，连接已按断开处理。请重试你的请求。",
              ),
            }),
          ),
        );
        dispatch(setShowDialog(true));
        return true;
      };

      let next: Awaited<ReturnType<typeof gen.next>>;
      try {
        next = await readNext();
      } catch (e) {
        if (handleStalledStream(e)) {
          return;
        }
        throw e;
      }
      console.log(
        `[continue] ← LLM first chunk #${requestId}`,
        `${Date.now() - start}ms`,
        next.done ? "(empty / done)" : "",
      );
      while (!next.done) {
        // Liveness is owned by THIS stream's AbortController, not by the global
        // `selectActiveSession(state).isStreaming` flag. Reading the global flag made a turn
        // in another chat (or a tab switch's newSession) look like an
        // unexpected interruption of this stream — producing the spurious
        // "response was interrupted" dialog and, worse, letting this stream
        // keep writing chunks into whichever session happened to be visible.
        // A switch-away aborts the controller captured at entry (same object),
        // so this check stops the background turn cleanly before any chunk is
        // dispatched.
        if (streamAborter.signal.aborted) {
          console.log(
            `[continue] ✕ LLM stream #${requestId} aborted (signal aborted)`,
          );
          break;
        }

        // Diagnostic: show the raw shape of any chunk carrying tool calls —
        // if tool calls still go missing downstream, this proves whether
        // they arrived at the GUI at all.
        const toolCallChunk = next.value.find(
          (m) => m.role === "assistant" && (m as any).toolCalls?.length,
        );
        if (toolCallChunk) {
          console.log(
            "[continue] ← chunk with toolCalls:",
            JSON.stringify(toolCallChunk).slice(0, 400),
          );
        }

        // Diagnostic: same for reasoning chunks — proves whether the provider
        // streamed reasoning_content at all (no logs ⇒ the model did not
        // think / enable_thinking was off, not a display bug).
        const thinkingChunk = next.value.find((m) => m.role === "thinking");
        if (thinkingChunk) {
          console.log(
            "[continue] ← chunk with thinking:",
            JSON.stringify(thinkingChunk).slice(0, 200),
          );
        }

        dispatch(inSession(streamUpdate(next.value), owningSessionId));
        // Persist a throttled snapshot so a webview reload mid-stream loses at
        // most one window of generated text (scoped to the owning session).
        throttleChunkSave(owningSessionId, dispatch);
        try {
          next = await readNext();
        } catch (e) {
          if (handleStalledStream(e)) {
            return;
          }
          throw e;
        }
      }

      // Attach prompt log and end thinking for reasoning models
      if (next.done && next.value) {
        // Log the completion size and its tail: if the model hit maxTokens or
        // the provider truncated the stream, the tail stops mid-sentence —
        // that distinguishes "model chose to stop" from "output was cut off"
        // (which explains turns that end right after the model announces its
        // next step but never emits the tool call).
        const completion = next.value.completion ?? "";
        finalCompletion = completion;
        console.log(
          `[continue] ✓ LLM stream #${requestId} finished`,
          `${Date.now() - start}ms`,
          `completionChars=${completion.length}`,
          `tail=${JSON.stringify(completion.slice(-80))}`,
        );

        // Full completion dump (debug): print the ENTIRE model output every
        // turn instead of just the 80-char tail, so the agent loop can be
        // inspected end-to-end — including tool-call arguments, which the tail
        // slice usually cuts off.
        console.log(
          `[continue] ── #${requestId} full completion (${completion.length} chars) ──\n${completion}`,
        );
        const finishedMsg = Array.isArray(next.value)
          ? next.value.find((m: any) => m?.role === "assistant")
          : (next.value as any);
        const toolCallsDump = (finishedMsg as any)?.toolCalls;
        if (toolCallsDump?.length) {
          console.log(
            `[continue] ── tool calls (${toolCallsDump.length}) ──\n` +
              JSON.stringify(toolCallsDump, null, 2),
          );
        }
        dispatch(
          inSession(addPromptCompletionPair([next.value]), owningSessionId),
        );

        try {
          extra.ideMessenger.post("devdata/log", {
            name: "chatInteraction",
            data: {
              prompt: next.value.prompt,
              completion: next.value.completion,
              modelProvider: selectedChatModel.underlyingProviderName,
              modelName: selectedChatModel.title,
              modelTitle: selectedChatModel.title,
              sessionId: owningSessionId,
              ...(!!activeTools.length && {
                tools: activeTools.map((tool) => tool.function.name),
              }),
              ...(appliedRules.length > 0 && {
                rules: appliedRules.map((rule) => ({
                  id: getRuleId(rule),
                  slug: rule.slug,
                })),
              }),
            },
          });
        } catch (e) {
          console.error("Failed to send dev data interaction log", e);
        }
      }
    } catch (e) {
      // Was the request ever answered? `start` → now covers the whole wait.
      console.error(
        "[continue] ✕ LLM request failed",
        `${Date.now() - start}ms`,
        e instanceof Error ? e.message : e,
      );
      const toolCallsToCancel = selectCurrentToolCalls(getState());
      if (
        toolCallsToCancel.length > 0 &&
        e instanceof Error &&
        e.message.toLowerCase().includes("premature close")
      ) {
        for (const tc of toolCallsToCancel) {
          dispatch(
            inSession(
              errorToolCall({
                toolCallId: tc.toolCallId,
                output: [
                  {
                    name: "Tool Call Error",
                    description: "Premature Close",
                    content: `"Premature Close" error: this tool call was aborted mid-stream because the arguments took too long to stream or there were network issues. Please re-attempt by breaking the operation into smaller chunks or trying something else`,
                    icon: "problems",
                  },
                ],
              }),
              owningSessionId,
            ),
          );
        }
      } else {
        throw e;
      }
    }

    // Tool call sequence:
    // 1. Mark generating tool calls as generated
    const state1 = getState();
    if (streamAborter.signal.aborted) {
      return;
    }
    const originalToolCalls = selectCurrentToolCalls(state1);
    const generatingCalls = originalToolCalls.filter(
      (tc) => tc.status === "generating",
    );
    for (const { toolCallId } of generatingCalls) {
      dispatch(
        inSession(
          setToolGenerated({
            toolCallId,
            tools: state1.config.config.tools,
          }),
          owningSessionId,
        ),
      );
    }

    // 2. Pre-process args to catch invalid args before checking policies
    const state2 = getState();
    if (streamAborter.signal.aborted) {
      return;
    }
    const generatedCalls2 = selectPendingToolCalls(state2);
    await preprocessToolCalls(dispatch, extra.ideMessenger, generatedCalls2);

    // 3. Security check: evaluate updated policies based on args
    const state3 = getState();
    if (streamAborter.signal.aborted) {
      return;
    }
    const generatedCalls3 = selectPendingToolCalls(state3);
    const toolPolicies = state3.ui.toolSettings;
    const policies = await evaluateToolPolicies(
      dispatch,
      extra.ideMessenger,
      activeTools,
      generatedCalls3,
      toolPolicies,
    );
    const autoApprovedPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithoutPermission",
    );
    const needsApprovalPolicies = policies.filter(
      ({ policy }) => policy === "allowedWithPermission",
    );

    // 4. Execute remaining tool calls
    if (originalToolCalls.length === 0) {
      // The model returned plain text with no tool call — the turn ends here.
      // Print the full reply so it's auditable (vs. just the tail above),
      // e.g. to confirm whether the reply was truncated mid-sentence (maxTokens)
      // or deliberately ended.
      console.log(
        "[continue] turn ended — no tool calls; full model reply:",
        finalCompletion,
      );
      dispatch(inSession(setInactive(), owningSessionId));
    } else if (needsApprovalPolicies.length > 0) {
      const builtInReadonlyAutoApproved = autoApprovedPolicies.filter(
        ({ toolCallState }) =>
          toolCallState.tool?.group === BUILT_IN_GROUP_NAME &&
          toolCallState.tool?.readonly,
      );

      if (builtInReadonlyAutoApproved.length > 0) {
        if (streamAborter.signal.aborted) {
          return;
        }
        await Promise.all(
          builtInReadonlyAutoApproved.map(async ({ toolCallState }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId: toolCallState.toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                  sessionId: owningSessionId,
                }),
              ),
            );
          }),
        );
      }

      dispatch(inSession(setInactive(), owningSessionId));
    } else {
      // auto stream cases increase thunk depth by 1 for debugging
      const state4 = getState();
      const generatedCalls4 = selectPendingToolCalls(state4);
      if (streamAborter.signal.aborted) {
        return;
      }
      if (generatedCalls4.length > 0) {
        await Promise.all(
          generatedCalls4.map(async ({ toolCallId }) => {
            unwrapResult(
              await dispatch(
                callToolById({
                  toolCallId,
                  isAutoApproved: true,
                  depth: depth + 1,
                  sessionId: owningSessionId,
                }),
              ),
            );
          }),
        );
      } else {
        for (const { toolCallId } of originalToolCalls) {
          unwrapResult(
            await dispatch(
              streamResponseAfterToolCall({
                toolCallId,
                depth: depth + 1,
                sessionId: owningSessionId,
              }),
            ),
          );
        }
      }
    }
  },
);
