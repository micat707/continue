import { ArrowRightIcon } from "@heroicons/react/24/outline";
import { ToolCallState } from "core";
import { BuiltInToolNames } from "core/tools/builtIn";
import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../../../redux/hooks";
import { RootState } from "../../../redux/store";
import FunctionSpecificToolCallDiv from "./FunctionSpecificToolCallDiv";
import { GroupedToolCallHeader } from "./GroupedToolCallHeader";
import { McpAppRenderer } from "./MCPAppRenderer";
import { SimpleToolCallUI } from "./SimpleToolCallUI";
import { ToolCallDisplay } from "./ToolCallDisplay";
import { getIconByName, getStatusIcon } from "./utils";

interface ToolCallDivProps {
  toolCallStates: ToolCallState[];
  historyIndex: number;
}

export function ToolCallDiv({
  toolCallStates,
  historyIndex,
}: ToolCallDivProps) {
  const [open, setOpen] = useState(true);
  const userToggled = useRef(false);
  const availableTools = useAppSelector(
    (state: RootState) => state.config.config.tools,
  );

  // Kiro: expand while tools are RUNNING so the user sees progress, then
  // collapse automatically once everything is done. Respect an explicit user
  // toggle for the lifetime of this group (component is keyed by message).
  const hasRunning = (toolCallStates ?? []).some((c) => c.status !== "done");
  useEffect(() => {
    if (userToggled.current) return;
    setOpen(hasRunning);
  }, [hasRunning]);

  if (!toolCallStates?.length) return null;

  // Kiro groups even a SINGLE completed tool call into a collapsible row
  // ("1 tool call"). Keeping the group from the first render — never gating on
  // streaming completeness — makes the structure stable through
  // generating -> calling -> done, so nothing re-parents mid-flow.
  const shouldShowGroupedUI = toolCallStates.length >= 1;

  const renderToolCall = (toolCallState: ToolCallState) => {
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
          running={hasRunning}
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
            {toolCallStates.map((toolCallState) => (
              <div className="py-1 pl-6" key={toolCallState.toolCallId}>
                {renderToolCall(toolCallState)}
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return toolCallStates.map((toolCallState) => (
    <div className="py-1" key={toolCallState.toolCallId}>
      {renderToolCall(toolCallState)}
    </div>
  ));
}
