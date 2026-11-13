import { ApplyState } from "core";
import { trimEmptyLines } from "core/edit/searchAndReplace/findAndReplaceUtils";
import { executeFindAndReplace } from "core/edit/searchAndReplace/performReplace";
import { EditOperation } from "core/tools/definitions/multiEdit";
import { renderContextItems } from "core/util/messageContent";
import { getLastNPathParts, getUriPathBasename } from "core/util/uri";
import { diffLines } from "diff";
import { useContext, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useAppDispatch, useAppSelector } from "../../../redux/hooks";
import { cancelToolCall } from "../../../redux/slices/sessionSlice";
import {
  selectApplyStateByToolCallId,
  selectToolCallById,
} from "../../../redux/selectors/selectToolCalls";
import { cn } from "../../../util/cn";
import Spinner from "../../../components/gui/Spinner";
import {
  CompareChangesIcon,
  DiscardIcon,
  EditIcon,
  RevertedIcon,
  ChevronDownIcon,
  FileIcon,
} from "./OutcomeIcons";

interface FindAndReplaceDisplayProps {
  fileUri?: string; // Added during args preprocessing
  newFileContents?: string; // Added during args preprocessing
  editingFileContents?: string; // Added args preprocessing
  relativeFilePath?: string;
  edits: EditOperation[];
  toolCallId: string;
  historyIndex: number;
}

const MAX_SAME_LINES = 2;

function EllipsisLine() {
  return (
    <div className="text-description-muted px-3 py-1 text-left font-mono">
      ⋯
    </div>
  );
}

function DiffLines({
  lines,
  className = "",
  diffChar = " ",
  diffCharClass = "text-description-muted",
}: {
  lines: string[];
  diffChar?: string;
  diffCharClass?: string;
  className?: string;
}) {
  return (
    <>
      {lines.map((line, lineIndex) => {
        const isLastPartLine = lineIndex === lines.length - 1;
        if (line === "" && isLastPartLine) return null;
        return (
          <div
            key={lineIndex}
            className={cn("text-foreground px-3 py-px font-mono", className)}
          >
            <span className={cn("mr-2 select-none", diffCharClass)}>
              {diffChar}
            </span>
            {line}
          </div>
        );
      })}
    </>
  );
}

