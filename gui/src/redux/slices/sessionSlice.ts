import {
  ActionReducerMapBuilder,
  AsyncThunk,
  PayloadAction,
  createSelector,
  createSlice,
} from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/react";
import {
  ApplyState,
  AssistantChatMessage,
  BaseSessionMetadata,
  ChatHistoryItem,
  ChatMessage,
  ContextItem,
  ContextItemWithId,
  FileSymbolMap,
  McpUiState,
  MessageModes,
  PromptLog,
  RuleMetadata,
  Session,
  ThinkingChatMessage,
  Tool,
  ToolCallDelta,
  ToolCallState,
} from "core";
import { mergeReasoningDetails } from "core/llm/openaiTypeConverters";
import { NEW_SESSION_TITLE } from "core/util/constants";
import {
  renderChatMessage,
  renderContextItems,
} from "core/util/messageContent";
import { findUriInDirs, getUriPathBasename } from "core/util/uri";
import { findLastIndex } from "lodash";
import { v4 as uuidv4 } from "uuid";
import { type InlineErrorMessageType } from "../../components/mainInput/InlineErrorMessage";
import { toolCallCtxItemToCtxItemWithId } from "../../pages/gui/ToolCallDiv/utils";
import { addToolCallDeltaToState, isEditTool } from "../../util/toolCallState";
import { RootState } from "../store";
import { streamResponseThunk } from "../thunks/streamResponse";
import { findChatHistoryItemByToolCallId, findToolCallById } from "../util";

/**
 * Helper function to filter out duplicate edit/search-replace tool calls.
 * Only keeps the first occurrence of edit tools.
 *
 * We don't support multiple parallel apply calls - see tool definitions for
 * instructions we provide to models to prevent this behavior.
 */
function filterMultipleEditToolCalls(
  toolCalls: ToolCallDelta[],
): ToolCallDelta[] {
  let hasSeenEditTool = false;

  return toolCalls.filter((toolCall) => {
    if (toolCall.function?.name && isEditTool(toolCall.function?.name)) {
      if (hasSeenEditTool) {
        return false; // Skip this duplicate edit tool
      }
      hasSeenEditTool = true;
    }

    return true;
  });
}

/**
 * Initializes tool call states for a new message containing tool calls.
 * This function is called when we receive a complete message with tool calls,
 * typically in non-streaming scenarios or when processing the first chunk
 * of a streaming message that contains tool calls.
 *
 * @param message - The chat message containing tool calls to process
 * @param lastItem - The chat history item to attach tool call states to
 */
