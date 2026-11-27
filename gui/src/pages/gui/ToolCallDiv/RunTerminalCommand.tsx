import { useState } from "react";
import { ToolCallState } from "core";
import { UnifiedTerminalCommand } from "../../../components/UnifiedTerminal/UnifiedTerminal";

interface RunTerminalCommandToolCallProps {
  command: string;
  toolCallState: ToolCallState;
  toolCallId: string | undefined;
}

/**
 * Kiro-style `CommandToolCall` card for the native `run_terminal_command` tool.
 *
 * Kiro's card is always a one-row Summary (terminal status icon + "Run Command"
 * + cwd) that expands into Details holding the command text and its terminal
 * output. The outer ToolCallDiv already provides the collapsible tool group, so
 * this card owns only its own Summary/Details — no nested "1 tool call" toggle.
 */
export function RunTerminalCommand(props: RunTerminalCommandToolCallProps) {
  const isErrored = props.toolCallState.status === "errored";
  const outputItem = isErrored
    ? props.toolCallState.output?.[0]
    : props.toolCallState.output?.find((item) => item.name === "Terminal");

  const terminalContent = outputItem?.content || "";
  const statusMessage = outputItem?.status || "";
  const isRunning = props.toolCallState.status === "calling";

  let statusType: "running" | "completed" | "failed" | "background" =
    "completed";
  if (isRunning) {
    statusType = "running";
  } else if (isErrored || statusMessage?.includes("failed")) {
    statusType = "failed";
  } else if (statusMessage?.includes("background")) {
    statusType = "background";
  }

  const args = (props.toolCallState.parsedArgs ?? {}) as Record<
    string,
    unknown
  >;
  const cwd = typeof args.cwd === "string" ? args.cwd : undefined;

  const statusClass =
    statusType === "running"
      ? "agent-icon-inProgress"
      : statusType === "failed"
        ? "agent-icon-error"
        : statusType === "background"
          ? "agent-icon-pending"
          : "agent-icon-accepted";

  // Kiro: expand while the command runs (or on failure), start collapsed once
  // it succeeded so a long log stays out of the way.
  const [expanded, setExpanded] = useState(
    isRunning || statusType === "failed",
  );

  return (
    <div
      className={`agent-outcome agent-outcome-command${
        isRunning ? "agent-outcome-running" : ""
      }`}
    >
      <div
        className="agent-outcome-summary cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        title="Toggle command output"
      >
        <span className={`agent-outcome-status ${statusClass}`}>
          <i
            className={`kiro-icon codicon ${
              isRunning ? "codicon-loading" : "codicon-terminal"
            }`}
          />
        </span>
        <span className="tool-call-title">Run Command</span>
        {statusType === "failed" && (
          <span className={`kiro-command-status ${statusClass}`}>✗ 失败</span>
        )}
        {statusType === "background" && (
          <span className="kiro-command-status agent-icon-pending">
            后台运行中
          </span>
        )}
        {cwd && (
          <span
            className="kiro-command-cwd"
            title={`Working directory: ${cwd}`}
          >
            {cwd}
          </span>
        )}
        <i
          className={`kiro-icon codicon codicon-chevron-right outcome-chevron ${
            expanded ? "expanded" : ""
          }`}
        />
      </div>

      <div
        className="collapsible-content-wrapper"
        data-open={expanded ? "true" : "false"}
        aria-hidden={!expanded}
      >
        <div className="agent-outcome-details">
          <pre className="kiro-command-text">{props.command}</pre>
          <hr className="agent-outcome-divider" />
          <UnifiedTerminalCommand
            command={props.command}
            output={terminalContent}
            status={statusType}
            statusMessage={statusMessage}
            toolCallState={props.toolCallState}
            toolCallId={props.toolCallId}
          />
        </div>
      </div>
    </div>
  );
}
