import { selectActiveSession } from "../../../../redux/slices/sessionSlice";
import { BuiltInToolNames } from "core/tools/builtIn";
import { useContext, useEffect } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import {
  selectApplyStatesForCurrentSession,
  selectConfirmationRequiredApplyStates,
  selectFirstPendingToolCall,
  selectPendingToolCalls,
  selectToolCallsByStatus,
} from "../../../../redux/selectors/selectToolCalls";
import { cancelToolCall } from "../../../../redux/slices/sessionSlice";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelStream } from "../../../../redux/thunks/cancelStream";
import { logToolUsage } from "../../../../redux/util";
import { isJetBrains } from "../../../../util";
import { isEditTool } from "../../../../util/toolCallState";
import { useMainEditor } from "../../TipTapEditor";
import { EditOutcomeToolbar } from "./EditOutcomeToolbar";
import { EditToolbar } from "./EditToolbar";
import { PendingApplyStatesToolbar } from "./PendingApplyStatesToolbar";
import { PendingToolCallToolbar } from "./PendingToolCallToolbar";
import { useDeepAgentHitl } from "./DeepAgentHitlToolbar";
import { PermissionScopeDialog } from "./PermissionScopeDialog";
import { ReviewChangesCard } from "./ReviewChangesCard";
import { StreamingToolbar } from "./StreamingToolbar";
import { TtsActiveToolbar } from "./TtsActiveToolbar";

// Keyboard shortcut detection utilities
const isExecuteToolCallShortcut = (event: KeyboardEvent) => {
  const metaKey = event.metaKey || event.ctrlKey;
  return metaKey && event.key === "Enter";
};

const isCancelToolCallShortcut = (
  event: KeyboardEvent,
  isJetBrains: boolean,
) => {
  const metaKey = event.metaKey || event.ctrlKey;
  const altKey = event.altKey;
  const modifierKey = isJetBrains ? altKey : metaKey;
  return modifierKey && event.key === "Backspace";
};

// Check if a tool call is a terminal command
const isTerminalCommand = (toolCallState: any) => {
  return (
    toolCallState?.toolCall?.function?.name ===
    BuiltInToolNames.RunTerminalCommand
  );
};