export function handleToolCallsInMessage(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    (message.role === "assistant" || message.role === "thinking") &&
    message.toolCalls?.length
  ) {
    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Initialize tool call states for each filtered tool call in the message
    // Each tool call gets its own state to track generation/execution progress
    lastItem.toolCallStates = filteredToolCalls.map((toolCallDelta) =>
      addToolCallDeltaToState(toolCallDelta, undefined),
    );

    // Update the message's toolCalls array to reflect the processed tool calls
    // We can safely cast because we verified the role above
    const curMessage = lastItem.message as
      | AssistantChatMessage
      | ThinkingChatMessage;
    curMessage.toolCalls = lastItem.toolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

/**
 * Applies a single tool call delta to the tool call states array.
 *
 * This function handles the core logic for OpenAI-style tool call streaming where:
 * - Initial tool calls come with full details (ID, name, arguments)
 * - Subsequent argument fragments come without IDs and need to update the most recent tool call
 * - Multiple parallel tool calls can be streamed simultaneously
 *
 * @param toolCallDelta - The incoming tool call delta from the LLM stream
 * @param toolCallStates - Array of existing tool call states (modified in place)
 */
function applyToolCallDelta(
  toolCallDelta: ToolCallDelta,
  toolCallStates: ToolCallState[],
): void {
  // Find existing state by matching toolCallId - this ensures we update
  // the correct tool call even when multiple tool calls are being streamed
  let existingStateIndex = -1;

  if (toolCallDelta.id) {
    // Tool call has an ID - find by exact match
    // This handles: new tool calls or explicit updates to existing ones
    existingStateIndex = toolCallStates.findIndex(
      (state) => state.toolCallId === toolCallDelta.id,
    );
  } else {
    // No ID in delta (common in OpenAI streaming fragments)
    // Strategy: Update the most recently added tool call that's still being generated
    // This handles the pattern: initial tool call with ID, then fragments without ID
    existingStateIndex = toolCallStates.length - 1;

    // Ensure we have at least one tool call to update
    if (existingStateIndex < 0) {
      existingStateIndex = -1; // Will create new tool call
    }
  }

  const existingState =
    existingStateIndex >= 0 ? toolCallStates[existingStateIndex] : undefined;

  // Apply the delta to create an updated state (either updating existing or creating new)
  const updatedState = addToolCallDeltaToState(toolCallDelta, existingState);

  if (existingStateIndex >= 0) {
    // Update existing tool call state in place
    toolCallStates[existingStateIndex] = updatedState;
  } else {
    // Add new tool call state for a newly discovered tool call
    toolCallStates.push(updatedState);
  }
}

/**
 * Handles incremental updates to tool calls during streaming responses.
 * This function processes streaming deltas for tool calls, updating existing
 * tool call states or creating new ones as needed. It uses ID-based matching
 * to ensure tool call updates are applied to the correct tool call state.
 *
 * @param message - The streaming message chunk containing tool call deltas
 * @param lastItem - The chat history item containing existing tool call states
 */
export function handleStreamingToolCallUpdates(
  message: ChatMessage,
  lastItem: ChatHistoryItemWithMessageId,
): void {
  if (
    message.role === "assistant" &&
    message.toolCalls?.length &&
    lastItem.message.role === "assistant"
  ) {
    // Start with existing tool call states or empty array if none exist
    const existingToolCallStates = lastItem.toolCallStates || [];
    const updatedToolCallStates: ToolCallState[] = [...existingToolCallStates];

    // Filter out duplicate edit/search-replace tool calls - only keep the first one
    const filteredToolCalls = filterMultipleEditToolCalls(message.toolCalls);

    // Process each filtered tool call delta, matching by ID to update the correct state
    filteredToolCalls.forEach((toolCallDelta) => {
      applyToolCallDelta(toolCallDelta, updatedToolCallStates);
    });

    // Replace the entire tool call states array with the updated version
    lastItem.toolCallStates = updatedToolCallStates;

    // Update the message's toolCalls array to reflect current tool call states
    (lastItem.message as any).toolCalls = updatedToolCallStates.map(
      (state) => state.toolCall,
    );
  }
}

// We need this to handle reorderings (e.g. a mid-array deletion) of the messages array.
// The proper fix is adding a UUID to all chat messages, but this is the temp workaround.
export type ChatHistoryItemWithMessageId = ChatHistoryItem & {
  message: ChatMessage & { id: string };
  /** Wall-clock duration of the turn that produced this item, in ms. */
  turnElapsedMs?: number;
};

/**
 * Per-session state. Nearly every field is private to one chat session.
 * `isSessionMetadataLoading`/`allSessionMetadata` are duplicated here only so
 * the legacy inner reducers (which the wrapper still calls unchanged) have a
 * place to write; the authoritative copies live at the top level and are
 * synced by `sessionReducer`.
 */
export type SessionData = {
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
  lastSessionId?: string;
  history: ChatHistoryItemWithMessageId[];
  isStreaming: boolean;
  /**
   * True while an asynchronous follow-up (e.g. the edit/apply stream) owns the
   * turn's continuation but has not yet dispatched it. The streamThunkWrapper
   * `finally` block must NOT end the turn (dispatch setInactive) while this is
   * set — otherwise the pending continuation is aborted mid-flight
   * ("aborted by session state"). Cleared the moment the continuation is
   * dispatched (see streamResponseAfterToolCall).
   */
  pendingContinuation: boolean;
  /** Start timestamp of the current turn, used for the footer elapsed time. */
  turnStartedAt?: number;
  title: string;
  id: string;
  /** Legacy single-slot aborter. Kept for backward compatibility; new streams
   *  use `streamAborters[sessionId]` so terminating one chat never cancels a
   *  background turn in another. */
  streamAborter: AbortController;
  /** Per-session stream aborters. Keyed by the session id captured at stream
   *  entry, so "Stop" in session B cannot abort a running stream in session A. */
  streamAborters: Record<string, AbortController>;
  mainEditorContentTrigger?: JSONContent | undefined;
  symbols: FileSymbolMap;
  mode: MessageModes;
  isInEdit: boolean;
  codeBlockApplyStates: {
    states: ApplyState[];
    curIndex: number;
  };
  newestToolbarPreviewForInput: Record<string, string>;
  hasReasoningEnabled?: boolean;
  isPruned?: boolean;
  contextPercentage?: number;
  inlineErrorMessage?: InlineErrorMessageType;
  compactionLoading: Record<number, boolean>; // Track compaction loading by message index
};

export function createSessionData(id?: string): SessionData {
  return {
    isSessionMetadataLoading: false,
    allSessionMetadata: [],
    history: [],
    isStreaming: false,
    pendingContinuation: false,
    title: NEW_SESSION_TITLE,
    id: id ?? uuidv4(),
    streamAborter: new AbortController(),
    streamAborters: {},
    symbols: {},
    mode: "agent",
    isInEdit: false,
    codeBlockApplyStates: { states: [], curIndex: 0 },
    lastSessionId: undefined,
    newestToolbarPreviewForInput: {},
    compactionLoading: {},
  };
}

/**
 * Top-level session slice state. `sessions` is the authoritative store of all
 * chat sessions; `activeSessionId` is the one currently rendered. Global UI
 * (session list metadata) lives here, not in any one session.
 */
export type SessionState = {
  sessions: Record<string, SessionData>;
  activeSessionId: string;
  isSessionMetadataLoading: boolean;
  allSessionMetadata: BaseSessionMetadata[];
};

const INITIAL_ACTIVE_ID = uuidv4();
export const INITIAL_SESSION_STATE: SessionState = {
  sessions: { [INITIAL_ACTIVE_ID]: createSessionData(INITIAL_ACTIVE_ID) },
  activeSessionId: INITIAL_ACTIVE_ID,
  isSessionMetadataLoading: false,
  allSessionMetadata: [],
};

/**
 * The inner slice still operates on a single flat SessionData so its 40+
 * reducers remain unchanged. The exported reducer below wraps it with the
 * multi-session `sessions` map (see `sessionReducer` at the file end).
 */
const INITIAL_SESSION_DATA = createSessionData();

export const sessionSlice = createSlice({
  name: "session",
  initialState: INITIAL_SESSION_DATA,
  reducers: {
    addPromptCompletionPair: (
      state,
      { payload }: PayloadAction<PromptLog[]>,
    ) => {
      if (!state.history.length) {
        return;
      }

      const lastMessage = state.history[state.history.length - 1];

      lastMessage.promptLogs = lastMessage.promptLogs
        ? lastMessage.promptLogs.concat(payload)
        : payload;

      // Inactive thinking for reasoning models when '</think>' tag is not received on request completion
      if (lastMessage.reasoning?.active) {
        lastMessage.reasoning.active = false;
        lastMessage.reasoning.endAt = Date.now();
      }
    },
    setActive: (state) => {
      state.isStreaming = true;
      if (state.turnStartedAt == null) {
        state.turnStartedAt = Date.now();
      }
    },
    setPendingContinuation: (state, action: PayloadAction<boolean>) => {
      state.pendingContinuation = action.payload;
    },
    setIsGatheringContext: (state, { payload }: PayloadAction<boolean>) => {
      const curMessage = state.history.at(-1);
      if (curMessage) {
        curMessage.isGatheringContext = payload;
      }
    },
    clearDanglingMessages: (state) => {
      // This is used during cancellation
      // After the last user or tool message, we can have thinking and or valid assitant message (content or generated tool calls) OR nothing.
      // The only thing allowed after the last assistant message that has either content or generated tool calls
      // is a user or tool message
      if (state.history.length < 2) {
        return;
      }

      const lastUserOrToolIdx = findLastIndex(
        state.history,
        (item) => item.message.role === "tool" || item.message.role === "user",
      );

      let validAssistantMessageIdx = -1;
      for (let i = state.history.length - 1; i > lastUserOrToolIdx; i--) {
        const message = state.history[i];
        const hasGeneratedMsg = message.toolCallStates?.some(
          (toolCallState) => toolCallState.status !== "generating",
        );
        if (message.message.content || hasGeneratedMsg) {
          validAssistantMessageIdx = i;
          // Cancel any tool calls that are dangling and generated
          if (message.toolCallStates) {
            message.toolCallStates.forEach((toolCallState) => {
              if (
                toolCallState.status === "generated" ||
                toolCallState.status === "generating"
              ) {
                toolCallState.status = "canceled";
              }
            });
          }
          break;
        }
      }

      if (validAssistantMessageIdx === -1) {
        const lastMsg = state.history[lastUserOrToolIdx];
        const lastRole = lastMsg.message.role as "user" | "tool";
        if (lastRole === "user") {
          state.mainEditorContentTrigger = lastMsg.editorState;
          state.history = state.history.slice(0, lastUserOrToolIdx);
        } else {
          state.history = state.history.slice(0, lastUserOrToolIdx + 1);
        }
      } else {
        state.history = state.history.slice(0, validAssistantMessageIdx + 1);
      }
    },
    // Trigger value picked up by editor with isMainInput to set its content
    setMainEditorContentTrigger: (
      state,
      action: PayloadAction<JSONContent | undefined>,
    ) => {
      state.mainEditorContentTrigger = action.payload;
    },
    updateFileSymbols: (state, action: PayloadAction<FileSymbolMap>) => {
      state.symbols = {
        ...state.symbols,
        ...action.payload,
      };
    },
    setContextItemsAtIndex: (
      state,
      {
        payload: { index, contextItems },
      }: PayloadAction<{
        index: number;
        contextItems: ChatHistoryItem["contextItems"];
      }>,
    ) => {
      if (state.history[index]) {
        state.history[index].contextItems = contextItems;
      }
    },
    submitEditorAndInitAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        editorState: JSONContent;
      }>,
    ) => {
      const { index, editorState } = payload;

      // A new user message starts a new turn.
      state.turnStartedAt = undefined;

      if (state.history.length && index < state.history.length) {
        // Resubmission - update input message, truncate history after resubmit with new empty response message
        if (index % 2 === 1) {
          console.warn(
            "Corrupted history: resubmitting at odd index, shouldn't happen",
          );
        }
        const historyItem = state.history[index];

        historyItem.message.content = ""; // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
        historyItem.editorState = payload.editorState;
        historyItem.contextItems = [];

        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
      } else {
        // New input/response messages
        state.history = state.history.concat([
          {
            message: {
              id: uuidv4(),
              role: "user",
              content: "", // IMPORTANT - this is quickly updated by resolveEditorContent based on editor state prior to streaming
            },
            contextItems: [],
            editorState,
          },
          {
            message: {
              id: uuidv4(),
              role: "assistant",
              content: "", // IMPORTANT - this is subsequently updated by response streaming
            },
            contextItems: [],
          },
        ]);
      }

      state.isStreaming = true;
    },
    truncateHistoryToMessage: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
      }>,
    ) => {
      const { index } = payload;

      if (state.history.length && index < state.history.length) {
        state.codeBlockApplyStates.curIndex = 0;
        state.history = state.history.slice(0, index + 1).concat({
          message: {
            id: uuidv4(),
            role: "assistant",
            content: "", // IMPORTANT - this is subsequently updated by response streaming
          },
          contextItems: [],
        });
        state.inlineErrorMessage = undefined;
        state.isPruned = false;
        state.contextPercentage = undefined;
      }
    },
    deleteMessage: (state, action: PayloadAction<number>) => {
      // Deletes the current assistant message and the previous user message
      state.history.splice(action.payload - 1, 2);
      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
    },
    deleteCompaction: (state, action: PayloadAction<number>) => {
      // Removes the conversation summary from the specified message
      const historyItem = state.history[action.payload];
      if (historyItem?.conversationSummary) {
        state.history[action.payload] = {
          ...historyItem,
          conversationSummary: undefined,
        };
      }
    },
    updateHistoryItemAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        updates: Partial<ChatHistoryItemWithMessageId>;
      }>,
    ) => {
      const { index, updates } = payload;
      if (index !== 0 && !state.history[index]) {
        console.error(
          `attempting to update history item at nonexistent index ${index}`,
          updates,
        );
        return;
      }
      state.history[index] = {
        ...state.history[index],
        ...updates,
      };
    },
    addContextItemsAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        contextItems: ContextItemWithId[];
      }>,
    ) => {
      const historyItem = state.history[payload.index];

      if (!historyItem) {
        return;
      }

      historyItem.contextItems = [
        ...historyItem.contextItems,
        ...payload.contextItems,
      ];
    },
    setAppliedRulesAtIndex: (
      state,
      {
        payload,
      }: PayloadAction<{
        index: number;
        appliedRules: RuleMetadata[];
      }>,
    ) => {
      if (state.history[payload.index]) {
        state.history[payload.index].appliedRules = payload.appliedRules;
      }
    },
    setInactive: (state) => {
      const curMessage = state.history.at(-1);

      if (curMessage) {
        curMessage.isGatheringContext = false;
      }

      // Record the wall-clock duration of this turn on its final assistant
      // item, so the message footer can show "Elapsed time" and it persists
      // with the saved session.
      if (state.turnStartedAt != null) {
        const lastAssistant = [...state.history]
          .reverse()
          .find((item) => item.message.role === "assistant");
        if (lastAssistant) {
          lastAssistant.turnElapsedMs = Date.now() - state.turnStartedAt;
        }
      }

      state.isStreaming = false;
    },
    /**
     * Ensure a per-session aborter exists. Called at stream entry with the
     * owning session id; repeated calls are idempotent. The stream captures
     * `selectActiveSession(state).streamAborters[id]` so its lifetime is tied to that
     * session, not to whichever chat is currently displayed.
     */
    ensureSessionAborter: (state, { payload }: PayloadAction<string>) => {
      if (!state.streamAborters) {
        state.streamAborters = {};
      }
      if (!state.streamAborters[payload]) {
        state.streamAborters[payload] = new AbortController();
      }
    },
    /**
     * Abort one session's stream. With a `sessionId`, only that session's
     * aborter is signalled (Stop in B never kills a background turn in A).
     * With no id, fall back to the legacy single-slot aborter.
     */
    abortStream: (state, { payload }: PayloadAction<string | undefined>) => {
      if (payload) {
        // Targeted cancel: signal only the named session's controller. If no
        // controller was registered (stream never started / already cleaned
        // up), do nothing — NEVER fall through to the legacy slot, which would
        // spuriously abort an unrelated active stream.
        if (state.streamAborters?.[payload]) {
          state.streamAborters[payload].abort();
          state.streamAborters[payload] = new AbortController();
        }
        return;
      }
      // No id (legacy callers only): abort the single global slot.
      state.streamAborter.abort();
      state.streamAborter = new AbortController();
    },
    streamUpdate: (state, action: PayloadAction<ChatMessage[]>) => {
      if (state.history.length) {
        for (const message of action.payload) {
          let lastItem = state.history[state.history.length - 1];
          let lastMessage = lastItem.message;

          if (message.role === "thinking" && message.redactedThinking) {
            state.history.push({
              message: {
                role: "thinking",
                content: "internal reasoning is hidden due to safety reasons",
                redactedThinking: message.redactedThinking,
                id: uuidv4(),
              },
              contextItems: [],
            });
            continue;
          }

          const messageContent = message.content
            ? renderChatMessage(message)
            : "";

          // DeepAgent mirrors tools it already executed inside the agent run
          // as `role: "tool"` + `metadata.deepAgentTool`. Fold the result into
          // the EXISTING toolCallState (Kiro's toolCallUpdate semantics) and
          // skip the generic tool history item — creating a second item is
          // what makes the answered card appear to jump.
          if (
            message.role === "tool" &&
            message.metadata?.deepAgentTool &&
            message.toolCallId
          ) {
            const toolCallState = findToolCallById(
              state.history,
              message.toolCallId,
            );
            if (toolCallState) {
              toolCallState.status = "done";
              toolCallState.output = [
                {
                  name: toolCallState.toolCall.function.name,
                  description: "Tool result",
                  content: messageContent,
                  hidden: false,
                },
              ];
            }
            continue;
          }

          // OpenAI-compatible models in agent mode sometimes send
          // all of their data in one message, so we handle that case early.
          if (messageContent && message.role !== "tool") {
            const thinkMatches = messageContent.match(
              /<think>([\s\S]*)<\/think>([\s\S]*)/,
            );
            if (thinkMatches) {
              // The order that they seem to consistently use is:
              //
              // <think>Thinking text</think>
              // Text to show to the user

              lastItem.reasoning = {
                text: thinkMatches[1].trim(),
                startAt: Date.now(),
                endAt: Date.now(),
                active: false,
              };

              // This is the chat message that we should show to the user.
              // We always need to push this even if it is empty,
              // because we cannot attach tool calls to a Thinking message.
              // That would break `messageHasToolCallId`.
              state.history.push({
                message: {
                  role: "assistant",
                  content: thinkMatches[2].trim(),
                  id: uuidv4(),
                },
                contextItems: [],
              });
              lastItem = state.history[state.history.length - 1];
              lastMessage = lastItem.message;

              handleToolCallsInMessage(message, lastItem);

              return;
            }
          }

          // The remainder of this function handles streaming messages
          if (
            lastMessage.role !== message.role ||
            message.role === "tool" // Tool messages should always create new messages
          ) {
            // Create a new message
            const historyItem: ChatHistoryItemWithMessageId = {
              message: {
                ...message,
                content: "", // Start with empty content, let accumulation logic handle it
                id: uuidv4(),
              },
              contextItems: [],
            };
            state.history.push(historyItem);
            lastItem = state.history[state.history.length - 1];
            lastMessage = lastItem.message;
          }

          // Add to the existing message
          if (messageContent) {
            if (messageContent.includes("<think>") && message.role !== "tool") {
              lastItem.reasoning = {
                startAt: Date.now(),
                active: true,
                text: messageContent.replace("<think>", "").trim(),
              };
            } else if (
              lastItem.reasoning?.active &&
              messageContent.includes("</think>")
            ) {
              const [reasoningEnd, answerStart] =
                messageContent.split("</think>");
              lastItem.reasoning.text += reasoningEnd.trimEnd();
              lastItem.reasoning.active = false;
              lastItem.reasoning.endAt = Date.now();
              lastMessage.content += answerStart.trimStart();
            } else if (lastItem.reasoning?.active) {
              if (
                lastItem.reasoning.text.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastItem.reasoning.text += messageContent;
              }
            } else {
              // Note this only works because new message above
              // was already rendered from parts to string
              if (
                lastMessage.content.length > 0 ||
                messageContent.trim().length > 0
              ) {
                lastMessage.content += messageContent;
              }
            }
          } else if (message.role === "thinking" && message.signature) {
            if (lastMessage.role === "thinking") {
              lastMessage.signature = message.signature;
            }
          }
          // Tool call handling is intentionally independent of the content
          // branch above: some providers send a single streaming chunk with
          // BOTH text and tool calls. Gating this behind `else if
          // (messageContent)` silently dropped tool calls on such chunks
          // (provider reported finish_reason "tool_calls", GUI saw none).
          if (
            message.role === "assistant" &&
            message.toolCalls?.length &&
            lastMessage.role === "assistant"
          ) {
            handleStreamingToolCallUpdates(message, lastItem);
          }

          // Attach Responses API output item id to the current assistant message if present
          // fromResponsesChunk sets message.metadata.responsesOutputItemId when it sees output_item.added for messages
          if (
            message.role === "assistant" &&
            lastMessage.role === "assistant" &&
            message.metadata?.responsesOutputItemId
          ) {
            lastMessage.metadata = lastMessage.metadata || {};
            // Accumulate fc_ IDs for parallel tool calls (OpenAI Responses API)
            if (!lastMessage.metadata.responsesOutputItemIds) {
              lastMessage.metadata.responsesOutputItemIds = [];
            }
            (lastMessage.metadata.responsesOutputItemIds as string[]).push(
              message.metadata.responsesOutputItemId as string,
            );
            // Also keep singular for backwards compatibility
            lastMessage.metadata.responsesOutputItemId = message.metadata
              .responsesOutputItemId as string;
          }

          if (
            message.role === "thinking" &&
            message.reasoning_details &&
            lastMessage.role === "thinking"
          ) {
            lastMessage.reasoning_details = mergeReasoningDetails(
              lastMessage.reasoning_details,
              message.reasoning_details,
            );
          }
        }
      }
    },
    newSession: (state, { payload }: PayloadAction<Session | undefined>) => {
      state.lastSessionId = state.id;

      // NOTE: do NOT abort a stream here. `newSession` fires on tab switches
      // and session loads; aborting here used to kill the background stream of
      // the chat we are leaving behind. Stream lifetime is now owned per-session
      // via `streamAborters[id]` and ended explicitly by `cancelStream(sessionId)`.
      state.isStreaming = false;
      state.symbols = {};

      state.inlineErrorMessage = undefined;
      state.isPruned = false;
      state.contextPercentage = undefined;
      state.turnStartedAt = undefined;

      if (payload) {
        state.history = payload.history as any;
        state.title = payload.title;
        state.id = payload.sessionId;
        if (payload.mode) {
          state.mode = payload.mode;
        }
      } else {
        state.history = [];
        state.title = NEW_SESSION_TITLE;
        state.id = uuidv4();
      }
    },
    updateSessionTitle: (state, { payload }: PayloadAction<string>) => {
      state.title = payload;
    },
    setIsSessionMetadataLoading: (
      state,
      { payload }: PayloadAction<boolean>,
    ) => {
      state.isSessionMetadataLoading = payload;
    },
    setAllSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata[]>,
    ) => {
      state.allSessionMetadata = payload;
    },
    //////////////////////////////////////////////////////////////////////////////////
    // These are for optimistic session metadata updates, especially for History page
    addSessionMetadata: (
      state,
      { payload }: PayloadAction<BaseSessionMetadata>,
    ) => {
      state.allSessionMetadata = [...state.allSessionMetadata, payload];
    },
    updateSessionMetadata: (
      state,
      {
        payload,
      }: PayloadAction<
        {
          sessionId: string;
        } & Partial<BaseSessionMetadata>
      >,
    ) => {
      state.allSessionMetadata = state.allSessionMetadata.map((session) =>
        session.sessionId === payload.sessionId
          ? {
              ...session,
              ...payload,
            }
          : session,
      );
      if (payload.title && payload.sessionId === state.id) {
        state.title = payload.title;
      }
    },
    deleteSessionMetadata: (state, { payload }: PayloadAction<string>) => {
      // Note, should not be allowed to delete current session from chat session
      state.allSessionMetadata = state.allSessionMetadata.filter(
        (session) => session.sessionId !== payload,
      );
    },
    //////////////////////////////////////////////////////////////////////////////////
    addHighlightedCode: (
      state,
      {
        payload,
      }: PayloadAction<{ rangeInFileWithContents: any; edit: boolean }>,
    ) => {
      let contextItems =
        state.history[state.history.length - 1].contextItems ?? [];

      contextItems = contextItems.map((item) => {
        return { ...item, editing: false };
      });

      const { relativePathOrBasename } = findUriInDirs(
        payload.rangeInFileWithContents.filepath,
        window.workspacePaths ?? [],
      );
      const fileName = getUriPathBasename(
        payload.rangeInFileWithContents.filepath,
      );

      const lineNums = `(${
        payload.rangeInFileWithContents.range.start.line + 1
      }-${payload.rangeInFileWithContents.range.end.line + 1})`;

      contextItems.push({
        name: `${fileName} ${lineNums}`,
        description: relativePathOrBasename,
        id: {
          providerTitle: "code",
          itemId: uuidv4(),
        },
        content: payload.rangeInFileWithContents.contents,
        editing: true,
        editable: true,
        uri: {
          type: "file",
          value: payload.rangeInFileWithContents.filepath,
        },
      });

      state.history[state.history.length - 1].contextItems = contextItems;
    },
    updateApplyState: (state, { payload }: PayloadAction<ApplyState>) => {
      const applyState = state.codeBlockApplyStates.states.find(
        (state) => state.streamId === payload.streamId,
      );

      if (!applyState) {
        // Tag the apply state with the session it was created in, so pending
        // accept/reject cards only surface in their owning session.
        state.codeBlockApplyStates.states.push({
          ...payload,
          sessionId: state.id,
        });
      } else {
        applyState.status = payload.status ?? applyState.status;
        // Persist the owning tool call id: the "streaming" update carries no
        // toolCallId, and dropping the id from later updates (done/closed)
        // broke both the closed-event recovery in handleApplyStateUpdate and
        // the per-tool policy filter for confirmation cards.
        applyState.toolCallId = payload.toolCallId ?? applyState.toolCallId;
        applyState.numDiffs = payload.numDiffs ?? applyState.numDiffs;
        applyState.filepath = payload.filepath ?? applyState.filepath;
        applyState.fileContent = payload.fileContent ?? applyState.fileContent;
        applyState.originalFileContent =
          payload.originalFileContent ?? applyState.originalFileContent;
      }

      if (payload.status === "done") {
        state.codeBlockApplyStates.curIndex++;
      }
    },
    resetNextCodeBlockToApplyIndex: (state) => {
      state.codeBlockApplyStates.curIndex = 0;
    },

    // TOOL CALL STATE
    setToolGenerated: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        tools: Tool[];
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );

      if (toolCallState) {
        toolCallState.status = "generated";

        const tool = action.payload.tools.find(
          (t) => t.function.name === toolCallState.toolCall.function.name,
        );
        if (tool) {
          toolCallState.tool = tool;
        }
      }
    },
    updateToolCallOutput: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        contextItems: ContextItem[];
        mcpUiState?: McpUiState;
      }>,
    ) => {
      // Update tool call state and corresponding tool output message
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.output = action.payload.contextItems;
        toolCallState.mcpUiState = action.payload.mcpUiState;
      }
      const toolItem = findChatHistoryItemByToolCallId(
        state.history,
        action.payload.toolCallId,
      );
      if (toolItem) {
        toolItem.message.content = renderContextItems(
          action.payload.contextItems,
        );
        toolItem.contextItems = action.payload.contextItems.map((item) =>
          toolCallCtxItemToCtxItemWithId(item, action.payload.toolCallId),
        );
      }
    },
    setProcessedToolCallArgs: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        newArgs: Record<string, any>;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.processedArgs = action.payload.newArgs;
      }
    },
    cancelToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "canceled";
      }
    },
    errorToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
        output?: ContextItem[]; // optional for convenience
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "errored";
        if (action.payload.output) {
          toolCallState.output = action.payload.output;
        }
      }
    },
    acceptToolCall: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "done";
      }
    },
    setToolCallCalling: (
      state,
      action: PayloadAction<{
        toolCallId: string;
      }>,
    ) => {
      const toolCallState = findToolCallById(
        state.history,
        action.payload.toolCallId,
      );
      if (toolCallState) {
        toolCallState.status = "calling";
      }
    },
    setMode: (state, action: PayloadAction<MessageModes>) => {
      state.mode = action.payload;
    },
    setIsInEdit: (state, action: PayloadAction<boolean>) => {
      state.isInEdit = action.payload;
    },
    setHasReasoningEnabled: (state, action: PayloadAction<boolean>) => {
      state.hasReasoningEnabled = action.payload;
    },
    setNewestToolbarPreviewForInput: (
      state,
      {
        payload,
      }: PayloadAction<{
        inputId: string;
        contextItemId: string;
      }>,
    ) => {
      state.newestToolbarPreviewForInput[payload.inputId] =
        payload.contextItemId;
    },
    setCompactionLoading: (
      state,
      action: PayloadAction<{ index: number; loading: boolean }>,
    ) => {
      const { index, loading } = action.payload;
      if (loading) {
        state.compactionLoading[index] = true;
      } else {
        delete state.compactionLoading[index];
      }
    },
    setInlineErrorMessage: (
      state,
      action: PayloadAction<SessionData["inlineErrorMessage"]>,
    ) => {
      state.inlineErrorMessage = action.payload;
    },
    setIsPruned: (state, action: PayloadAction<boolean>) => {
      state.isPruned = action.payload;
    },
    setContextPercentage: (state, action: PayloadAction<number>) => {
      state.contextPercentage = action.payload;
    },
  },
  selectors: {
    selectIsGatheringContext: (state) => {
      const curHistoryItem = state.history.at(-1);
      return curHistoryItem?.isGatheringContext || false;
    },
  },
  extraReducers: (builder) => {
    addPassthroughCases(builder, [streamResponseThunk]);
  },
});

