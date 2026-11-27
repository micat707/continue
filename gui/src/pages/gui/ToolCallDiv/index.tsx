import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { chatMessageIsEmpty } from "core/llm/messages";
import { findLastIndex } from "core/util/findLast";
import { BuiltInToolNames } from "core/tools/builtIn";
import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../../redux/hooks";
import { selectActiveSession } from "../../../redux/slices/sessionSlice";
import { RootState } from "../../../redux/store";
import FunctionSpecificToolCallDiv from "./FunctionSpecificToolCallDiv";
import { GroupedToolCallHeader } from "./GroupedToolCallHeader";
import { McpAppRenderer } from "./MCPAppRenderer";
import { SimpleToolCallUI } from "./SimpleToolCallUI";
import { SubtaskToolCall } from "./SubtaskToolCall";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { getIconByName, getStatusIcon } from "./utils";
import { groupEntriesBySubtask, isAgentSubtaskCard } from "./subtaskGrouping";

interface ToolCallDivProps {
  toolCallStates: ToolCallState[];
  historyIndex: number;
}

export function ToolCallDiv({
  toolCallStates,
  historyIndex,
}: ToolCallDivProps) {
  const isStreaming = useAppSelector(
    (state: RootState) => selectActiveSession(state).isStreaming,
  );
  const history = useAppSelector(
    (state: RootState) => selectActiveSession(state).history,
  );
  const lastNonEmptyIndex = findLastIndex(
    history,
    (item) => !chatMessageIsEmpty(item.message),
  );
  // Kiro keeps ONLY the tail tool group open while the turn is streaming,
  // then collapses it when the stream/result finishes. Older groups stay
  // collapsed regardless of individual tool status.
  const groupIsRunning = isStreaming && historyIndex === lastNonEmptyIndex;
  const [open, setOpen] = useState(groupIsRunning);
  const userToggled = useRef(false);
  const availableTools = useAppSelector(
    (state: RootState) => state.config.config.tools,
  );

  // Kiro-style flat subtask grouping: children are tagged with the parent
  // invoke_sub_agent toolCallId and must not be rendered at the top level.
  const { rootStates, groups } = groupEntriesBySubtask(toolCallStates ?? []);
  const visibleStates = rootStates.length > 0 ? rootStates : toolCallStates;

  // Respect an explicit user toggle for the lifetime of this group (component
  // is keyed by message), otherwise follow the streaming/tail state above.
  useEffect(() => {
    if (userToggled.current) return;
    setOpen(groupIsRunning);
  }, [groupIsRunning]);

  if (!toolCallStates?.length) return null;

  // Kiro groups even a SINGLE completed tool call into a collapsible row
  // ("1 tool call"). Keeping the group from the first render — never gating on
  // streaming completeness — makes the structure stable through
  // generating -> calling -> done, so nothing re-parents mid-flow.
  const shouldShowGroupedUI = toolCallStates.length >= 1;

  const renderToolCall = (toolCallState: ToolCallState) => {
    // Kiro SubtaskToolCall: an invoke_sub_agent parent renders its flat-tagged
    // children recursively instead of as a flat envelope.
    if (isAgentSubtaskCard(toolCallState)) {
      return (
        <SubtaskToolCall
          toolCallState={toolCallState}
          subtaskEntries={groups.get(toolCallState.toolCallId) ?? []}
          allGroups={groups}
          toolCallStates={visibleStates}
        />
      );
    }
    const tool = availableTools.find(
      (tool) => toolCallState.toolCall.function?.name === tool.function.name,
    );
    const functionName = toolCallState.toolCall.function?.name;
    const icon =
      functionName && tool?.toolCallIcon
        ? getIconByName(tool.toolCallIcon)
        : undefined;

    if (toolCallState.mcpUiState) {
      return (
        <ToolCallDisplay
          icon={getStatusIcon(toolCallState.status)}
          tool={tool}
          toolCallState={toolCallState}
          historyIndex={historyIndex}
        >
          <McpAppRenderer toolCallState={toolCallState} />
        </ToolCallDisplay>
      );
    }

    if (icon) {
      return (
        <SimpleToolCallUI
          tool={tool}
          toolCallState={toolCallState}
          icon={toolCallState.status === "generated" ? ArrowRightIcon : icon}
          historyIndex={historyIndex}
        />
      );
    }

    // Cards that render their OWN Kiro-style agent-outcome summary (status icon
    // + title + details) must not be wrapped in ToolCallDisplay — that would
    // double the status icon and title. Native DeepAgent tool calls carry a
    // `deepagent-` id prefix (see DeepAgentLLM); every such card owns its header.
    const isNativeDeepAgentCard =
      toolCallState.toolCallId?.startsWith("deepagent-");
    if (
      isNativeDeepAgentCard ||
      functionName === BuiltInToolNames.SingleFindAndReplace ||
      functionName === BuiltInToolNames.MultiEdit ||
      functionName === BuiltInToolNames.RunTerminalCommand
    ) {
      return (
        <div className="flex flex-col px-1">
          <FunctionSpecificToolCallDiv
            toolCallState={toolCallState}
            historyIndex={historyIndex}
          />
        </div>
      );
    }

    return (
      <ToolCallDisplay
        icon={getStatusIcon(toolCallState.status)}
        tool={tool}
        toolCallState={toolCallState}
        historyIndex={historyIndex}
      >
        <FunctionSpecificToolCallDiv
          toolCallState={toolCallState}
          historyIndex={historyIndex}
        />
      </ToolCallDisplay>
    );
  };

  if (shouldShowGroupedUI) {
    return (
      <div
        className="collapsible-container"
        data-open={open ? "true" : "false"}
      >
        <GroupedToolCallHeader
          toolCallStates={toolCallStates}
          open={open}
          running={groupIsRunning}
          onToggle={() => {
            userToggled.current = true;
            setOpen(!open);
          }}
        />
        <div
          className="collapsible-content-wrapper"
          data-open={open ? "true" : "false"}
          aria-hidden={!open}
        >
          <div className="collapsible-content tool-call-group-content">
            {visibleStates.map((toolCallState) => (
              <div className="py-1" key={toolCallState.toolCallId}>
                {renderToolCall(toolCallState)}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return visibleStates.map((toolCallState) => (
    <div className="py-1" key={toolCallState.toolCallId}>
      {renderToolCall(toolCallState)}
    </div>
  ));
}
