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
import {
  selectConfirmationRequiredApplyStates,
  selectCurrentToolCalls,
} from "../selectors/selectToolCalls";
import { ThunkApiType } from "../store";
import { cancelStream } from "./cancelStream";
import { saveCurrentSession } from "./session";

export const streamThunkWrapper = createAsyncThunk<
  void,
  () => Promise<void>,
  ThunkApiType
>("chat/streamWrapper", async (runStream, { dispatch, getState }) => {
  try {
    for (let attempt = 0; attempt <= OVERLOADED_RETRIES; attempt++) {
      try {
        await runStream();
        const state = getState();
        if (!state.session.isInEdit) {
          await dispatch(
            saveCurrentSession({
              openNewSession: false,
              generateTitle: true,
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
          await dispatch(cancelStream());
          const delayMs = OVERLOADED_DELAY_MS * 2 ** attempt;
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          await dispatch(cancelStream());
        } else {
          await dispatch(cancelStream());
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
    if (state.session.isStreaming && !state.session.pendingContinuation) {
      dispatch(setInactive());
    }

    // Tool calls awaiting EXPLICIT user confirmation of an applied diff
    // (applyState.status === "done" on a non-auto-accepted tool) are legitimately
    // parked, not abandoned. An edit tool dispatches its apply and then the turn
    // ends while the user decides Accept/Reject; its completion is gated on that
    // choice. Stamping those as errored just because the turn ended first feeds a
    // false failure to the model and triggers retry loops — so exempt them.
    const confirmationToolCallIds = new Set(
      selectConfirmationRequiredApplyStates(state)
        .map((applyState) => applyState.toolCallId)
        .filter((id): id is string => Boolean(id)),
    );

    for (const tc of selectCurrentToolCalls(state)) {
      if (tc.status !== "generating" && tc.status !== "calling") {
        continue;
      }
      if (tc.toolCallId && confirmationToolCallIds.has(tc.toolCallId)) {
        continue;
      }
      dispatch(
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
      );
    }
  }
});
