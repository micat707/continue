import { fetchwithRequestOptions } from "@continuedev/fetch";
import { ToolPolicy } from "@continuedev/terminal-security";
import {
  ChatMessage,
  ContextItem,
  IDE,
  PromptLog,
  Tool,
  ToolCall,
  ToolCallDelta,
} from "..";
import { ConfigHandler } from "../config/ConfigHandler";
import { CodebaseIndexer } from "../indexing/CodebaseIndexer";
import { applyToolOverrides } from "../tools/applyToolOverrides";
import { callTool } from "../tools/callTool";
import { safeParseToolCallArgs } from "../tools/parseArgs";
import { renderContextItems } from "../util/messageContent";

const DEFAULT_TOOL_POLICY: ToolPolicy = "allowedWithPermission";
const MAX_AGENT_ROUNDS = 8;

export type NativeAgentEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool-start"; toolCall: ToolCall }
  | { kind: "tool-complete"; toolCall: ToolCall; output: ContextItem[] }
  | { kind: "tool-error"; toolCall: ToolCall; message: string }
  | { kind: "tool-approval-required"; toolCall: ToolCall; policy: ToolPolicy }
  | { kind: "complete" };

function textContent(content: ChatMessage["content"]): string {
  return typeof content === "string"
    ? content
    : content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("");
}

function mergeToolCall(
  calls: Map<string, ToolCall>,
  delta: ToolCallDelta,
  fallbackId: string,
): ToolCall {
  const id = delta.id || fallbackId;
  const previous = calls.get(id);
  const currentName = previous?.function.name ?? "";
  const currentArgs = previous?.function.arguments ?? "";
  const nameDelta = delta.function?.name ?? "";
  const argsDelta = delta.function?.arguments ?? "";
  const name = nameDelta.startsWith(currentName)
    ? nameDelta
    : currentName.startsWith(nameDelta)
      ? currentName
      : currentName + nameDelta;
  const call: ToolCall = {
    id,
    type: "function",
    function: { name, arguments: currentArgs + argsDelta },
  };
  calls.set(id, call);
  return call;
}

function cannotRelaxPolicy(
  base: ToolPolicy,
  evaluated: ToolPolicy,
): ToolPolicy {
  if (base === "disabled") {
    return "disabled";
  }
  if (
    base === "allowedWithPermission" &&
    evaluated === "allowedWithoutPermission"
  ) {
    return "allowedWithPermission";
  }
  return evaluated;
}

export async function* streamAgentChat(
  configHandler: ConfigHandler,
  ide: IDE,
  codeBaseIndexer: CodebaseIndexer,
  abortController: AbortController,
  initialMessages: ChatMessage[],
): AsyncGenerator<NativeAgentEvent, PromptLog | undefined> {
  const { config } = await configHandler.loadConfig();
  const model = config?.selectedModelByRole.chat;
  if (!config || !model) {
    throw new Error("No chat model selected");
  }

  const tools = applyToolOverrides(config.tools, model.toolOverrides).tools;
  const conversation = [...initialMessages];

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (abortController.signal.aborted) {
      return undefined;
    }

    const completionOptions =
      model.capabilities?.tools === true && tools.length > 0 ? { tools } : {};
    const calls = new Map<string, ToolCall>();
    const assistant: ChatMessage = { role: "assistant", content: "" };
    const stream = model.streamChat(
      conversation,
      abortController.signal,
      completionOptions,
    );

    let next = await stream.next();
    while (!next.done) {
      if (abortController.signal.aborted) {
        await stream.return(undefined as never);
        return undefined;
      }

      const message = next.value;
      if (message.role === "thinking") {
        const text = textContent(message.content);
        if (text) yield { kind: "thinking", text };
      }
      if (message.role === "assistant") {
        const text = textContent(message.content);
        if (text) {
          assistant.content = textContent(assistant.content) + text;
          yield { kind: "text", text };
        }
        for (const delta of message.toolCalls ?? []) {
          const call = mergeToolCall(calls, delta, `native-tool-${calls.size}`);
          yield { kind: "tool-start", toolCall: call };
        }
      }
      next = await stream.next();
    }

    conversation.push({
      role: "assistant",
      content: assistant.content,
      ...(calls.size ? { toolCalls: [...calls.values()] } : {}),
    });

    if (calls.size === 0) {
      yield { kind: "complete" };
      return next.value;
    }

    let executedTool = false;
    for (const toolCall of calls.values()) {
      const tool = tools.find(
        (item) => item.function.name === toolCall.function.name,
      );
      if (!tool) {
        const message = `Tool ${toolCall.function.name} is not available in the active Continue profile.`;
        yield { kind: "tool-error", toolCall, message };
        conversation.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: message,
        });
        continue;
      }

      const parsedArgs = safeParseToolCallArgs(toolCall);
      let processedArgs = parsedArgs;
      try {
        processedArgs =
          (await tool.preprocessArgs?.(parsedArgs, { ide })) ?? parsedArgs;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield { kind: "tool-error", toolCall, message };
        conversation.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: `Invalid tool arguments: ${message}`,
        });
        continue;
      }

      const basePolicy = tool.defaultToolPolicy ?? DEFAULT_TOOL_POLICY;
      const evaluatedPolicy = tool.evaluateToolCallPolicy
        ? tool.evaluateToolCallPolicy(basePolicy, parsedArgs, processedArgs)
        : basePolicy;
      const policy = cannotRelaxPolicy(basePolicy, evaluatedPolicy);
      if (policy !== "allowedWithoutPermission") {
        yield { kind: "tool-approval-required", toolCall, policy };
        conversation.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: `Tool ${toolCall.function.name} requires user approval and was not executed.`,
        });
        continue;
      }

      const executableCall: ToolCall = {
        ...toolCall,
        function: {
          ...toolCall.function,
          arguments: JSON.stringify(processedArgs),
        },
      };
      try {
        const result = await callTool(tool, executableCall, {
          config,
          ide,
          llm: model,
          fetch: (url, init) =>
            fetchwithRequestOptions(url, init, config.requestOptions),
          tool,
          toolCallId: toolCall.id,
          codeBaseIndexer,
        });
        const output = result.contextItems;
        const message = result.errorMessage ?? renderContextItems(output);
        if (result.errorMessage) {
          yield { kind: "tool-error", toolCall, message: result.errorMessage };
        } else {
          executedTool = true;
          yield { kind: "tool-complete", toolCall, output };
        }
        conversation.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: message,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        yield { kind: "tool-error", toolCall, message };
        conversation.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: `Tool execution failed: ${message}`,
        });
      }
    }

    if (!executedTool) {
      yield { kind: "complete" };
      return undefined;
    }
  }

  throw new Error(`Agent stopped after ${MAX_AGENT_ROUNDS} tool rounds.`);
}
