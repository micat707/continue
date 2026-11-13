import { ToolCallState } from "core";
import { getMarkdownLanguageTagForFile } from "core/util";
import { renderContextItems } from "core/util/messageContent";
import { getUriPathBasename } from "core/util/uri";
import { useContext, useState } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import StyledMarkdownPreview from "../../../components/StyledMarkdownPreview";
import { ChevronDownIcon, EyeIcon, FileIcon } from "./OutcomeIcons";

interface ReadFileToolCallProps {
  toolCallState: ToolCallState;
  historyIndex: number;
}

/**
 * Kiro-style agent-outcome card for `read_file` (mirrors kiro-ui-agent-chat's
 * Read File outcome): a summary row with an eye status glyph + "Read File"
 * title + a clickable file-label pill. The file content is tucked into a
 * collapsible "Details" row so the read text stays available inline without
 * cluttering the chat when collapsed.
 */
export function ReadFile({
  toolCallState,
  historyIndex,
}: ReadFileToolCallProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [showContent, setShowContent] = useState(false);

  const args = (toolCallState.parsedArgs ?? {}) as Record<string, unknown>;
  const filePath: string =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    "";
  if (!filePath) return null;

  const displayName = getUriPathBasename(filePath) || filePath;
  const isDone = toolCallState.status === "done";

  const output = toolCallState.output;
  const content =
    typeof output === "string"
      ? output
      : output && output.length > 0
        ? renderContextItems(output)
        : "";

  const fileLabel = (
    <button
      type="button"
      className="file-label"
      title={filePath}
      onClick={(e) => {
        e.stopPropagation();
        ideMessenger.post("openFile", { path: filePath });
      }}
    >
      <FileIcon />
      <span className="file-label-name">{displayName}</span>
    </button>
  );

  return (
    <div className="agent-outcome">
      <div className="agent-outcome-summary">
        <span
          className={`agent-outcome-status ${
            isDone ? "agent-icon-accepted" : "agent-icon-pending"
          }`}
        >
          <EyeIcon />
        </span>
        <span className="tool-call-title">Read File</span>
        {fileLabel}
      </div>
      {content && (
        <div className="kiro-inline-diff">
          <button
            type="button"
            className="kiro-inline-diff-header"
            data-testid="toggle-read-file-content"
            onClick={() => setShowContent(!showContent)}
          >
            <ChevronDownIcon className={showContent ? "expanded" : ""} />
            <span className="kiro-inline-diff-title">Details</span>
          </button>
          {showContent && (
            <div className="agent-outcome-details">
              <StyledMarkdownPreview
                isRenderingInStepContainer
                disableManualApply
                source={`\`\`\`${getMarkdownLanguageTagForFile(
                  filePath,
                )} ${filePath}\n${content}\n\`\`\``}
                itemIndex={historyIndex}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
