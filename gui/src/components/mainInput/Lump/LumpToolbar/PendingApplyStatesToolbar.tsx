import { ApplyState } from "core";
import { useContext } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppDispatch } from "../../../../redux/hooks";
import { cancelToolCall } from "../../../../redux/slices/sessionSlice";
import { ReviewChangesCard } from "./ReviewChangesCard";

interface PendingApplyStatesToolbarProps {
  pendingApplyStates: ApplyState[];
}

export function PendingApplyStatesToolbar({
  pendingApplyStates,
}: PendingApplyStatesToolbarProps) {
  // Group apply states by filepath
  const applyStatesByFilepath = pendingApplyStates.reduce(
    (acc, state) => {
      const filepath = state.filepath || ""; // Use empty string as fallback
      if (!acc[filepath]) {
        acc[filepath] = [];
      }
      acc[filepath].push(state);
      return acc;
    },
    {} as Record<string, ApplyState[]>,
  );

  const entries = Object.entries(applyStatesByFilepath);
  const ideMessenger = useContext(IdeMessengerContext);
  const dispatch = useAppDispatch();

  const acceptFile = (states: ApplyState[]) => {
    for (const { filepath = "", streamId, toolCallId } of states) {
      // toolCallId is echoed back on the "closed" apply-state update so the
      // GUI can mark the tool call done and continue the LLM stream.
      ideMessenger.post("acceptDiff", { filepath, streamId, toolCallId });
    }
  };

  const rejectFile = (states: ApplyState[]) => {
    for (const state of states) {
      if (state.toolCallId && state.status === "done") {
        dispatch(cancelToolCall({ toolCallId: state.toolCallId }));
      }
      ideMessenger.post("rejectDiff", {
        filepath: state.filepath ?? "",
        streamId: state.streamId,
        toolCallId: state.toolCallId,
      });
    }
  };

  const acceptAll = () => entries.forEach(([, states]) => acceptFile(states));
  const rejectAll = () => entries.forEach(([, states]) => rejectFile(states));

  // Open the VS Code multi-file "Changes" editor so every pending file edit can
  // be reviewed at once (Kiro's "View changes"). We pass the original/new
  // contents straight from the apply state, so the diff is correct even before
  // anything is written to disk.
  const viewChanges = () => {
    if (entries.length === 0) {
      return;
    }
    void ideMessenger.post("showChanges", {
      title: `Review changes (${entries.length})`,
      files: entries.map(([filepath, states]) => ({
        filepath,
        originalContent: states[0]?.originalFileContent ?? undefined,
        newContent: states[0]?.fileContent ?? undefined,
      })),
    });
  };

  return (
    <ReviewChangesCard
      title={`Review changes (${entries.length} of ${entries.length} pending)`}
      items={entries.map(([filepath, states], index) => ({
        id: filepath || `apply-state-${index}`,
        label: `${states.length} change${states.length === 1 ? "" : "s"} to`,
        filename: filepath,
        // Default kiro icon buttons (✓ / ✕) instead of the wide
        // "Reject/Accept + shortcut" text buttons — matches Kiro's row.
        onAccept: () => acceptFile(states),
        onReject: () => rejectFile(states),
      }))}
      bulkAcceptLabel={entries.length > 1 ? "Accept all" : "Accept"}
      onBulkAccept={acceptAll}
      bulkRejectLabel={entries.length > 1 ? "Reject all" : "Reject"}
      onBulkReject={rejectAll}
      footer={{
        viewChangesLabel: `View changes (${entries.length})`,
        onViewChanges: viewChanges,
        onCancel: rejectAll,
        cancelLabel: "Cancel",
      }}
    />
  );
}