function addPassthroughCases(
  builder: ActionReducerMapBuilder<SessionData>,
  thunks: AsyncThunk<any, any, any>[],
) {
  thunks.forEach((thunk) => {
    builder
      .addCase(thunk.fulfilled, (_state, _action) => {})
      .addCase(thunk.rejected, (_state, _action) => {})
      .addCase(thunk.pending, (_state, _action) => {});
  });
}

/**
 * Stamp a session action with the owning session id so `sessionReducer`
 * applies it to the correct session even when that session is in the
 * background. Used by streaming thunks; plain UI dispatches need no stamp
 * (they fall back to the active session).
 */
export function inSession<T extends { type: string }>(
  action: T,
  sessionId: string,
): T & { meta: { sessionId: string } } {
  return { ...action, meta: { ...((action as any).meta ?? {}), sessionId } };
}

/** The currently rendered session. All UI that used to read `state.session`
 *  now reads through this selector (or `selectSessionById`). */
export const selectActiveSession = (state: RootState): SessionData => {
  const id = state.session.activeSessionId;
  return state.session.sessions[id] ?? createSessionData(id);
};

export const selectSessionById = (state: RootState, id: string): SessionData =>
  state.session.sessions[id] ?? createSessionData(id);

export const selectApplyStateByStreamId = createSelector(
  [
    (state: RootState) =>
      selectActiveSession(state).codeBlockApplyStates.states,
    (_state: RootState, streamId?: string) => streamId,
  ],
  (states, streamId) => {
    return states.find((state) => state.streamId === streamId);
  },
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (state: RootState) =>
      selectActiveSession(state).codeBlockApplyStates.states,
    (_state: RootState, toolCallId?: string) => toolCallId,
  ],
  (states, toolCallId) => {
    if (toolCallId) {
      return states.find((state) => state.toolCallId === toolCallId);
    }
  },
);

