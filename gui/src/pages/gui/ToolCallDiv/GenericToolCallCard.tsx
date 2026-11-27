import { ToolCallState } from "core";
import { useContext, useState } from "react";
import { getUriPathBasename } from "core/util/uri";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { ChevronDownIcon, CompareChangesIcon, FileIcon } from "./OutcomeIcons";
import { UnifiedDiffView } from "../../../components/StyledMarkdownPreview/UnifiedDiffView";
import { getKiroToolStatusClass, isKiroToolInProgress } from "./utils";

interface GenericToolCallCardProps {
  toolCallState: ToolCallState;
}

type DetailKind = "diff" | "text" | "explanation" | "locations";

type Detail = {
  kind: DetailKind;
  content: string;
};

const READ_TOOLS = new Set([
  "read_file",
  "read_files",
  "read_code",
  "view_file",
  "read",
]);

const SEARCH_TOOLS = new Set([
  "glob",
  "file_search",
  "grep",
  "grep_search",
  "search",
  "search_files",
  "list_directory",
]);

const EDIT_TOOLS = new Set([
  "fs_write",
  "fs_append",
  "append_lines",
  "str_replace",
  "write_file",
  "edit_file",
  "replace",
  "create_artifact",
]);

const EXECUTE_TOOLS = new Set([
  "execute_pwsh",
  "bash",
  "control_pwsh_process",
  "get_process_output",
  "list_processes",
]);

const NO_DETAILS_TOOLS = new Set([
  "delete_file",
  "delete",
  "move_file",
  "move",
]);

/**
 * Kiro-style DefaultToolCall card, used as the single fallback for every
 * DeepAgent tool that has no dedicated card.
 *
 * Kiro chooses a card component first (`read`, `edit`, `execute`, `search`,
 * MCP, fallback), then that component decides whether it has anything worth
 * expanding. We mirror that rule here instead of showing Details for every
 * toolResult: read tools stay one-row, search/list tools show their
 * explanation as a plain row, edit tools show a collapsible diff, execute/MCP
 * tools show output, and the fallback only shows extracted locations.
 */