export function LumpToolbar() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const ttsActive = useAppSelector((state) => state.ui.ttsActive);
  const isStreaming = useAppSelector(
    (state) => selectActiveSession(state).isStreaming,
  );
  const isInEdit = useAppSelector(
    (state) => selectActiveSession(state).isInEdit,
  );
  const jetbrains = isJetBrains();
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  // DeepAgent human-in-the-loop: a paused agent run awaiting the user's approval
  // of an out-of-workspace file access. Renders a ReviewChangesCard in this slot.
  const {
    active: hitlActive,
    items: hitlItems,
    bulkApprove: hitlBulkApprove,
    bulkReject: hitlBulkReject,
    scopeRequest: hitlScopeRequest,
  } = useDeepAgentHitl();
  // Edit tools are force-auto-approved (evaluateToolPolicies: isEditTool →
  // allowedWithoutPermission) and then go through the apply/diff flow, which
  // renders its OWN "Review changes" card. They must NOT render the separate
  // tool-call approval card — doing so produces a one-frame "flash" (the tool
  // call is briefly "generated" before auto-approval dispatches callToolById).
  const pendingApprovalToolCalls = pendingToolCalls.filter(
    (tc) => !isEditTool(tc.toolCall.function.name),
  );
  const firstPendingToolCall = useAppSelector(selectFirstPendingToolCall);
  const editApplyState = useAppSelector(
    (state) => state.editModeState.applyState,
  );
  // Session-scoped: pending apply cards must only show in the session where
  // the changes were made, not in a newly created/switched-to session.
  // Auto-accepted (allowedWithoutPermission) applies are excluded — flashing a
  // "Review changes" card for them during the done→closed window made the
  // composer jump up/down for every edited file.
  const applyStates = useAppSelector(selectApplyStatesForCurrentSession);
  const pendingApplyStates = useAppSelector(
    selectConfirmationRequiredApplyStates,
  );
  const isApplying = applyStates.some((state) => state.status === "streaming");
  const editor = useMainEditor();

  // Get ALL running terminal commands
  const runningToolCalls = useAppSelector((state) =>
    selectToolCallsByStatus(state, "calling"),
  );
  const runningTerminalCalls = runningToolCalls.filter(isTerminalCommand);
  const hasRunningTerminalCommand = runningTerminalCalls.length > 0;

  // Simple handler: stop ALL running terminal commands
  const handleStopAllTerminalCommands = async () => {
    if (runningTerminalCalls.length === 0) {
      return;
    }

    // Stop all terminal commands concurrently
    const stopPromises = runningTerminalCalls.map(async (terminalCall) => {
      try {
        // Cancel the process on the backend
        await ideMessenger.request("process/killTerminalProcess", {
          toolCallId: terminalCall.toolCallId,
        });

        // Cancel the tool call in the UI
        dispatch(
          cancelToolCall({
            toolCallId: terminalCall.toolCallId,
          }),
        );

        logToolUsage(terminalCall, false, true, ideMessenger);
      } catch (error) {
        console.error(
          `Failed to cancel terminal command ${terminalCall.toolCallId}:`,
          error,
        );
      }
    });

    // Wait for all cancellations to complete
    await Promise.all(stopPromises);
  };

  // Combined stop handler
  const handleStopAction = async () => {
    // Stop all terminal commands if any are running
    if (hasRunningTerminalCommand) {
      await handleStopAllTerminalCommands();
    }

    // Also stop regular streaming if it's happening
    if (isStreaming) {
      dispatch(cancelStream());
    }
  };

  useEffect(() => {
    if (!firstPendingToolCall && !hasRunningTerminalCommand) {
      return;
    }

    const handleToolCallKeyboardShortcuts = (event: KeyboardEvent) => {
      if (isExecuteToolCallShortcut(event) && firstPendingToolCall) {
        event.preventDefault();
        event.stopPropagation();

        void dispatch(
          callToolById({ toolCallId: firstPendingToolCall.toolCallId }),
        );
      } else if (isCancelToolCallShortcut(event, jetbrains)) {
        event.preventDefault();
        event.stopPropagation();

        if (hasRunningTerminalCommand) {
          // Stop running terminal commands
          void handleStopAction();
        } else if (firstPendingToolCall) {
          // Cancel pending tool call. If last call, focus editor
          if (pendingToolCalls.length === 1) {
            editor.mainEditor?.commands.focus();
          }
          void dispatch(
            cancelToolCall({
              toolCallId: firstPendingToolCall.toolCallId,
            }),
          );
          logToolUsage(firstPendingToolCall, false, true, ideMessenger);
        }
      }
    };

    document.addEventListener("keydown", handleToolCallKeyboardShortcuts);
    return () => {
      document.removeEventListener("keydown", handleToolCallKeyboardShortcuts);
    };
  }, [
    firstPendingToolCall,
    pendingToolCalls,
    editor,
    hasRunningTerminalCommand,
    runningTerminalCalls,
  ]);

  // A diff awaiting EXPLICIT user confirmation is the strongest claim on this
  // slot: the turn is parked until the user accepts/rejects, so the card MUST
  // stay mounted. It therefore outranks every transient condition below — most
  // importantly `isApplying`: when the model edits several files in one turn
  // (parallel applies), apply B's brief "streaming" phase used to evict apply
  // A's just-rendered card here, which read as "the approval box pops up and
  // immediately disappears"; the card only came back once B's apply finished.
  if (pendingApplyStates.length > 0) {
    return (
      <PendingApplyStatesToolbar pendingApplyStates={pendingApplyStates} />
    );
  }

  // While an apply is streaming into the editor, the Kiro-style stream bar in
  // Chat.tsx shows the status (same reserved slot as the "answering" bar, text
  // swap only). Rendering a row here would pop the composer height twice.
  if (isApplying) {
    return null;
  }

  if (isInEdit) {
    if (editApplyState.status === "done") {
      return <EditOutcomeToolbar />;
    }

    return <EditToolbar />;
  }

  if (ttsActive) {
    return <TtsActiveToolbar />;
  }

  // Only show terminal streaming for actual terminal commands
  if (hasRunningTerminalCommand) {
    const count = runningTerminalCalls.length;
    const stopText = `Stop Terminal${count > 1 ? ` (${count})` : ""}`;
    return (
      <StreamingToolbar onStop={handleStopAction} displayText={stopText} />
    );
  }

  // User confirmation takes precedence over the "collapse the Lump strip while
  // streaming" rule below: when a tool call awaits explicit approval, the card
  // MUST render even if `isStreaming` is still true. This happens in the agent
  // flow because `respondImmediately:false` keeps the turn "active" (isStreaming
  // stays true with a pending continuation) while the apply reports `done` and
  // waits for the user — the old `if (isStreaming) return null` above suppressed
  // the card and the turn looked hung with no dialog. Render it before the
  // streaming null-return. (Pending apply-state cards rank even higher — see
  // the top of this ladder.)
  if (pendingApprovalToolCalls.length > 0) {
    return <PendingToolCallToolbar />;
  }

  // Kiro's permission `confirm` stage replaces the approval card with the
  // path-pattern / apply-to selector before the decision is sent.
  if (hitlScopeRequest) {
    return <PermissionScopeDialog {...hitlScopeRequest} />;
  }

  // DeepAgent HITL approval takes precedence over the "collapse while streaming"
  // rule below: the agent is paused waiting for the user, so the card must stay
  // mounted even if isStreaming is still true. (Same rationale as the
  // PendingToolCallToolbar branch above it.)
  if (hitlActive) {
    // Command approvals read differently from path approvals — show a title
    // that says what is actually being granted. Covers both foreground
    // `execute` (执行命令) and background `control_process` start (启动后台进程).
    const isCommandRequest = hitlItems.some(
      (it) => it.label === "执行命令" || it.label === "启动后台进程",
    );
    return (
      <ReviewChangesCard
        title={
          isCommandRequest
            ? "DeepAgent 请求执行命令（需要你的授权）"
            : "DeepAgent 请求访问工作区外的文件（需要你的授权）"
        }
        items={hitlItems}
        bulkAcceptLabel="全部接受"
        onBulkAccept={hitlBulkApprove}
        bulkRejectLabel="全部拒绝"
        onBulkReject={hitlBulkReject}
      />
    );
  }

  // Regular streaming (non-terminal): the Kiro-style streaming status bar
  // (.kiro-stream-bar rendered above the input box) already shows the
  // "正在回答中 / 停止" affordance, so the in-input "Generating / Stop"
  // toolbar is redundant. Return null; the now-empty Lump strip is collapsed
  // by the `.kiro-lump:not(:has(...))` rule in kiro-theme.css. Terminal
  // streaming above still keeps its dedicated "Stop Terminal" toolbar.
  if (isStreaming) {
    return null;
  }

  // When idle with no pending tool calls/apply states, surface the consolidated
  // end-of-session file-change summary (one row per file). Falls back to the
  // normal settings toolbar when there are no changes.
  // While a tool call is still EXECUTING (the gap between LLM output and the
  // apply starting), show nothing: the summary card flashing in/out here was
  // one of the visible composer "jumps". The stream bar stays up instead.
  if (runningToolCalls.length > 0) {
    return null;
  }
  // The end-of-session file-change summary now lives inline at the end of the
  // chat (see SessionChangesSummary), so this slot no longer renders it.
  return null;
}