export const {
  updateFileSymbols,
  setContextItemsAtIndex,
  addContextItemsAtIndex,
  setAppliedRulesAtIndex,
  setInactive,
  streamUpdate,
  newSession,
  updateSessionTitle,
  addHighlightedCode,
  addPromptCompletionPair,
  setActive,
  submitEditorAndInitAtIndex,
  truncateHistoryToMessage,
  updateHistoryItemAtIndex,
  clearDanglingMessages,
  setMainEditorContentTrigger,
  deleteMessage,
  deleteCompaction,
  setIsGatheringContext,
  resetNextCodeBlockToApplyIndex,
  updateApplyState,
  abortStream,
  ensureSessionAborter,
  setToolCallCalling,
  cancelToolCall,
  errorToolCall,
  acceptToolCall,
  setToolGenerated,
  updateToolCallOutput,
  setProcessedToolCallArgs,
  setMode,
  setIsSessionMetadataLoading,
  setAllSessionMetadata,
  addSessionMetadata,
  updateSessionMetadata,
  deleteSessionMetadata,
  setNewestToolbarPreviewForInput,
  setIsInEdit,
  setHasReasoningEnabled,
  setInlineErrorMessage,
  setIsPruned,
  setContextPercentage,
  setCompactionLoading,
  setPendingContinuation,
} = sessionSlice.actions;

