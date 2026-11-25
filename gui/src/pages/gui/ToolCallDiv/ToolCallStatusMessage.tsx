import { Tool, ToolCallState } from "core";

interface ToolCallStatusMessageProps {
  tool: Tool | undefined;
  toolCallState: ToolCallState;
}

/**
 * Kiro's DefaultToolCall renders only a status icon + a short tool title in the
 * summary row — no "Continue will use the X tool" sentence. The status itself is
 * already conveyed by the icon (see getStatusIcon / ToggleWithIcon), so the
 * title stays a clean, static label. This is used only by the two default-card
 * paths (ToolCallDisplay, SimpleToolCallUI); dedicated cards render their own
 * Kiro-style title.
 */
export function ToolCallStatusMessage({ tool }: ToolCallStatusMessageProps) {
  const title = tool?.displayTitle ?? tool?.function?.name ?? "Tool use";

  return (
    <span
      className="tool-call-title text-description line-clamp-4 min-w-0 break-words"
      data-testid="tool-call-title"
    >
      {title}
    </span>
  );
}
