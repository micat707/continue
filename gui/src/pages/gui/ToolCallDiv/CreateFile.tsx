import { ToolCallState } from "core";
import { getMarkdownLanguageTagForFile } from "core/util";
import { getUriPathBasename } from "core/util/uri";
import { useContext, useState } from "react";
import StyledMarkdownPreview from "../../../components/StyledMarkdownPreview";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ChevronDownIcon, EditIcon, FileIcon } from "./OutcomeIcons";
import { getKiroToolStatusClass, isKiroToolInProgress } from "./utils";

interface CreateFileToolCallProps {
  relativeFilepath: string;
  fileContents: string;
  historyIndex: number;
  toolCallState?: ToolCallState;
}

/**
 * Kiro-style agent-outcome card for `create_new_file`.
 *
 * Kiro routes file creation through its `edit` kind → EditToolCall, which
 * renders a one-row Summary (status icon + short title + clickable file label)
 * and a collapsible Details row holding the diff. An empty file still gets the
 * Summary row — Kiro never hides the card just because there is no content.
 */
export function CreateFile(props: CreateFileToolCallProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [showContent, setShowContent] = useState(false);

  if (!props.relativeFilepath) {
    return null;
  }

  const displayName =
    getUriPathBasename(props.relativeFilepath) || props.relativeFilepath;
  const isReverted = props.toolCallState?.status === "canceled";
  const statusClass = getKiroToolStatusClass(props.toolCallState?.status);
  const inProgress = isKiroToolInProgress(props.toolCallState?.status);
  const src = `\`\`\`${getMarkdownLanguageTagForFile(props.relativeFilepath)} ${props.relativeFilepath}\n${props.fileContents ?? ""}\n\`\`\``;

  const fileLabel = (
    <button
      type="button"
      className="file-label"
      title={props.relativeFilepath}
      onClick={(e) => {
        e.stopPropagation();
        ideMessenger.post("openFile", { path: props.relativeFilepath });
      }}
    >
      <FileIcon />
      <span className="file-label-name">{displayName}</span>
    </button>
  );

  return (
    <div className="agent-outcome">
      <div className="agent-outcome-summary">
        <span className={`agent-outcome-status ${statusClass}`}>
          {inProgress ? (
            <i className="kiro-icon codicon codicon-loading" />
          ) : (
            <EditIcon />
          )}
        </span>
        {isReverted && (
          <span className="agent-outcome-reverted">(reverted)</span>
        )}
        <span className="tool-call-title">Create File</span>
        {fileLabel}
      </div>
      {!!props.fileContents && (
        <div className="kiro-inline-diff">
          <button
            type="button"
            className="kiro-inline-diff-header"
            data-testid="toggle-create-file-content"
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
                source={src}
                itemIndex={props.historyIndex}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
