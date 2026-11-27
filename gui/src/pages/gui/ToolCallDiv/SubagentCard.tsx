import { ToolCallState } from "core";
import { useEffect, useRef, useState } from "react";
import { GenericToolCallCard } from "./GenericToolCallCard";
import { GroupedToolCallHeader } from "./GroupedToolCallHeader";
import { UserInputCard } from "./UserInputCard";
import { getKiroToolStatusClass, isKiroToolInProgress } from "./utils";

interface SubagentCardProps {
  toolCallState: ToolCallState;
}

interface ChildTool {
  name: string;
  input: string;
  output: string;
  status: string;
  children?: ChildTool[];
}

interface SubagentEnvelope {
  __subagent: true;
  name: string;
  final: string;
  children: ChildTool[];
}

/** Minimal state synthesis — enough for every card's renderer to work. */
function childToState(child: ChildTool, uid: string): ToolCallState {
  let parsedArgs: Record<string, unknown> = {};
  try {
    parsedArgs = JSON.parse(child.input || "{}");
  } catch {
    /* non-JSON input: leave empty */
  }
  const status =
    child.status === "completed" ||
    child.status === "success" ||
    child.status === "done"
      ? "done"
      : child.status === "error" || child.status === "failed"
        ? "errored"
        : "calling";
  return {
    toolCallId: uid,
    toolCall: {
      id: uid,
      type: "function",
      function: { name: child.name, arguments: child.input || "{}" },
    },
    status,
    parsedArgs,
    output: child.output
      ? [
          {
            name: child.name,
            description: "Tool result",
            content: child.output,
          },
        ]
      : undefined,
  } as ToolCallState;
}

function parseEnvelope(content: string): SubagentEnvelope | undefined {
  try {
    const v = JSON.parse(content);
    if (v && v.__subagent === true && Array.isArray(v.children)) return v;
  } catch {
    /* not an envelope (old sessions / plain text result) */
  }
  return undefined;
}

/**
 * Kiro SubtaskToolCall: an `invoke_sub_agent` card whose Details recursively
 * renders the subagent's own tool group (`Running N tools` → child cards).
 * Kiro does this by storing child events on the parent's `subtaskEntries`;
 * we carry them in a JSON envelope on the native toolResult instead.
 */
export function SubagentCard({ toolCallState }: SubagentCardProps) {
  const content = toolCallState.output?.[0]?.content ?? "";
  const envelope = parseEnvelope(content);
  const isDone = toolCallState.status === "done";
  const statusClass = getKiroToolStatusClass(toolCallState.status);
  const inProgress = isKiroToolInProgress(toolCallState.status);
  const name =
    envelope?.name ??
    (typeof toolCallState.parsedArgs?.name === "string"
      ? toolCallState.parsedArgs.name
      : "sub-agent");
  const children = envelope?.children ?? [];
  const running = !isDone && children.length > 0;

  const [expanded, setExpanded] = useState(false);
  const [groupOpen, setGroupOpen] = useState(running);
  const userToggledGroup = useRef(false);
  useEffect(() => {
    if (userToggledGroup.current) return;
    setGroupOpen(running);
  }, [running]);

  // Plain-text result (old session or envelope parse failed): show it inline.
  if (!envelope) {
    return (
      <div className="agent-outcome">
        <div className="agent-outcome-summary">
          <span className={`agent-outcome-status ${statusClass}`}>
            <i
              className={`kiro-icon codicon ${
                inProgress ? "codicon-loading" : "codicon-eye"
              }`}
            />
          </span>
          <span className="tool-call-title">Sub-agent: {name}</span>
        </div>
        {content && (
          <div className="agent-outcome-details">
            <div className="whitespace-pre-wrap break-words text-xs">
              {content}
            </div>
          </div>
        )}
      </div>
    );
  }

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

      {children.length > 0 && (
        <div
          className="collapsible-content-wrapper"
          data-open={expanded ? "true" : "false"}
          aria-hidden={!expanded}
        >
          <div className="agent-outcome-details subtask-entries">
            <div
              className="collapsible-container"
              data-open={groupOpen ? "true" : "false"}
            >
              <GroupedToolCallHeader
                toolCallStates={children.map((c, i) =>
                  childToState(c, `${toolCallState.toolCallId}-child-${i}`),
                )}
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
                  {children.map((child, i) => {
                    const uid = `${toolCallState.toolCallId}-child-${i}`;
                    const state = childToState(child, uid);
                    if (child.name === "user_input") {
                      // Sub-agent `user_input` executes inside the child graph
                      // and posts `userInputRequested` to the GUI. Only
                      // UserInputCard listens for that event and renders the
                      // interactive question; a generic card would strand the
                      // question and leave the sub-agent waiting forever.
                      return (
                        <div className="py-1" key={uid}>
                          <UserInputCard toolCallState={state} />
                        </div>
                      );
                    }
                    if (child.name.startsWith("sub-agent:")) {
                      // Nested delegation: synthesize an envelope state so
                      // SubagentCard can recurse (Kiro supports infinite depth).
                      const nested: ToolCallState = {
                        ...state,
                        toolCall: {
                          ...state.toolCall,
                          function: {
                            name: "invoke_sub_agent",
                            arguments: "{}",
                          },
                        },
                        output: [
                          {
                            name: "invoke_sub_agent",
                            description: "Tool result",
                            content: JSON.stringify({
                              __subagent: true,
                              name: child.name.replace("sub-agent: ", ""),
                              final: child.output,
                              children: child.children ?? [],
                            }),
                          },
                        ],
                      } as ToolCallState;
                      return (
                        <div className="py-1" key={uid}>
                          <SubagentCard toolCallState={nested} />
                        </div>
                      );
                    }
                    return (
                      <div className="py-1" key={uid}>
                        <GenericToolCallCard toolCallState={state} />
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {envelope.final && expanded && (
        <div className="agent-outcome-details">
          <div className="whitespace-pre-wrap break-words text-xs">
            {envelope.final}
          </div>
        </div>
      )}
    </div>
  );
}
