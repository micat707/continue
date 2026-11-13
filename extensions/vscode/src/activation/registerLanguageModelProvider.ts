/**
 * Connect the forked VS Code native Chat surface to the single Continue Core
 * instance created by VsCodeExtension. This replaces the former independent
 * HTTP/SSE client, so native Chat uses Continue's selected chat model and
 * normal configuration lifecycle.
 */

import type { ChatMessage } from "core";
import { v4 as uuidv4 } from "uuid";
import * as vscode from "vscode";
import type { VsCodeExtension } from "../extension/VsCodeExtension";

type NativeChatMessage = {
  role?: unknown;
  content?: unknown;
};

type ContinueRuntime = Promise<VsCodeExtension>;

async function resolveRuntime(
  runtime: ContinueRuntime,
): Promise<VsCodeExtension> {
  return await runtime;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part;
      }
      if (part && typeof (part as { value?: unknown }).value === "string") {
        return (part as { value: string }).value;
      }
      if (part && typeof (part as { text?: unknown }).text === "string") {
        return (part as { text: string }).text;
      }
      return "";
    })
    .join("");
}

function toContinueMessages(
  messages: readonly NativeChatMessage[],
): ChatMessage[] {
  const userRole = (vscode as any).LanguageModelChatMessageRole?.User;

  return messages
    .map((message) => {
      const role =
        message.role === userRole || message.role === "user"
          ? "user"
          : message.role === "system"
            ? "system"
            : "assistant";
      const content = textFromContent(message.content);
      return { role, content } as ChatMessage;
    })
    .filter((message) => textFromContent(message.content).length > 0);
}

function textFromContinueMessage(message: ChatMessage): string {
  return textFromContent(message.content);
}

/** Show useful diagnostics without leaking bearer tokens, API keys, or stacks. */
function userSafeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key\s*[:=]\s*)[^\s,]+/gi, "$1[REDACTED]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]");
}

async function streamNativeChat(
  runtime: ContinueRuntime,
  messages: ChatMessage[],
  requestId: string,
  token: vscode.CancellationToken,
  onText: (text: string) => void,
): Promise<void> {
  const continueExtension = await resolveRuntime(runtime);
  const cancellation = token.onCancellationRequested(() => {
    continueExtension.abortNativeChat(requestId);
  });

  try {
    // `InProcessMessenger` returns the protocol's async generator at runtime.
    // Cast at this UI boundary to avoid TypeScript collapsing the generated
    // protocol tuple across the extension/core project boundary to `never`.
    const nativeChat = continueExtension.streamNativeChat as unknown as (
      nativeMessages: ChatMessage[],
      nativeRequestId: string,
    ) => AsyncGenerator<ChatMessage>;
    const stream = nativeChat(messages, requestId);
    for await (const message of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      if (message.role === "assistant") {
        const text = textFromContinueMessage(message);
        if (text) {
          onText(text);
        }
      }
    }
  } finally {
    cancellation.dispose();
  }
}

async function streamNativeAgentChat(
  runtime: ContinueRuntime,
  messages: ChatMessage[],
  requestId: string,
  token: vscode.CancellationToken,
  response: any,
): Promise<void> {
  const continueExtension = await resolveRuntime(runtime);
  const cancellation = token.onCancellationRequested(() => {
    continueExtension.abortNativeChat(requestId);
  });

  try {
    const stream = continueExtension.streamNativeAgentChat(messages, requestId);
    for await (const event of stream) {
      if (token.isCancellationRequested) {
        break;
      }

      switch (event.kind) {
        case "text":
          response.markdown(event.text);
          break;
        case "thinking":
          response.thinkingProgress({ id: requestId, text: event.text });
          break;
        case "tool-start": {
          const tool = new (vscode as any).ChatToolInvocationPart(
            event.toolCall.function.name,
            event.toolCall.id,
          );
          tool.invocationMessage = `Preparing ${event.toolCall.function.name}`;
          tool.enablePartialUpdate = true;
          response.push(tool);
          break;
        }
        case "tool-complete": {
          const tool = new (vscode as any).ChatToolInvocationPart(
            event.toolCall.function.name,
            event.toolCall.id,
          );
          tool.invocationMessage = `Ran ${event.toolCall.function.name}`;
          tool.pastTenseMessage = `Ran ${event.toolCall.function.name}`;
          tool.isComplete = true;
          tool.isConfirmed = true;
          tool.enablePartialUpdate = true;
          tool.toolSpecificData = {
            input: event.toolCall.function.arguments,
            output: event.output.map((item) => item.content).join("\n\n"),
          };
          response.push(tool);
          break;
        }
        case "tool-approval-required": {
          const tool = new (vscode as any).ChatToolInvocationPart(
            event.toolCall.function.name,
            event.toolCall.id,
          );
          tool.invocationMessage = `${event.toolCall.function.name} requires approval`;
          tool.pastTenseMessage = `${event.toolCall.function.name} was not run`;
          tool.isComplete = true;
          tool.isError = true;
          tool.enablePartialUpdate = true;
          tool.toolSpecificData = {
            input: event.toolCall.function.arguments,
            output: `Continue policy is ${event.policy}; native approval/resume will be added before this tool can run.`,
          };
          response.push(tool);
          break;
        }
        case "tool-error": {
          const tool = new (vscode as any).ChatToolInvocationPart(
            event.toolCall.function.name,
            event.toolCall.id,
            event.message,
          );
          tool.invocationMessage = `${event.toolCall.function.name} failed`;
          tool.isComplete = true;
          tool.isError = true;
          tool.enablePartialUpdate = true;
          tool.toolSpecificData = {
            input: event.toolCall.function.arguments,
            output: event.message,
          };
          response.push(tool);
          break;
        }
      }
    }
  } finally {
    cancellation.dispose();
  }
}