// Re-defined against the multi-session RootState (the inner slice's generated
// selector expects a flat SessionData and is not compatible with the wrapper).
export const selectIsGatheringContext = (
  state: RootState,
): boolean | undefined =>
  selectActiveSession(state).history.at(-1)?.isGatheringContext;

/**
 * Multi-session wrapper around the flat inner slice.
 *
 * Every session action is applied to `sessions[targetId]`, where `targetId`
 * comes from `action.meta.sessionId` (injected by streaming thunks) and falls
 * back to `activeSessionId`. This is the crux of front-end isolation: a chunk
 * from a background session lands in that session's own `history`, never in
 * the currently displayed one.
 */
const innerReducer = sessionSlice.reducer;

// `ensureSessionAborter(id)` and `abortStream(id)` carry the TARGET session id
// in their payload (not via `inSession`). Route them to `sessions[id]` so the
// aborter that a stream captured is the very one a later Stop signals — even
// after the user switched to a different active session.
const SESSION_ID_PAYLOAD_ACTIONS = new Set([
  sessionSlice.actions.ensureSessionAborter.type,
  sessionSlice.actions.abortStream.type,
]);

const GLOBAL_METADATA_ACTIONS = new Set([
  sessionSlice.actions.setIsSessionMetadataLoading.type,
  sessionSlice.actions.setAllSessionMetadata.type,
  sessionSlice.actions.addSessionMetadata.type,
  sessionSlice.actions.deleteSessionMetadata.type,
]);

