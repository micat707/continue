import { ToolCallState } from "core";

/**
 * Kiro-style flat-subtask grouping (mirrors `groupEntriesBySubtask` in Kiro's
 * kiro-ui-agent-chat). Every DeepAgent tool now arrives as an independent
 * toolCallState carrying `_meta.kiro.agentSubtaskId` (the parent
 * `invoke_sub_agent` card's id). We pull those children out of the flat list
 * and hand them to the parent card as `subtaskEntries`; only ROOT states are
 * rendered at the top level, so a child is never drawn twice.
 */
export interface SubtaskGrouping {
  rootStates: ToolCallState[];
  /** parent toolCallId → ordered child states (Kiro `subtaskEntries`). */
  groups: Map<string, ToolCallState[]>;
}

export function getAgentSubtaskId(state: ToolCallState): string | undefined {
  const id =
    state._meta?.kiro?.agentSubtaskId ??
    state.toolCall?._meta?.kiro?.agentSubtaskId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

export function isAgentSubtaskCard(state: ToolCallState): boolean {
  return (
    state._meta?.kiro?.kind === "agent-subtask" ||
    state.toolCall?._meta?.kiro?.kind === "agent-subtask"
  );
}

export function groupEntriesBySubtask(
  states: ToolCallState[],
): SubtaskGrouping {
  const rootStates: ToolCallState[] = [];
  const groups = new Map<string, ToolCallState[]>();

  for (const state of states ?? []) {
    const parentId = getAgentSubtaskId(state);
    // Every tagged card goes under its parent — including nested subtask
    // parents (which carry BOTH kind=agent-subtask and an agentSubtaskId).
    // SubtaskToolCall recurses: when it renders such a nested parent it looks
    // up groups.get(nestedId) for the grandchildren. Only untagged cards are
    // roots.
    if (parentId) {
      const list = groups.get(parentId);
      if (list) list.push(state);
      else groups.set(parentId, [state]);
    } else {
      rootStates.push(state);
    }
  }
  return { rootStates, groups };
}
