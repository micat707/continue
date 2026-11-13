import { useContext, useMemo } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { EyeIcon, FileIcon } from "../../pages/gui/ToolCallDiv/OutcomeIcons";

interface ReadOutcomeCardProps {
  /** JSON produced by rewriteDeepAgentToolBlocks. */
  payload: string;
}

interface ReadCardData {
  filePath: string;
  lines?: { start: number; end: number };
}

function parsePayload(payload: string): ReadCardData | undefined {
  try {
    const data = JSON.parse(payload);
    if (typeof data?.filePath === "string") {
      return {
        filePath: data.filePath,
        lines: data.lines as ReadCardData["lines"] | undefined,
      };
    }
  } catch {
    // Fall through to the plain-text fallback below.
  }
  return undefined;
}

/**
 * Kiro-style `agent-outcome` card for a deepagents `read_file` call rendered
 * inside the main chat's markdown stream (mirrors kiro-ui-agent-chat's Read
 * File outcome: eye status glyph + "Read File" title + a file-label pill +
 * a compact "L566-695" line-range badge). The file CONTENT is never echoed —
 * it already lives in the conversation history; showing it again would only
 * duplicate noise, so the card stays one quiet summary row.
 */
export function ReadOutcomeCard({ payload }: ReadOutcomeCardProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const data = useMemo(() => parsePayload(payload.trim()), [payload]);

  if (!data) {
    return <pre className="whitespace-pre-wrap text-xs">{payload}</pre>;
  }

  const { filePath, lines } = data;
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  const fileName = parts[parts.length - 1] || "file";

  const openFile = () => {
    if (!filePath) return;
    ideMessenger.post("openFile", { path: filePath });
  };

  return (
    <div className="agent-outcome">
      <div className="agent-outcome-summary">
        <span className="agent-outcome-status agent-icon-accepted">
          <EyeIcon />
        </span>
        <span className="tool-call-title">Read File</span>
        <span
          className="file-label cursor-pointer"
          title={filePath || fileName}
          onClick={openFile}
        >
          <FileIcon />
          <span className="file-label-name">{fileName}</span>
        </span>
        {lines && (
          <span
            className="cursor-pointer font-mono text-[11px] opacity-60 hover:opacity-100"
            title={`${lines.start}-${lines.end} 行`}
            onClick={openFile}
          >
            L{lines.start}-{lines.end}
          </span>
        )}
      </div>
    </div>
  );
}

export default ReadOutcomeCard;
