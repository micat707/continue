import { ToolCallState } from "core";
import { ToggleWithIcon } from "./ToggleWithIcon";

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
      data-testid="performing-actions"
      aria-expanded={open}
      aria-label={open ? "Collapse" : "Expand"}
      onClick={onToggle}
    >
      <ToggleWithIcon isToggleable open={open} />
      <span className="collapsible-label">{label}</span>
    </button>
  );
}
