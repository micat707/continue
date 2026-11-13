import { useContext } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../../redux/hooks";
import { selectPendingToolCalls } from "../../../../redux/selectors/selectToolCalls";
import { callToolById } from "../../../../redux/thunks/callToolById";
import { cancelToolCallThunk } from "../../../../redux/thunks/cancelToolCall";
import { getAltKeyLabel, getMetaKeyLabel, isJetBrains } from "../../../../util";
import { isEditTool } from "../../../../util/toolCallState";
import { useMainEditor } from "../../TipTapEditor";
import { ReviewChangesCard } from "./ReviewChangesCard";

export const generateToolCallButtonTestId = (
  action: "accept" | "reject",
  toolCallId: string,
) => {
  return `${action}-tool-call-button-${toolCallId}`;
};

// Argument keys tool calls use to point at the file they touch.
const FILE_ARG_KEYS = ["filepath", "path", "file_path", "file", "uri"];

// Argument keys that carry the "after" / "before" file content for edit tools.
// Different tools name them differently (ReplaceInFile vs writeFile vs editFile).
const NEW_CONTENT_KEYS = [
  "newStr",
  "new_str",
  "new_string",
  "newContent",
  "contents",
  "content",
  "file_text",
  "text",
  "code",
];
const OLD_CONTENT_KEYS = [
  "oldStr",
  "old_str",
  "old_string",
  "oldContent",
  "originalContent",
];

function getToolCallFilepath(parsedArgs: unknown): string | undefined {
  if (!parsedArgs || typeof parsedArgs !== "object") {
    return undefined;
  }

  const args = parsedArgs as Record<string, unknown>;
  for (const key of FILE_ARG_KEYS) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) {
      return value;
    }
  }

  return undefined;
}

function getArgString(parsedArgs: unknown, keys: string[]): string | undefined {
  if (!parsedArgs || typeof parsedArgs !== "object") {
    return undefined;
  }
  const args = parsedArgs as Record<string, unknown>;
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") {
      return value;
    }
  }
  return undefined;
}

export function PendingToolCallToolbar() {
  const dispatch = useAppDispatch();
  const jetbrains = isJetBrains();
  // Edit tools are force-auto-approved and have their own diff-approval card, so
  // they never appear in the tool-call approval UI (otherwise they flash for a
  // frame before auto-approval runs).
  const pendingToolCalls = useAppSelector(selectPendingToolCalls).filter(
    (tc) => !isEditTool(tc.toolCall.function.name),
  );
  const editor = useMainEditor();
  const ideMessenger = useContext(IdeMessengerContext);

  if (pendingToolCalls.length === 0) {
    return null;
  }

  const handleAccept = (toolCallId: string) => {
    void dispatch(callToolById({ toolCallId }));
  };

  const handleReject = (toolCallId: string) => {
    // put cursor in editor after last rejection
    if (pendingToolCalls.length === 1) {
      editor.mainEditor?.commands.focus();
    }
    void dispatch(cancelToolCallThunk({ toolCallId }));
  };

  const handleAcceptAll = () => {
    for (const toolCall of pendingToolCalls) {
      handleAccept(toolCall.toolCallId);
    }
  };

  const handleRejectAll = () => {
    editor.mainEditor?.commands.focus();
    for (const toolCall of pendingToolCalls) {
      void dispatch(cancelToolCallThunk({ toolCallId: toolCall.toolCallId }));
    }
  };

  const total = pendingToolCalls.length;
  const acceptShortcut = `${getMetaKeyLabel()}⏎`;
  const rejectShortcut = `${jetbrains ? getAltKeyLabel() : getMetaKeyLabel()}⌫`;

  // File edits we can turn into a diff, with original/new content pulled from
  // the tool arguments where the tool exposes them.
  const changes = pendingToolCalls
    .map((toolCall) => {
      const filepath = getToolCallFilepath(toolCall.parsedArgs);
      if (!filepath) {
        return undefined;
      }
      return {
        filepath,
        originalContent: getArgString(toolCall.parsedArgs, OLD_CONTENT_KEYS),
        newContent: getArgString(toolCall.parsedArgs, NEW_CONTENT_KEYS),
      };
    })
    .filter(
      (
        change,
      ): change is {
        filepath: string;
        originalContent?: string;
        newContent?: string;
      } => Boolean(change),
    );

  // Fallback for non-file actions (e.g. Run Terminal Command): show the command
  // that is about to run so "View changes" still previews the pending action.
  const firstCommand = pendingToolCalls
    .map((toolCall) =>
      getArgString(toolCall.parsedArgs, ["command", "cmd", "shellCommand"]),
    )
    .find((command): command is string => Boolean(command));

  return (
    <ReviewChangesCard
      title={`Review changes (${total} of ${total} pending)`}
      items={pendingToolCalls.map((toolCall) => {
        const filepath = getToolCallFilepath(toolCall.parsedArgs);
        return {
          id: toolCall.toolCallId,
          label: filepath
            ? "1 change to"
            : (toolCall.tool?.displayTitle ?? toolCall.toolCall.function.name),
          filename: filepath,
          acceptTestId: generateToolCallButtonTestId(
            "accept",
            toolCall.toolCallId,
          ),
          rejectTestId: generateToolCallButtonTestId(
            "reject",
            toolCall.toolCallId,
          ),
          acceptTitle: `Accept (${acceptShortcut})`,
          rejectTitle: `Reject (${rejectShortcut})`,
          onAccept: () => handleAccept(toolCall.toolCallId),
          onReject: () => handleReject(toolCall.toolCallId),
        };
      })}
      bulkAcceptLabel={total > 1 ? "Accept all" : "Accept"}
      onBulkAccept={handleAcceptAll}
      bulkRejectLabel={total > 1 ? "Reject all" : "Reject"}
      onBulkReject={handleRejectAll}
      footer={{
        // Always shown (Kiro shows "View changes (N)" on every review card,
        // including non-file actions like Run Terminal Command).
        viewChangesLabel: `View changes (${total})`,
        onViewChanges: () => {
          if (changes.length > 0) {
            void ideMessenger.post("showChanges", {
              title: `Review changes (${changes.length})`,
              files: changes,
            });
          } else if (firstCommand) {
            void ideMessenger.post("showVirtualFile", {
              name: "Terminal command",
              content: firstCommand,
            });
          }
        },
        onCancel: handleRejectAll,
        cancelLabel: "Cancel",
      }}
    />
  );
}