export const sessionReducer = (
  state: SessionState = INITIAL_SESSION_STATE,
  action: any,
): SessionState => {
  // `newSession` switches the active session. Let the inner reducer build the
  // new SessionData, then register it as active.
  if (action.type === sessionSlice.actions.newSession.type) {
    const payloadId = (action.payload as Session | undefined)?.sessionId;
    const existing = payloadId ? state.sessions[payloadId] : undefined;
    if (existing) {
      // Switching back to an already-known session: activate its OWN state.
      // Deriving from the current session would overwrite the target's
      // isStreaming / streamAborters / applyStates with the leaving chat's
      // leftovers (killing its background stream and leaking approval cards).
      return { ...state, activeSessionId: payloadId };
    }
    const current =
      state.sessions[state.activeSessionId] ?? createSessionData();
    const nextData = innerReducer(current, action);
    const newId = nextData.id;
    return {
      ...state,
      sessions: { ...state.sessions, [newId]: nextData },
      activeSessionId: newId,
      isSessionMetadataLoading: nextData.isSessionMetadataLoading,
      allSessionMetadata: nextData.allSessionMetadata,
    };
  }

  // updateSessionMetadata touches BOTH global metadata and the active session
  // title — apply to a copy of the active session then sync globals back.
  if (action.type === sessionSlice.actions.updateSessionMetadata.type) {
    const current =
      state.sessions[state.activeSessionId] ?? createSessionData();
    const nextData = innerReducer(current, action);
    return {
      ...state,
      sessions: { ...state.sessions, [state.activeSessionId]: nextData },
      isSessionMetadataLoading: nextData.isSessionMetadataLoading,
      allSessionMetadata: nextData.allSessionMetadata,
    };
  }

  // Pure global metadata actions: mirror into the active session so the inner
  // reducer can still handle them, then sync back to the top level.
  if (GLOBAL_METADATA_ACTIONS.has(action.type)) {
    const current =
      state.sessions[state.activeSessionId] ?? createSessionData();
    const nextData = innerReducer(current, action);
    return {
      ...state,
      isSessionMetadataLoading: nextData.isSessionMetadataLoading,
      allSessionMetadata: nextData.allSessionMetadata,
      sessions: { ...state.sessions, [state.activeSessionId]: nextData },
    };
  }

  // For aborter actions, the payload IS the target session id — route there so
  // Stop can reach a background session's captured controller. Otherwise use
  // `meta.sessionId` (from `inSession`) or fall back to the active session.
  const targetId: string = SESSION_ID_PAYLOAD_ACTIONS.has(action.type)
    ? (action.payload as string) || state.activeSessionId
    : action?.meta?.sessionId || state.activeSessionId;
  const target = state.sessions[targetId] ?? createSessionData(targetId);
  const nextData = innerReducer(target, action);
  if (nextData === target) return state;
  return {
    ...state,
    sessions: { ...state.sessions, [targetId]: nextData },
  };
};

export default sessionReducer;
