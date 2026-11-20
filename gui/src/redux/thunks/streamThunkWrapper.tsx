import {
  inSession,
  selectActiveSession,
  selectSessionById,
} from "../slices/sessionSlice";
import { createAsyncThunk } from "@reduxjs/toolkit";

import StreamErrorDialog from "../../pages/gui/StreamError";
import { analyzeError } from "../../util/errorAnalysis";

const OVERLOADED_RETRIES = 3;
const OVERLOADED_DELAY_MS = 2000;

function isOverloadedErrorMessage(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes("overloaded") || lower.includes("529");
}
import { selectSelectedChatModel } from "../slices/configSlice";
import { setDialogMessage, setShowDialog } from "../slices/uiSlice";
import { errorToolCall, setInactive } from "../slices/sessionSlice";
import { findAllCurToolCalls } from "../util";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession } from "./session";

type StreamWrapperArg =
  | (() => Promise<void>)
  | { run: () => Promise<void>; sessionId?: string };

export const streamThunkWrapper = createAsyncThunk<
  void,
  StreamWrapperArg,
  ThunkApiType
>("chat/streamWrapper", async (arg, { dispatch, getState }) => {
  // Accept both the legacy bare function and the session-aware object form so
  // existing callers need no change; streaming callers pass `sessionId` to keep
  // turn-end cleanup scoped to the owning session.
  const runStream = typeof arg === "function" ? arg : arg.run;
  const owningSessionId = typeof arg === "function" ? undefined : arg.sessionId;
  const sessionState = (s: ReturnType<typeof getState>) =>
    owningSessionId
      ? selectSessionById(s, owningSessionId)
      : selectActiveSession(s);

  try {
    for (let attempt = 0; attempt <= OVERLOADED_RETRIES; attempt++) {
      try {
        await runStream();
        const state = getState();
        if (!sessionState(state).isInEdit) {
          await dispatch(
            saveCurrentSession({
              openNewSession: false,
              generateTitle: true,
              sessionId: owningSessionId,
            }),
          );
        }
        return;
      } catch (e) {
        // Get the selected model from the state for error analysis
        const state = getState();
        const selectedModel = selectSelectedChatModel(state);
        const { message } = analyzeError(e, selectedModel);

        const shouldRetry =
          isOverloadedErrorMessage(message) && attempt < OVERLOADED_RETRIES;

        if (shouldRetry) {
          await dispatch(cancelStream(owningSessionId));
          const delayMs = OVERLOADED_DELAY_MS * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await dispatch(cancelStream(owningSessionId));
        } else {
          await dispatch(cancelStream(owningSessionId));
          dispatch(setDialogMessage(<StreamErrorDialog error={e} />));
          dispatch(setShowDialog(true));

          return;
        }
      }
    }
  } finally {
    // Holistic turn-lifecycle guarantee: no matter how the turn ended — success,
    // a hard error, or exhausted retries — make sure the session is never left
    // "busy". Without this, a thrown error partway through (e.g. a provider HTTP
    // 500 in the stream, or a tool call that throws) could leave session.isStreaming
    // true or a tool call stuck in "generating"/"calling", freezing the composer
    // bar with no recovery.
    //
    // NOTE: no `streamAborter.signal.aborted` skip here. An abort does NOT mean
    // cleanup happened: `abortStream()` (dispatched by the "aborted by session
    // state" path) only flips the signal, and if every finally skipped on
    // `aborted`, a race that aborts mid-turn would leave pending tool calls and
    // isStreaming dirty forever. User-initiated cancels are already fully
    // cleaned up by cancelStream() itself (which dispatches setInactive), so
    // running this cleanup unconditionally is always safe and idempotent.
    const state = getState();
    const targetSession = sessionState(state);
    if (targetSession.isStreaming && !targetSession.pendingContinuation) {
      dispatch(inSession(setInactive(), targetSession.id));
    }

    // Tool calls awaiting EXPLICIT user confirmation of an applied diff
    // (applyState.status === "done" on a non-auto-accepted tool) are legitimately
    // parked, not abandoned. An edit tool dispatches its apply and then the turn
    // ends while the user decides Accept/Reject; its completion is gated on that
    // choice. Stamping those as errored just because the turn ended first feeds a
    // false failure to the model and triggers retry loops — so exempt them.
    // Scoped to the owning session's history/apply-states, not the active one.
    const confirmationToolCallIds = new Set(
      targetSession.codeBlockApplyStates.states
        .filter((s: any) => s.status === "done" && !s.autoAccepted)
        .map((applyState: any) => applyState.toolCallId)
        .filter((id): id is string => Boolean(id)),
    );

    for (const tc of findAllCurToolCalls(targetSession.history)) {
      if (tc.status !== "generating" && tc.status !== "calling") {
        continue;
      }
      if (tc.toolCallId && confirmationToolCallIds.has(tc.toolCallId)) {
        continue;
      }
      dispatch(
        inSession(
          errorToolCall({
            toolCallId: tc.toolCallId,
            output: [
              {
                name: "Tool Call Error",
                description: "Turn ended",
                content:
                  "This tool call was left pending when the turn ended unexpectedly. Please retry the operation.",
                icon: "problems",
              },
            ],
          }),
          targetSession.id,
        ),
      );
    }
  }
});
