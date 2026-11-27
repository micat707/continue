import { ToolCallState } from "core";
import { renderContextItems } from "core/util/messageContent";
import { getUriPathBasename } from "core/util/uri";
import { useContext } from "react";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { EyeIcon, FileIcon } from "./OutcomeIcons";
import { getKiroToolStatusClass, isKiroToolInProgress } from "./utils";

interface ReadFileToolCallProps {
  toolCallState: ToolCallState;
  historyIndex: number;
}

interface ReadRange {
  start: number;
  end: number;
}

/**
 * Kiro-style agent-outcome card for `read_file` (mirrors kiro-ui-agent-chat's
 * ReadToolCall): a summary row with an eye status glyph + "Read File" title +
 * a clickable file-label pill + the compact "L566-695" range badge. Kiro's read
 * card never renders Details; the file content stays in the tool result and
 * markdown history instead.
 */
export function ReadFile({ toolCallState }: ReadFileToolCallProps) {
  const ideMessenger = useContext(IdeMessengerContext);

  const args = (toolCallState.parsedArgs ?? {}) as Record<string, unknown>;
  const filePath: string =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    "";
  if (!filePath) return null;

  const displayName = getUriPathBasename(filePath) || filePath;
  const statusClass = getKiroToolStatusClass(toolCallState.status);
  const inProgress = isKiroToolInProgress(toolCallState.status);

  const outputText =
    typeof toolCallState.output === "string"
      ? toolCallState.output
      : renderContextItems(toolCallState.output ?? []);
  const range = extractReadRange(outputText);

  const openFile = () => {
    ideMessenger.post("openFile", { path: filePath });
  };

  return (
    <div className="agent-outcome">
      <div className="agent-outcome-summary">
        <span className={`agent-outcome-status ${statusClass}`}>
          {inProgress ? (
            <i className="kiro-icon codicon codicon-loading" />
          ) : (
            <EyeIcon />
          )}
        </span>
        <span className="tool-call-title">Read File</span>
        <button
          type="button"
          className="file-label"
          title={filePath}
          onClick={(e) => {
            e.stopPropagation();
            openFile();
          }}
        >
          <FileIcon />
          <span className="file-label-name">{displayName}</span>
        </button>
        {range && (
          <span
            className="cursor-pointer font-mono text-[11px] opacity-60 hover:opacity-100"
            title={`${range.start}-${range.end} 行`}
            onClick={openFile}
          >
            L{range.start}-{range.end}
          </span>
        )}
      </div>
    </div>
  );
}

function extractReadRange(output: string): ReadRange | undefined {
  const match = /@@ lines (\d+)-(\d+)(?: of \d+)?(?: \|[^@\n]*)? @@/.exec(
    output,
  );
  return match ? { start: Number(match[1]), end: Number(match[2]) } : undefined;
}
