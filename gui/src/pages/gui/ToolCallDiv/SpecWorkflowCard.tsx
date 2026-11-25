import { ToolCallState } from "core";
import { useState } from "react";

interface SpecWorkflowCardProps {
  toolCallState: ToolCallState;
}

/**
 * Kiro-style DefaultToolCall card for the spec-workflow control tools
 * (`start_spec_workflow` / `run_spec_tasks`).
 *
 * These tools carry no file/output diff — they just switch the agent into a
 * generation/orchestration phase. Kiro renders such tools as a summary row
 * (status icon + short title + a compact reason badge) with the tool's text
 * result tucked into a collapsible Details row. This mirrors that shape.
 */
export function SpecWorkflowCard({ toolCallState }: SpecWorkflowCardProps) {
  const [expanded, setExpanded] = useState(false);
  const args = (toolCallState.parsedArgs ?? {}) as { reason?: string };
  const isDone = toolCallState.status === "done";
  const isStart =
    toolCallState.toolCall.function?.name === "start_spec_workflow";
  const title = isStart ? "Start Spec Workflow" : "Run Spec Tasks";

  const reason =
    typeof args.reason === "string"
      ? args.reason.replace(/\s+/g, " ").trim()
      : "";

  const result = toolCallState.output?.[0]?.content?.trim() ?? "";
  // The backend's result repeats the reason ("Spec workflow activated. Reason:
  // …"). Keep only the actionable tail in Details to avoid echoing the badge.
  const details = result.replace(/^Spec workflow activated\.\s*/, "").trim();

  return (
    <div className="agent-outcome">
      <div
        className="agent-outcome-summary cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        title="Toggle workflow result"
      >
        <span
          className={`agent-outcome-status ${
            isDone ? "agent-icon-accepted" : "agent-icon-pending"
          }`}
        >
          <i className="kiro-icon codicon codicon-rocket" />
        </span>
        <span className="tool-call-title">{title}</span>
        {reason && (
          <span className="kiro-command-cwd" title={reason}>
            {reason}
          </span>
        )}
        {details && (
          <i
            className={`kiro-icon codicon codicon-chevron-right outcome-chevron ${
              expanded ? "expanded" : ""
            }`}
          />
        )}
      </div>
      {details && (
        <div
          className="collapsible-content-wrapper"
          data-open={expanded ? "true" : "false"}
          aria-hidden={!expanded}
        >
          <div className="agent-outcome-details">
            <div
              className="spec-workflow-result"
              data-testid="spec-workflow-result"
            >
              {details}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
