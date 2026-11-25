import { splitUnifiedDiff } from "core/util/unifiedDiff";
import { useContext, useMemo, useState } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import {
  ChevronDownIcon,
  CompareChangesIcon,
  EditIcon,
  FileIcon,
} from "../../pages/gui/ToolCallDiv/OutcomeIcons";
import { UnifiedDiffView } from "./UnifiedDiffView";

interface EditOutcomeCardProps {
  /** JSON produced by rewriteDeepAgentToolBlocks. */
  payload: string;
}

interface EditCardData {
  filePath: string;
  result: string;
}

function parsePayload(payload: string): EditCardData | undefined {
  try {
    const data = JSON.parse(payload);
    if (typeof data?.result === "string") {
      return { filePath: String(data.filePath ?? ""), result: data.result };
    }
  } catch {
    // Fall through to the plain-text fallback below.
  }
  return undefined;
}

/**
 * Kiro-style `agent-outcome` card for a deepagents `edit_file` call rendered
 * inside the main chat's markdown stream. Unlike FindAndReplaceDisplay this has
 * no ToolCallState / apply state, so it only offers read-only actions: a file
 * label, "View diff" (virtual file) and a collapsible inline diff.
 */
export function EditOutcomeCard({ payload }: EditOutcomeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const ideMessenger = useContext(IdeMessengerContext);
  const data = useMemo(() => parsePayload(payload.trim()), [payload]);

  if (!data) {
    return <pre className="whitespace-pre-wrap text-xs">{payload}</pre>;
  }

  const { filePath, result } = data;
  const parts = filePath.split("/").filter(Boolean);
  const fileName = parts[parts.length - 1] || "file";

  // The backend prepends a one-line success summary to the unified diff;
  // keep only the diff itself — the summary and header are shown elsewhere.
  const diffStart = result.indexOf("--- a/");
  const diff =
    diffStart >= 0 ? result.slice(diffStart).trimEnd() : result.trimEnd();

  const viewDiff = () => {
    const pair = splitUnifiedDiff(diff);
    if (!pair) {
      ideMessenger.post("showVirtualFile", {
        name: `Changes in ${fileName}`,
        content: diff,
      });
      return;
    }
    ideMessenger.post("showEditDiff", {
      title: `${fileName} (Agent changes)`,
      filepath: filePath || fileName,
      originalContent: pair.original,
      newContent: pair.modified,
    });
  };

  return (
    <div className="agent-outcome">
      <div className="agent-outcome-summary">
        <span className="agent-outcome-status agent-icon-accepted">
          <EditIcon />
        </span>
        <span className="tool-call-title">Replace</span>
        <span
          className="file-label cursor-pointer"
          title={`View diff — ${filePath || fileName}`}
          onClick={viewDiff}
        >
          <FileIcon />
          <span className="file-label-name">{fileName}</span>
        </span>
        <ul className="action-bar agent-outcome-actions">
          <li className="action-item">
            <button
              type="button"
              className="kiro-button kiro-icon-button"
              title="View diff"
              aria-label="View diff"
              onClick={viewDiff}
            >
              <CompareChangesIcon />
            </button>
          </li>
        </ul>
      </div>

      <div className="kiro-inline-diff">
        <button
          type="button"
          className="kiro-inline-diff-header"
          onClick={() => setExpanded(!expanded)}
        >
          <ChevronDownIcon className={expanded ? "expanded" : ""} />
          <span className="kiro-inline-diff-title">Details</span>
        </button>
        {expanded && (
          <div className="agent-outcome-details">
            <UnifiedDiffView diff={diff} />
          </div>
        )}
      </div>
    </div>
  );
}

export default EditOutcomeCard;