export function FindAndReplaceDisplay({
  fileUri,
  newFileContents,
  relativeFilePath,
  editingFileContents,
  edits,
  toolCallId,
  historyIndex,
}: FindAndReplaceDisplayProps) {
  const [isExpanded, setIsExpanded] = useState<boolean | undefined>(undefined);
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const applyState: ApplyState | undefined = useAppSelector((state) =>
    selectApplyStateByToolCallId(state, toolCallId),
  );

  const toolCallState = useAppSelector((state) =>
    selectToolCallById(state, toolCallId),
  );
  // Details is ALWAYS collapsed unless the user expands it. Any automatic
  // expansion (approval preview, status transitions) grows the card while the
  // conversation is streaming above it and shoves the whole message list —
  // every "expand then snap shut" / "jumps up on Accept" report traced back to
  // an auto-expanded Details. The diff preview during approval lives in the
  // composer's review card ("View changes") and the editor's diff overlay,
  // which don't occupy message-flow space.
  const showContent = isExpanded ?? false;
  const config = useAppSelector((state) => state.config.config);

  const displayName = useMemo(() => {
    if (fileUri) {
      return getUriPathBasename(fileUri);
    }
    if (relativeFilePath) {
      return getLastNPathParts(relativeFilePath, 1);
    }
    return "";
  }, [fileUri, relativeFilePath]);

  // Get file content from tool call state instead of reading file
  const currentFileContent = useMemo(() => {
    if (editingFileContents) {
      return editingFileContents;
    }
    if (Array.isArray(edits)) {
      return edits.map((edit) => edit.old_string ?? "").join("\n");
    }
    return "";
  }, [editingFileContents, edits]);

  const diffResult = useMemo(() => {
    try {
      let contentsAfterReplace = newFileContents;
      if (typeof contentsAfterReplace === "undefined") {
        // Apply all edits sequentially
        contentsAfterReplace = currentFileContent;
        for (let i = 0; i < edits.length; i++) {
          const {
            old_string: oldString,
            new_string: newString,
            replace_all: replaceAll,
          } = edits[i];
          contentsAfterReplace = executeFindAndReplace(
            contentsAfterReplace,
            oldString,
            newString,
            !!replaceAll,
            i,
          );
        }
      }

      // Generate diff between original and final content
      const diff = diffLines(currentFileContent, contentsAfterReplace);
      return { diff, error: null };
    } catch (error) {
      return {
        diff: null,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }, [currentFileContent, newFileContents, edits]);

  // Kiro's "accepted edit" badge is a circled pencil (green when done, amber
  // while pending). Once reverted, Kiro swaps it for a green circled check.
  const statusGlyph = useMemo(() => {
    const status = toolCallState?.status;
    if (status === "generating" || status === "calling") {
      return <Spinner />;
    }
    if (status === "canceled") {
      return <RevertedIcon />;
    }
    return <EditIcon />;
  }, [toolCallState?.status]);

  // Kiro-style outcome header: status icon + tool title + file label, e.g.
  // "✓ Replace in File [TestB.txt]". The title mirrors the tool's configured
  // displayTitle so it stays consistent with the rest of the UI.
  const availableTools = useAppSelector((state) => state.config.config?.tools);
  // Title shown on the finished card. The find step is invisible plumbing —
  // what the user did was replace content, so the card says "Replace" rather
  // than the tool's configured "Find and Replace".
  const toolTitle = useMemo(() => {
    const name = toolCallState?.toolCall?.function?.name;
    if (name === "multi_edit") return "Multi-Edit";
    if (name === "single_find_and_replace") return "Replace";
    const tool = availableTools?.find((t) => t.function?.name === name);
    return tool?.displayTitle ?? "Edit File";
  }, [toolCallState?.toolCall?.function?.name, availableTools]);

  const fileReference = fileUri ?? relativeFilePath ?? "";

  // File pill (shared by the running row and the review card).
  const fileLabelButton = (
    <button
      type="button"
      className="file-label"
      title={fileReference}
      onClick={(e) => {
        e.stopPropagation();
        if (fileUri) {
          ideMessenger.post("openFile", { path: fileUri });
        }
      }}
    >
      <FileIcon />
      <span className="file-label-name">{displayName || "..."}</span>
    </button>
  );

  // Kiro-style agent-outcome card: a summary row (status icon + tool title +
  // file label + action buttons) and a collapsible "Details" row that reveals
  // the diff. Layout/classes mirror kiro-ui-agent-chat's .agent-outcome.
  const renderContainer = (content: React.ReactNode) => {
    const isReverted = toolCallState?.status === "canceled";
    const isAccepted = toolCallState?.status === "done" || isReverted;

    // Read/execute phase (Kiro-style): a single quiet status row — spinner +
    // tool title + file pill. The full card (action buttons + Details diff)
    // only appears once the edit actually needs review.
    if (
      toolCallState?.status === "generating" ||
      toolCallState?.status === "calling"
    ) {
      // The find step happens silently inside the tool; what the user is
      // watching is a replacement, so the running row just says "Replace"
      // (or "Multi-Edit") instead of the full tool title.
      const runningTitle =
        toolCallState?.toolCall?.function?.name === "multi_edit"
          ? "Multi-Edit"
          : "Replace";
      return (
        <div className="agent-outcome agent-outcome--running">
          <div className="agent-outcome-summary">
            <span className="agent-outcome-status agent-icon-pending">
              {statusGlyph}
            </span>
            <span className="tool-call-title">{runningTitle}</span>
            {fileLabelButton}
          </div>
        </div>
      );
    }
    return (
      <div className="agent-outcome">
        <div className="agent-outcome-summary">
          <span
            className={`agent-outcome-status ${
              isAccepted ? "agent-icon-accepted" : "agent-icon-pending"
            }`}
            style={toolCallState?.output ? { cursor: "pointer" } : undefined}
            onClick={(e) => {
              if (toolCallState?.output) {
                e.stopPropagation();
                ideMessenger.post("showVirtualFile", {
                  name: "Edit output",
                  content: renderContextItems(toolCallState.output),
                });
              }
            }}
          >
            {statusGlyph}
          </span>
          {isReverted && (
            <span className="agent-outcome-reverted">(reverted)</span>
          )}
          <span className="tool-call-title">{toolTitle}</span>
          {fileLabelButton}
          {!isReverted && (
            <ul className="action-bar agent-outcome-actions">
              <li className="action-item">
                <button
                  type="button"
                  className="kiro-button kiro-icon-button"
                  title="View diff"
                  aria-label="View diff"
                  onClick={(e) => {
                    e.stopPropagation();
                    ideMessenger.post("showChanges", {
                      title: `Changes in ${displayName || "file"}`,
                      files: [{ filepath: fileReference }],
                    });
                  }}
                >
                  <CompareChangesIcon />
                </button>
              </li>
              <li className="action-item">
                <button
                  type="button"
                  className="kiro-button kiro-icon-button"
                  title="Revert"
                  aria-label="Revert"
                  onClick={(e) => {
                    e.stopPropagation();
                    dispatch(cancelToolCall({ toolCallId }));
                    if (applyState) {
                      ideMessenger.post("rejectDiff", {
                        filepath: fileUri,
                        streamId: applyState.streamId,
                      });
                    }
                  }}
                >
                  <DiscardIcon />
                </button>
              </li>
            </ul>
          )}
        </div>
        {!isReverted && (
          <div className="kiro-inline-diff">
            <button
              type="button"
              className="kiro-inline-diff-header"
              data-testid="toggle-find-and-replace-diff"
              onClick={() => setIsExpanded(!showContent)}
            >
              <ChevronDownIcon className={showContent ? "expanded" : ""} />
              <span className="kiro-inline-diff-title">Details</span>
            </button>
            {showContent && (
              <div className="agent-outcome-details">{content}</div>
            )}
          </div>
        )}
      </div>
    );
  };

  if (diffResult?.error) {
    return (
      <div className="text-description mt-2 px-3">
        The searched string was not found in the file
      </div>
    );
  }

  if (
    !diffResult?.diff ||
    (diffResult.diff.length === 1 &&
      !diffResult.diff[0].added &&
      !diffResult.diff[0].removed)
  ) {
    return renderContainer(
      <div className="text-description-muted p-3">No changes to display</div>,
    );
  }

  return renderContainer(
    <div
      className={`${config?.ui?.showChatScrollbar ? "thin-scrollbar" : "no-scrollbar"} max-h-72 overflow-auto`}
    >
      <pre
        className={`bg-editor m-0 w-fit min-w-full text-xs leading-tight ${config?.ui?.codeWrap ? "whitespace-pre-wrap" : "whitespace-pre"}`}
      >
        {diffResult.diff?.map((part, index) => {
          if (part.removed) {
            return (
              <DiffLines
                key={index}
                lines={part.value.split("\n")}
                className="border-l-4 border-red-900 bg-red-900/30"
                diffCharClass="text-red-600"
                diffChar="-"
              />
            );
          } else if (part.added) {
            return (
              <DiffLines
                key={index}
                lines={part.value.split("\n")}
                diffCharClass="text-green-600"
                className="border-l-4 border-green-600 bg-green-600/20"
                diffChar="+"
              />
            );
          } else {
            const isFirst = index === 0;
            const isLast = index === diffResult.diff.length - 1;
            const lines = part.value.split("\n");
            const showStartEllipsis = isFirst && lines.length > MAX_SAME_LINES;
            const showEndEllipsis = isLast && lines.length > MAX_SAME_LINES;
            const showMiddleEllipses =
              !isFirst && !isLast && lines.length > MAX_SAME_LINES * 2 + 1;

            let startLines = showStartEllipsis
              ? lines.slice(-MAX_SAME_LINES)
              : showMiddleEllipses || showEndEllipsis
                ? lines.slice(0, MAX_SAME_LINES)
                : lines;
            startLines = trimEmptyLines({ lines: startLines, fromEnd: false });
            let endLines = showMiddleEllipses
              ? lines.slice(-MAX_SAME_LINES)
              : [];
            endLines = trimEmptyLines({ lines: endLines, fromEnd: true });

            return (
              <div key={index}>
                {showStartEllipsis && <EllipsisLine />}
                <DiffLines lines={startLines} />
                {showMiddleEllipses && <EllipsisLine />}
                <DiffLines lines={endLines} />
                {showEndEllipsis && <EllipsisLine />}
              </div>
            );
          }
        })}
      </pre>
    </div>,
  );
}