class MicatLanguageModelProvider {
  constructor(private readonly continueRuntime: ContinueRuntime) {}

  provideLanguageModelChatInformation(): any[] {
    return [
      {
        id: "micatcode.continue.chat",
        name: "MicatCode AI",
        family: "micatcode",
        version: "continue-core",
        maxInputTokens: 128000,
        maxOutputTokens: 8192,
        // Native tool brokering is a later integration step. Continue Core's
        // model may support tools, but this bridge does not yet expose them to
        // VS Code's native tool contract.
        capabilities: { toolCalling: false },
        isDefault: true,
        isUserSelectable: true,
        isBYOK: true,
      },
    ];
  }

  async provideLanguageModelChatResponse(
    _model: unknown,
    messages: readonly NativeChatMessage[],
    _options: unknown,
    progress: { report(part: unknown): void },
    token: vscode.CancellationToken,
  ): Promise<void> {
    const requestId = uuidv4();
    try {
      await streamNativeChat(
        this.continueRuntime,
        toContinueMessages(messages),
        requestId,
        token,
        (text) =>
          progress.report(new (vscode as any).LanguageModelTextPart(text)),
      );
    } catch (error) {
      const detail = userSafeError(error);
      console.error("MicatCode: native language model request failed", error);
      progress.report(
        new (vscode as any).LanguageModelTextPart(
          `## MicatCode Chat request failed\n\n\`${detail}\`\n\n` +
            "Check **Output → Extension Host** for the full stack trace. " +
            "Confirm that Continue Core is ready and that the active `config.yaml` has a `chat` model.",
        ),
      );
    }
  }

  async provideTokenCount(_model: unknown, value: unknown): Promise<number> {
    return Math.ceil(textFromContent(value).length / 4);
  }
}

export function registerLanguageModelProvider(
  context: vscode.ExtensionContext,
  continueRuntime: ContinueRuntime,
): void {
  try {
    const provider = (vscode as any).lm.registerLanguageModelChatProvider(
      "micatcode",
      new MicatLanguageModelProvider(continueRuntime),
    );
    context.subscriptions.push(provider);
  } catch (error) {
    console.error(
      "MicatCode: could not register language model provider",
      error,
    );
  }

  try {
    const participant = (vscode as any).chat.createChatParticipant(
      "micatcode.chat",
      async (
        request: { prompt: string },
        _chatContext: unknown,
        response: { markdown(value: string | vscode.MarkdownString): void },
        token: vscode.CancellationToken,
      ) => {
        const requestId = uuidv4();
        try {
          await streamNativeAgentChat(
            continueRuntime,
            [{ role: "user", content: request.prompt } as ChatMessage],
            requestId,
            token,
            response,
          );
        } catch (error) {
          const detail = userSafeError(error);
          console.error("MicatCode: native participant request failed", error);
          response.markdown(
            `## MicatCode request failed\n\n\`${detail}\`\n\n` +
              "Check **Output → Extension Host** for the full stack trace. " +
              "Confirm that Continue Core is ready and that the active `config.yaml` has a `chat` model.",
          );
          return;
        }
      },
    );
    participant.isSticky = false;
    context.subscriptions.push(participant);
  } catch (error) {
    console.error("MicatCode: could not register Chat participant", error);
  }
}
