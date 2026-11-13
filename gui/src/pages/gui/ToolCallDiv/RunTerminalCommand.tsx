import { useState } from "react";
import { ToolCallState } from "core";
import { UnifiedTerminalCommand } from "../../../components/UnifiedTerminal/UnifiedTerminal";

interface RunTerminalCommandToolCallProps {
  command: string;
  toolCallState: ToolCallState;
  toolCallId: string | undefined;
}

export function RunTerminalCommand(props: RunTerminalCommandToolCallProps) {
  // For errored status, show any output (error messages)
  // Otherwise look for terminal output specifically
  const isErrored = props.toolCallState.status === "errored";
  const outputItem = isErrored
    ? props.toolCallState.output?.[0] // Get first output item for errors
    : props.toolCallState.output?.find((item) => item.name === "Terminal");

  const terminalContent = outputItem?.content || "";
  const statusMessage = outputItem?.status || "";
  const isRunning = props.toolCallState.status === "calling";

  // Determine status type
  let statusType: "running" | "completed" | "failed" | "background" =
    "completed";
  if (isRunning) {
    statusType = "running";
  } else if (isErrored || statusMessage?.includes("failed")) {
    statusType = "failed";
  } else if (statusMessage?.includes("background")) {
    statusType = "background";
  }

  // Kiro wraps each tool call in a collapsible group: collapsed by default
  // (so a long command log stays out of the way), auto-expanded while it is
  // still running or when it errored (so the user sees the result / failure).
  const [open, setOpen] = useState(isRunning || isErrored);

  return (
    <div className="collapsible-container" data-open={open ? "true" : "false"}>
      <button
        type="button"
        className="collapsible-toggle"
        aria-expanded={open}
        aria-label={open ? "Collapse" : "Expand"}
        onClick={() => setOpen(!open)}
      >
        <i className="kiro-icon codicon codicon-chevron-right collapsible-chevron" />
        <span className="collapsible-label">1 tool call</span>
      </button>
      <div
        className="collapsible-content-wrapper"
        data-open={open ? "true" : "false"}
        aria-hidden={!open}
      >
        <div className="collapsible-content">
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
