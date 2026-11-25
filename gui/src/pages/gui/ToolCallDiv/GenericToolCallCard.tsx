import { ToolCallState } from "core";
import { useContext, useMemo, useState } from "react";
import { getUriPathBasename } from "core/util/uri";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ChevronDownIcon, CompareChangesIcon, FileIcon } from "./OutcomeIcons";
import { UnifiedDiffView } from "../../../components/StyledMarkdownPreview/UnifiedDiffView";

interface GenericToolCallCardProps {
  toolCallState: ToolCallState;
}

/**
 * Kiro-style DefaultToolCall card, used as the single fallback for every
 * DeepAgent tool that has no dedicated card.
 *
 * Kiro's DefaultToolCall is a Summary row (status icon + short title) with
 * Details rendered only when the tool produced something worth showing. We add
 * two Kiro card idioms on top:
 *   - a clickable file-label when the args carry a path (path/paths/targetFile)
 *   - an inline unified diff (with View diff action) when the result contains
 *     one, so write tools get Kiro's EditToolCall look for free.
 */
export function GenericToolCallCard({
  toolCallState,
}: GenericToolCallCardProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [expanded, setExpanded] = useState(false);

  const name = toolCallState.toolCall.function?.name ?? "tool";
  const isDone = toolCallState.status === "done";
  const isFailed =
    toolCallState.status === "errored" || toolCallState.status === "canceled";
  const title = toDisplayTitle(name);

  const args = (toolCallState.parsedArgs ?? {}) as Record<string, unknown>;
  const filePath = extractPath(args);
  const fileName = filePath ? getUriPathBasename(filePath) || filePath : "";

  const rawResult = toolCallState.output?.[0]?.content?.trim() ?? "";
  const diffStart = rawResult.indexOf("--- a/");
  const hasDiff = diffStart >= 0;
  const result = hasDiff ? rawResult.slice(diffStart).trimEnd() : rawResult;

  const statusClass = isFailed
    ? "agent-icon-rejected"
    : isDone
      ? "agent-icon-accepted"
      : "agent-icon-pending";

  const openFile = () => {
    if (filePath) ideMessenger.post("openFile", { path: filePath });
  };

  const viewDiff = () => {
    ideMessenger.post("showVirtualFile", {
      name: `Changes in ${fileName || "file"}`,
      content: result,
    });
  };

  return (
    <div className="agent-outcome">
      <div className="agent-outcome-summary">
        <span className={`agent-outcome-status ${statusClass}`}>
          <i className="kiro-icon codicon codicon-tools" />
        </span>
        <span className="tool-call-title">{title}</span>
        {filePath && (
          <button
            type="button"
            className="file-label"
            title={filePath}
            onClick={openFile}
          >
            <FileIcon />
            <span className="file-label-name">{fileName}</span>
          </button>
        )}
        {hasDiff && (
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
        )}
      </div>
      {result && (
        <div className="kiro-inline-diff">
          <button
            type="button"
            className="kiro-inline-diff-header"
            data-testid="toggle-generic-tool-details"
            onClick={() => setExpanded(!expanded)}
          >
            <ChevronDownIcon className={expanded ? "expanded" : ""} />
            <span className="kiro-inline-diff-title">Details</span>
          </button>
          {expanded && (
            <div className="agent-outcome-details">
              {hasDiff ? (
                <UnifiedDiffView diff={result} />
              ) : (
                <pre className="m-0 whitespace-pre-wrap break-words text-xs leading-tight">
                  {result}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Same shape as toolView.ts displayTitle, with a few readable aliases. */
function toDisplayTitle(name: string): string {
  const aliases: Record<string, string> = {
    fs_write: "Write File",
    fs_append: "Append to File",
    append_lines: "Append to File",
    str_replace: "Replace in File",
    delete_file: "Delete File",
    list_directory: "List Directory",
    file_search: "File Search",
    grep_search: "Grep Search",
    read_files: "Read Files",
    read_code: "Read Code",
    web_fetch: "Fetch URL",
    web_search: "Web Search",
    invoke_sub_agent: "Sub-agent",
    taskList: "Task List",
    taskGet: "Task Details",
    taskUpdate: "Update Task",
    control_pwsh_process: "Control Process",
    get_process_output: "Process Output",
    list_processes: "List Processes",
    create_hook: "Create Hook",
    update_session_information: "Update Session",
    create_artifact: "Create Artifact",
  };
  if (aliases[name]) return aliases[name];
  return name
    .replace(/^mcp__.*__/, "")
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

/** Pull the first file path out of the common DeepAgent arg field names. */
function extractPath(args: Record<string, unknown>): string {
  for (const key of ["path", "file_path", "targetFile", "filepath"]) {
    const v = args[key];
    if (typeof v === "string" && v) return v;
  }
  const paths = args.paths;
  if (Array.isArray(paths) && typeof paths[0] === "string") return paths[0];
  const tasksFilePath = args.tasksFilePath;
  if (typeof tasksFilePath === "string" && tasksFilePath) return tasksFilePath;
  return "";
}