export function GenericToolCallCard({
  toolCallState,
}: GenericToolCallCardProps) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [expanded, setExpanded] = useState(false);

  const name = toolCallState.toolCall.function?.name ?? "tool";
  const isSearchTool = SEARCH_TOOLS.has(name);
  const title = toDisplayTitle(name);

  const args = (toolCallState.parsedArgs ?? {}) as Record<string, unknown>;
  const filePath = extractPath(args);
  const fileName = filePath ? getUriPathBasename(filePath) || filePath : "";

  const rawResult = toolCallState.output?.[0]?.content?.trim() ?? "";
  const detail = getDetail(name, args, filePath, rawResult);

  // While the Kiro-style approval panel is open, keep the read/search icon in
  // the pending yellow state — Kiro does not show a spinner until execution.
  const pendingApproval =
    Boolean((toolCallState as any)._meta?.kiro?.pendingApproval) &&
    toolCallState.status !== "done" &&
    !rawResult;
  const statusClass = pendingApproval
    ? "agent-icon-pending"
    : getKiroToolStatusClass(toolCallState.status);
  const inProgress =
    !pendingApproval && isKiroToolInProgress(toolCallState.status);

  const openFile = () => {
    if (filePath) ideMessenger.post("openFile", { path: filePath });
  };

  const viewDiff = () => {
    if (!detail || detail.kind !== "diff") return;
    ideMessenger.post("showVirtualFile", {
      name: `Changes in ${fileName || "file"}`,
      content: detail.content,
    });
  };

  return (
    <div
      className={`agent-outcome ${
        toolCallState.status === "done" ? "" : "agent-outcome--running"
      }`}
    >
      <div className="agent-outcome-summary">
        <span className={`agent-outcome-status ${statusClass}`}>
          <i
            className={`kiro-icon codicon ${
              inProgress
                ? "codicon-loading"
                : isSearchTool
                  ? "codicon-search"
                  : "codicon-tools"
            }`}
          />
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
        {detail?.kind === "diff" && (
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
      {detail?.kind === "diff" && (
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
              <UnifiedDiffView diff={detail.content} />
            </div>
          )}
        </div>
      )}
      {detail && detail.kind !== "diff" && (
        <div className="agent-outcome-details">
          {detail.kind === "text" ? (
            <pre className="m-0 whitespace-pre-wrap break-words text-xs leading-tight">
              {detail.content}
            </pre>
          ) : (
            <span>{detail.content}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Kiro's components expand based on what they extracted from the tool call,
 * not on the mere existence of a toolResult.
 */
function getDetail(
  name: string,
  args: Record<string, unknown>,
  filePath: string,
  rawResult: string,
): Detail | null {
  if (name.startsWith("mcp__")) {
    const input = objectText(args);
    const text = [input, rawResult].filter(Boolean).join("\n\n");
    return text ? { kind: "text", content: text } : null;
  }

  // Kiro's ReadToolCall / DeleteToolCall / MoveToolCall never render Details.
  if (READ_TOOLS.has(name) || NO_DETAILS_TOOLS.has(name)) return null;

  if (EDIT_TOOLS.has(name)) {
    const diff = extractDiff(rawResult) || buildDiffFromArgs(filePath, args);
    return diff ? { kind: "diff", content: diff } : null;
  }

  // Kiro's SearchToolCall only expands when the model supplied an explanation.
  if (SEARCH_TOOLS.has(name)) {
    const explanation = firstString(args.explanation, args.why);
    return explanation ? { kind: "explanation", content: explanation } : null;
  }

  // Kiro's CommandToolCall expands when there is a command or output.
  if (EXECUTE_TOOLS.has(name)) {
    return rawResult ? { kind: "text", content: rawResult } : null;
  }

  // Kiro's DefaultToolCall expands only for extracted locations.
  const locations = extractLocations(args);
  return locations.length
    ? { kind: "locations", content: locations.join("\n") }
    : null;
}

function extractDiff(rawResult: string): string {
  const diffStart = rawResult.indexOf("--- ");
  return diffStart >= 0 ? rawResult.slice(diffStart).trimEnd() : "";
}

function buildDiffFromArgs(
  filePath: string,
  args: Record<string, unknown>,
): string {
  const oldText = firstString(args.oldStr, args.old_string, args.oldText);
  const newText = firstString(
    args.text,
    args.newStr,
    args.new_string,
    args.newText,
    args.contents,
    args.content,
  );
  if (newText === undefined && oldText === undefined) return "";

  const path = filePath || "file";
  const oldLines = oldText ? oldText.split(/\r?\n/) : [];
  const newLines = newText ? newText.split(/\r?\n/) : [];
  if (!oldLines.length && !newLines.length) return "";

  const header = `--- a/${path}\n+++ b/${path}\n`;
  if (oldText === undefined) {
    return `${header}@@ -0,0 +1,${newLines.length} @@\n${newLines
      .map((line) => `+${line}`)
      .join("\n")}`;
  }
  return `${header}@@ -1,${oldLines.length} +1,${newLines.length} @@\n${oldLines
    .map((line) => `-${line}`)
    .join("\n")}\n${newLines.map((line) => `+${line}`).join("\n")}`;
}

function extractLocations(args: Record<string, unknown>): string[] {
  const locations: string[] = [];
  const add = (value: unknown) => {
    if (typeof value === "string" && value) locations.push(value);
    else if (value && typeof value === "object") {
      const path = (value as { path?: unknown }).path;
      if (typeof path === "string" && path) locations.push(path);
    }
  };

  const fromArgs = args.locations ?? args.paths;
  if (Array.isArray(fromArgs)) fromArgs.forEach(add);
  else add(fromArgs);
  return locations;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

function objectText(args: Record<string, unknown>): string {
  const keys = Object.keys(args);
  return keys.length ? JSON.stringify(args, null, 2) : "";
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
