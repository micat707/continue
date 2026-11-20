import { selectActiveSession } from "../slices/sessionSlice";
import { createSelector } from "@reduxjs/toolkit";
import { ToolStatus } from "core";
import { RootState } from "../store";
import {
  findAllCurToolCalls,
  findAllCurToolCallsByStatus,
  findToolCallById,
  hasCurrentToolCalls,
} from "../util";
import { isEditTool } from "../../util/toolCallState";

// Edit tools (e.g. single_find_and_replace) are force-auto-approved by
// `evaluateToolPolicies` (isEditTool → allowedWithoutPermission) and then go
// through the apply/diff flow, which has its OWN "Review changes" approval card
// (PendingApplyStatesToolbar). Showing the separate tool-call approval card for
// them is redundant AND produces a visible "flash": the tool call is briefly in
// the "generated" state before the auto-approval dispatches callToolById, so the
// card mounts for one frame and then unmounts. Exclude edit tools from the
// pending-tool-call UI entirely — they auto-run, and the diff card is the single
// approval point.

// Primary selectors for tool calls
export const selectCurrentToolCalls = createSelector(
  (store: RootState) => selectActiveSession(store).history,
  (history) => findAllCurToolCalls(history),
);

export const selectHasCurrentToolCalls = createSelector(
  (store: RootState) => selectActiveSession(store).history,
  (history) => hasCurrentToolCalls(history),
);

export const selectToolCallsByStatus = createSelector(
  [
    (store: RootState) => selectActiveSession(store).history,
    (_store: RootState, status: ToolStatus) => status,
  ],
  (history, status) => findAllCurToolCallsByStatus(history, status),
);

export const selectFirstPendingToolCall = createSelector(
  (store: RootState) => selectActiveSession(store).history,
  (history) => {
    const pendingToolCalls = findAllCurToolCallsByStatus(
      history,
      "generated",
    ).filter((tc) => !isEditTool(tc.toolCall.function.name));
    return pendingToolCalls[0] || undefined;
  },
);

// ID-based selectors for specific tool calls
export const selectToolCallById = createSelector(
  [
    (store: RootState) => selectActiveSession(store).history,
    (_store: RootState, toolCallId: string) => toolCallId,
  ],
  (history, toolCallId) => findToolCallById(history, toolCallId),
);

export const selectApplyStateByToolCallId = createSelector(
  [
    (store: RootState) => selectActiveSession(store).codeBlockApplyStates,
    (_store: RootState, toolCallId: string) => toolCallId,
  ],
  (applyStates, toolCallId) => {
    return applyStates.states.findLast(
      (state) => state.toolCallId === toolCallId,
    );
  },
);

// Status-specific convenience selectors
export const selectPendingToolCalls = createSelector(
  (store: RootState) => selectActiveSession(store).history,
  (history) => findAllCurToolCallsByStatus(history, "generated"),
);

export const selectDoneApplyStates = createSelector(
  (store: RootState) => selectActiveSession(store).codeBlockApplyStates.states,
  (states) => states.filter((applyState) => applyState.status === "done"),
);

// Apply states that belong to the CURRENTLY ACTIVE session. Each apply state
// is tagged with its owning session id when created, so pending accept/reject
// cards and the "applying" status only render in the session where the work
// happened — not in a freshly created / switched-to session. States without a
// tag (shouldn't happen at runtime) are kept visible to avoid orphaning diffs.
export const selectApplyStatesForCurrentSession = createSelector(
  [
    (store: RootState) =>
      selectActiveSession(store).codeBlockApplyStates.states,
    (store: RootState) => selectActiveSession(store).id,
  ],
  (states, sessionId) =>
    states.filter(
      (applyState) =>
        !applyState.sessionId || applyState.sessionId === sessionId,
    ),
);

// Apply states that genuinely await EXPLICIT user confirmation. Tools allowed
// without permission are auto-accepted the moment their apply reports "done"
// (handleApplyStateUpdate posts acceptDiff immediately). Rendering a "Review
// changes" card during that brief done→closed window popped the composer up
// and back down for every edited file — the visible conversation jitter during
// file modifications — so auto-accepted states are excluded from confirmation
// UI here (used by both LumpToolbar and Chat's hasPendingConfirmation).
export const selectConfirmationRequiredApplyStates = createSelector(
  [
    selectApplyStatesForCurrentSession,
    (store: RootState) => selectActiveSession(store).history,
    (store: RootState) => store.ui.toolSettings,
  ],
  (applyStates, history, toolSettings) =>
    applyStates.filter((applyState) => {
      if (applyState.status !== "done") {
        return false;
      }
      const toolCallState = applyState.toolCallId
        ? findToolCallById(history, applyState.toolCallId)
        : undefined;
      const toolName = toolCallState?.toolCall?.function?.name;
      if (!toolName) {
        // Owner unknown — keep the card visible rather than risk orphaning a
        // diff the user never saw.
        return true;
      }
      return toolSettings[toolName] !== "allowedWithoutPermission";
    }),
);
