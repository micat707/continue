import { ToolCallState } from "core";

interface GroupedToolCallHeaderProps {
  toolCallStates: ToolCallState[];
  open: boolean;
  running: boolean;
  onToggle: () => void;
}

/**
 * Kiro collapsible-label text (`YN` in kiro-ui-agent-chat):
 *   streaming → "Running N tool(s)"
 *   done      → "N tool call(s)"
 * The group stays expanded while tools run so progress is visible, then
 * collapses once everything finishes.
 */
export function GroupedToolCallHeader({
  toolCallStates,
  open,
  running,
  onToggle,
}: GroupedToolCallHeaderProps) {
  const count = toolCallStates.length;
  const label = running
    ? `Running ${count} ${count === 1 ? "tool" : "tools"}`
    : `${count} tool ${count === 1 ? "call" : "calls"}`;

  return (
    <button
      type="button"
      className="collapsible-toggle"
      data-running={running ? "true" : "false"}
      data-testid="performing-actions"
      aria-expanded={open}
      aria-label={open ? "Collapse" : "Expand"}
      onClick={onToggle}
    >
      <span
        aria-hidden="true"
        style={{ display: "inline-block", width: 10, flexShrink: 0 }}
      />
      <i className="kiro-icon codicon codicon-chevron-right collapsible-chevron" />
      <span className="collapsible-label">{label}</span>
    </button>
  );
}
