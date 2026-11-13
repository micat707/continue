import { ModelDescription, Tool } from "core";
import {
  DEFAULT_AGENT_SYSTEM_MESSAGE,
  DEFAULT_CHAT_SYSTEM_MESSAGE,
  DEFAULT_PLAN_SYSTEM_MESSAGE,
} from "core/llm/defaultSystemMessages";

export const NO_TOOL_WARNING =
  "\n\nTHE USER HAS NOT PROVIDED ANY TOOLS, DO NOT ATTEMPT TO USE ANY TOOLS. STOP AND LET THE USER KNOW THAT THERE ARE NO TOOLS AVAILABLE. The user can provide tools by enabling them in the Tool Policies section of the notch (wrench icon)";

const DEFAULT_BY_MODE: Record<string, string> = {
  agent: DEFAULT_AGENT_SYSTEM_MESSAGE,
  plan: DEFAULT_PLAN_SYSTEM_MESSAGE,
  chat: DEFAULT_CHAT_SYSTEM_MESSAGE,
};

export function getBaseSystemMessage(
  messageMode: string,
  model: ModelDescription,
  activeTools?: Tool[],
): string {
  const mode =
    messageMode === "agent" || messageMode === "plan" ? messageMode : "chat";

  const candidate: unknown =
    mode === "agent"
      ? model.baseAgentSystemMessage
      : mode === "plan"
        ? model.basePlanSystemMessage
        : model.baseChatSystemMessage;

  let baseMessage: string;
  if (typeof candidate === "string" && candidate.trim()) {
    baseMessage = candidate;
  } else {
    if (candidate !== undefined && candidate !== null) {
      console.warn(
        "[getBaseSystemMessage] non-string system message, falling back to default:",
        mode,
        candidate,
      );
    }
    baseMessage = DEFAULT_BY_MODE[mode];
  }

  // Add no-tools warning for agent/plan modes when no tools are available
  if (mode !== "chat" && (!activeTools || activeTools.length === 0)) {
    baseMessage += NO_TOOL_WARNING;
  }

  return baseMessage;
}
