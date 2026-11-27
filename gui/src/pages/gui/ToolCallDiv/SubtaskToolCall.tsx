import { ToolCallState } from "core";
import { useEffect, useRef, useState } from "react";
import { GenericToolCallCard } from "./GenericToolCallCard";
import { GroupedToolCallHeader } from "./GroupedToolCallHeader";
import { UserInputCard } from "./UserInputCard";
import { isAgentSubtaskCard } from "./subtaskGrouping";
import { getKiroToolStatusClass, isKiroToolInProgress } from "./utils";

interface SubtaskToolCallProps {
  /** The parent invoke_sub_agent card (kind=agent-subtask). */
  toolCallState: ToolCallState;
  /** Flat children tagged with agentSubtaskId === toolCallState.toolCallId. */
  subtaskEntries: ToolCallState[];
  /** All groups, so nested subtask parents can find their grandchildren. */
  allGroups: Map<string, ToolCallState[]>;
  /** Unused placeholder kept for API symmetry; recursion uses allGroups. */
  toolCallStates?: ToolCallState[];
}

type SubagentArgs = {
  name?: string;
  subagent_type?: string;
  prompt?: string;
  description?: string;
  explanation?: string;
};

type SubagentResult = {
  __subagentV2?: boolean;
  name?: string;
  reasoning?: string;
  final?: string;
};

function parseSubagentResult(content: string): SubagentResult {
  try {
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === "object" && parsed.__subagentV2 === true) {
      return parsed as SubagentResult;
    }
  } catch {
    /* plain text result from older sessions */
  }
  return { final: content };
}

/**
 * Kiro SubtaskToolCall: an `invoke_sub_agent` card whose Details renders the
 * subagent's flat tool entries as a recursive nested group. Mirrors Kiro's
 * `SubtaskToolCall` component (`kiro-ui-agent-chat`): the children arrive as
 * independent tool_calls tagged with `_meta.kiro.agentSubtaskId`, are grouped
 * by the store, and render recursively (arbitrary depth).
 */
export function SubtaskToolCall({
  toolCallState,
  subtaskEntries,
  allGroups,
}: SubtaskToolCallProps) {
  const isDone = toolCallState.status === "done";
  const statusClass = getKiroToolStatusClass(toolCallState.status);
  const inProgress = isKiroToolInProgress(toolCallState.status);
  const args = toolCallState.parsedArgs as SubagentArgs | undefined;
  const name =
    (typeof args?.name === "string" && args.name) ||
    (typeof args?.subagent_type === "string" && args.subagent_type) ||
    toolCallState._meta?.kiro?.title ||
    "sub-agent";
  const prompt =
    (typeof args?.prompt === "string" && args.prompt) ||
    (typeof args?.description === "string" && args.description) ||
    (typeof args?.explanation === "string" && args.explanation) ||
    "";
  const result = parseSubagentResult(toolCallState.output?.[0]?.content ?? "");
  const reasoning = result.reasoning ?? "";
  const final = result.final ?? "";
  const children = subtaskEntries ?? [];
  const running = !isDone && children.length > 0;
  const hasTrace = Boolean(prompt || reasoning || final || children.length);

  const [expanded, setExpanded] = useState(false);
  const [groupOpen, setGroupOpen] = useState(running);
  const userToggledGroup = useRef(false);

  // Kiro's nested tool group follows the same streaming/tail rule: open while
  // the parent sub-agent is running, collapsed once its result arrives.
  useEffect(() => {
    if (userToggledGroup.current) return;
    setGroupOpen(running);
  }, [running]);

  const renderChild = (child: ToolCallState) => {
    const fnName = child.toolCall?.function?.name;
    if (isAgentSubtaskCard(child)) {
      return (
        <SubtaskToolCall
          key={child.toolCallId}
          toolCallState={child}
          subtaskEntries={allGroups.get(child.toolCallId) ?? []}
          allGroups={allGroups}
        />
      );
    }
    if (fnName === "user_input") {
      return <UserInputCard key={child.toolCallId} toolCallState={child} />;
    }
    return <GenericToolCallCard key={child.toolCallId} toolCallState={child} />;
  };

  return (
    <div className="agent-outcome">
      <div
        className="agent-outcome-summary cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        title="Toggle sub-agent tools"
      >
        <span className={`agent-outcome-status ${statusClass}`}>
          <i
            className={`kiro-icon codicon ${
              inProgress ? "codicon-loading" : "codicon-eye"
            }`}
          />
        </span>
        <span className="tool-call-title">Sub-agent: {name}</span>
        {children.length > 0 && (
          <span className="kiro-command-cwd">{children.length} steps</span>
        )}
        <i
          className={`kiro-icon codicon codicon-chevron-right outcome-chevron ${
            expanded ? "expanded" : ""
          }`}
        />
      </div>

      {hasTrace && (
        <div
          className="collapsible-content-wrapper"
          data-open={expanded ? "true" : "false"}
          aria-hidden={!expanded}
        >
          <div className="agent-outcome-details subtask-entries">
            {prompt && (
              <div className="subtask-trace-block">
                <div className="subtask-trace-label">Task</div>
                <div className="whitespace-pre-wrap break-words text-xs">
                  {prompt}
                </div>
              </div>
            )}
            {reasoning && (
              <div className="subtask-trace-block">
                <div className="subtask-trace-label">Thinking</div>
                <div className="whitespace-pre-wrap break-words text-xs">
                  {reasoning}
                </div>
              </div>
            )}
            {final && (
              <div className="subtask-trace-block">
                <div className="subtask-trace-label">Result</div>
                <div className="whitespace-pre-wrap break-words text-xs">
                  {final}
                </div>
              </div>
            )}
            {children.length > 0 && (
              <div
                className="collapsible-container"
                data-open={groupOpen ? "true" : "false"}
              >
                <GroupedToolCallHeader
                  toolCallStates={children}
                  open={groupOpen}
                  running={running}
                  onToggle={() => {
                    userToggledGroup.current = true;
                    setGroupOpen(!groupOpen);
                  }}
                />
                <div
                  className="collapsible-content-wrapper"
                  data-open={groupOpen ? "true" : "false"}
                  aria-hidden={!groupOpen}
                >
                  <div className="collapsible-content tool-call-group-content">
                    {children.map((child) => (
                      <div className="py-1" key={child.toolCallId}>
                        {renderChild(child)}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default SubtaskToolCall;
