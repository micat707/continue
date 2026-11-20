import {
  inSession,
  selectActiveSession,
  selectSessionById,
} from "../slices/sessionSlice";
import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ChatMessage } from "core";
import { renderContextItems } from "core/util/messageContent";
import {
  ChatHistoryItemWithMessageId,
  resetNextCodeBlockToApplyIndex,
  setPendingContinuation,
  streamUpdate,
} from "../slices/sessionSlice";
import { findAllCurToolCalls } from "../util";
import { ThunkApiType } from "../store";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";

/**
 * Determines if we should continue streaming based on tool call completion status.
 */
function areAllToolsDoneStreaming(
  assistantMessage: ChatHistoryItemWithMessageId,
  continueAfterToolRejection: boolean | undefined,
): boolean {
  // This might occur because of race conditions, if so, the tools are completed
  if (!assistantMessage.toolCallStates) {
    return true;
  }

  // Only continue if all tool calls are complete
  const completedToolCalls = assistantMessage.toolCallStates.filter(
    (tc) =>
      tc.status === "done" ||
      tc.status === "errored" ||
      (continueAfterToolRejection && tc.status === "canceled"),
  );

  return completedToolCalls.length === assistantMessage.toolCallStates.length;
}

// Continuation dispatch topology and the two bugs it must avoid:
//
// 1. DOUBLE CONTINUATION. Multiple independent code paths dispatch this thunk
//    for the SAME logical continuation (the tool-call path per sibling tool
//    call, plus the apply-finished fire-and-forget path). The dedupe key is
//    the SORTED SET of all sibling toolCallIds in the owning assistant
//    message; it is computed AND registered synchronously (before any await)
//    so no two dispatches can slip through the pre-stream window.
//
// 2. MID-TURN setInactive (the "LLM stream aborted by session state" killer).
//    For PARALLEL tool calls, the FIRST sibling to finish sees the others
//    still running and must NOT continue. That early return must stay OUT of
//    streamThunkWrapper: its finally block treats any exit with
//    session.isStreaming === true as "turn ended" and dispatches setInactive()
//    — which, mid-turn, kicks the session inactive and kills the REAL
//    continuation dispatched by the LAST-finishing sibling ("aborted by
//    session state"), or makes that dispatch dedupe into an already-settled
//    run and never continue at all. Therefore: the early-return path only
//    appends its tool message and returns bare; only a dispatch that passes
//    the gate (all siblings finalized — a monotonic condition) enters
//    streamThunkWrapper and runs the continuation.
const inflightContinuations = new Map<string, Promise<void>>();

export const streamResponseAfterToolCall = createAsyncThunk<
  void,
  { toolCallId: string; depth?: number; sessionId?: string },
  ThunkApiType
>(
  "chat/streamAfterToolCall",
  async ({ toolCallId, depth = 0, sessionId }, { dispatch, getState }) => {
    // Everything below is decided SYNCHRONOUSLY (before any await) so parallel
    // sibling dispatches all resolve consistently before either starts.
    const state = getState();
    const owner = sessionId
      ? selectSessionById(state, sessionId)
      : selectActiveSession(state);
    const owningSessionId = sessionId ?? owner.id;
    const history = owner.history;
    const assistantMessage = history.findLast(
      (item) =>
        item.message.role === "assistant" &&
        item.toolCallStates?.some((tc) => tc.toolCallId === toolCallId),
    );
    // Sibling dedupe is scoped by session so two sessions running the same
    // tool-call ids can never collapse into one continuation.
    const dedupeKey =
      `${owningSessionId}::` +
      (assistantMessage?.toolCallStates?.length
        ? assistantMessage.toolCallStates
            .map((tc) => tc.toolCallId)
            .sort()
            .join("|")
        : toolCallId);

    const toolCallState = findAllCurToolCalls(history).find(
      (tc) => tc.toolCallId === toolCallId,
    );
    if (!toolCallState) {
      return; // in cases where edit tool is cancelled mid apply, this will be triggered
    }

    const allDone = assistantMessage
      ? areAllToolsDoneStreaming(
          assistantMessage,
          state.config.config.ui?.continueAfterToolRejection,
        )
      : true;

    // Sibling tool calls of the same assistant message are still executing:
    // append THIS tool's output message and return WITHOUT the turn-cleanup
    // wrapper. The LAST-finishing sibling's dispatch will pass the gate and
    // run the continuation (see the topology comment above — routing this
    // early return through streamThunkWrapper dispatched setInactive mid-turn
    // and killed the continuation).
    if (!allDone) {
      dispatch(inSession(resetNextCodeBlockToApplyIndex(), owningSessionId));
      const newMessage: ChatMessage = {
        role: "tool",
        content: renderContextItems(toolCallState.output ?? []),
        toolCallId,
      };
      dispatch(inSession(streamUpdate([newMessage]), owningSessionId));
      return;
    }

    // All sibling tool calls are finalized (monotonic — this cannot flip back),
    // so THIS dispatch owns the continuation. Dedupe other gate-passing paths
    // (parallel siblings that finalized together, apply-finished path).
    const existing = inflightContinuations.get(dedupeKey);
    if (existing) {
      // Another dispatch for this same tool-call batch already started the
      // continuation — don't start a second one, just mirror its outcome.
      await existing.catch(() => undefined);
      return;
    }

    const run = (async () => {
      // The continuation now owns the turn: clear the pending-continuation flag
      // so the parent wrapper's `finally` cleanup no longer skips — and does not
      // re-end a turn that streamResponseAfterToolCall is about to drive.
      dispatch(inSession(setPendingContinuation(false), owningSessionId));
      await dispatch(
        streamThunkWrapper({
          sessionId: owningSessionId,
          run: async () => {
            dispatch(
              inSession(resetNextCodeBlockToApplyIndex(), owningSessionId),
            );

            // Create and dispatch the tool message
            const newMessage: ChatMessage = {
              role: "tool",
              content: renderContextItems(toolCallState.output ?? []),
              toolCallId,
            };
            dispatch(inSession(streamUpdate([newMessage]), owningSessionId));

            unwrapResult(
              await dispatch(
                streamNormalInput({
                  depth: depth + 1,
                  sessionId: owningSessionId,
                }),
              ),
            );
          },
        }),
      );
    })();

    inflightContinuations.set(dedupeKey, run);
    try {
      await run;
    } finally {
      inflightContinuations.delete(dedupeKey);
    }
  },
);
