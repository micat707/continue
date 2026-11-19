import {
  ChatHistoryItem,
  ChatMessage,
  ContextItemWithId,
  RuleMetadata,
  RuleWithSource,
  TextMessagePart,
  ToolResultChatMessage,
  UserChatMessage,
} from "core";
import { chatMessageIsEmpty } from "core/llm/messages";
import { getSystemMessageWithRules } from "core/llm/rules/getSystemMessageWithRules";
import { RulePolicies } from "core/llm/rules/types";
import { BuiltInToolNames } from "core/tools/builtIn";
import {
  CANCELLED_TOOL_CALL_MESSAGE,
  ERRORED_TOOL_CALL_OUTPUT_MESSAGE,
  NO_TOOL_CALL_OUTPUT_MESSAGE,
} from "core/tools/constants";
import { convertToolCallStatesToSystemCallsAndOutput } from "core/tools/systemMessageTools/convertSystemTools";
import { SystemMessageToolsFramework } from "core/tools/systemMessageTools/types";
import { findLast, findLastIndex } from "core/util/findLast";
import {
  contextItemContentToText,
  normalizeToMessageParts,
  renderContextItems,
  renderContextItemsWithStatus,
} from "core/util/messageContent";
import { toolCallStateToContextItems } from "../../pages/gui/ToolCallDiv/utils";

// Helper function to render context items and append status information
// Helper function to render context items and append status information

interface MessageWithContextItems {
  ctxItems: ContextItemWithId[];
  message: ChatMessage;
}
export function constructMessages(
  history: ChatHistoryItem[],
  baseSystemMessage: string | undefined,
  availableRules: RuleWithSource[],
  rulePolicies: RulePolicies,
  useSystemToolsFramework?: SystemMessageToolsFramework,
  /** Kiro-style system-level environment blocks (<system_information>, <session_start_snapshot>, etc.) */
  environmentContext?: string,
  /** Names of currently open editor files, rendered into the last user message's <EnvironmentContext> */
  openEditorFiles?: string[],
  /** Path of the active editor file (name-only entry when no content item exists) */
  activeEditorFileName?: string,
): {
  messages: ChatMessage[];
  appliedRules: RuleMetadata[];
  appliedRuleIndex: number;
} {
  // Find the most recent conversation summary and filter history accordingly
  let summaryContent = "";
  let filteredHistory = history;

  for (let i = history.length - 1; i >= 0; i--) {
    const summary = history[i].conversationSummary;
    if (summary) {
      summaryContent = summary;
      // Only include messages that come AFTER the message with the summary
      filteredHistory = history.slice(i + 1);
      break;
    }
  }

  const historyCopy = [...filteredHistory];

  // Kiro sends environment context (open editor files, active editor file)
  // only on the current (last) user message - earlier turns keep their
  // original rendering.
  const lastUserHistoryIdx = findLastIndex(
    historyCopy,
    (item) => item.message.role === "user",
  );

  const msgs: MessageWithContextItems[] = [];
  let appliedRuleIndex = -1;
  let index = -1;
  for (const item of historyCopy) {
    index++;
    if (
      item.message.role === "system" ||
      item.message.role === "tool" ||
      chatMessageIsEmpty(item.message)
    ) {
      // Tool messages will be re-inserted
      continue;
    }

    if (item.message.role === "user") {
      appliedRuleIndex = index;
      // Gather context items for user messages
      let content = normalizeToMessageParts(item.message);

      // Kiro-style: the auto-injected "Active file" item is moved into an
      // <EnvironmentContext> block appended AFTER the user text (last user
      // message only); other context items stay prepended code blocks.
      const isLastUserMessage = index === lastUserHistoryIdx;
      const activeFileItems = isLastUserMessage
        ? item.contextItems.filter((c) => c.name?.startsWith("Active file"))
        : [];
      const normalItems = item.contextItems.filter(
        (c) => !activeFileItems.includes(c),
      );

      const ctxItemParts = normalItems
        .map((ctxItem) => {
          return {
            type: "text",
            text: `${contextItemContentToText(ctxItem.content)}\n`,
          } as TextMessagePart;
        })
        .filter((part) => !!part.text.trim());

      content = [...ctxItemParts, ...content];

      const envSuffix = isLastUserMessage
        ? buildUserEnvironmentContext(
            activeFileItems,
            openEditorFiles ?? [],
            activeEditorFileName,
          )
        : "";
      if (envSuffix) {
        content = [
          ...content,
          { type: "text", text: envSuffix } as TextMessagePart,
        ];
      }

      msgs.push({
        ctxItems: item.contextItems,
        message: {
          ...item.message,
          content,
        },
      });
    } else if (item.message.role === "thinking") {
      msgs.push({
        ctxItems: item.contextItems,
        message: item.message,
      });
    } else if (item.message.role === "assistant") {
      // When using system message tools, convert tool calls/states to text content
      if (item.toolCallStates?.length && useSystemToolsFramework) {
        const { userMessage, assistantMessage } =
          convertToolCallStatesToSystemCallsAndOutput(
            item.message,
            item.toolCallStates ?? [],
            useSystemToolsFramework,
          );
        msgs.push({
          message: assistantMessage,
          ctxItems: [],
        });
        msgs.push({
          message: userMessage,
          ctxItems: [],
        });
        continue;
      }

      msgs.push({
        ctxItems: item.contextItems,
        message: item.message,
      });

      // Add a tool message for each tool call
      if (item.toolCallStates?.length) {
        // If the assistant message has tool calls, we need to insert tool messages
        for (const toolCallState of item.toolCallStates) {
          const { output, status, toolCall } = toolCallState;
          let content: string = NO_TOOL_CALL_OUTPUT_MESSAGE;

          if (status === "canceled") {
            content = CANCELLED_TOOL_CALL_MESSAGE;
          } else if (output) {
            if (
              toolCall.function?.name == BuiltInToolNames.RunTerminalCommand
            ) {
              // Add status for tools containing detailed status outcomes per context item
              content = renderContextItemsWithStatus(output);
            } else {
              content = renderContextItems(output);
            }
          } else if (toolCallState.status === "errored") {
            content = ERRORED_TOOL_CALL_OUTPUT_MESSAGE;
          }

          msgs.push({
            ctxItems: toolCallStateToContextItems(toolCallState),
            message: {
              role: "tool",
              content,
              toolCallId: toolCall.id!,
            },
          });
        }
      } else if (item.toolCallStates && item.toolCallStates.length > 0) {
        // This case indicates a potential mismatch - we have tool call states but no message.toolCalls
        console.error(
          "ERROR constructMessages: Assistant message has toolCallStates but no message.toolCalls:",
          {
            toolCallStates: item.toolCallStates.length,
            toolCallIds: item.toolCallStates.map((s) => s.toolCallId),
            messageContent:
              typeof item.message.content === "string"
                ? item.message.content?.substring(0, 50) + "..."
                : "Non-string content",
          },
        );
      }
    }
  }

  // Some rules only apply to the last user or tool message
  const lastUserOrToolMsg = findLast(
    msgs,
    (item) => item.message.role === "user" || item.message.role === "tool",
  )?.message as UserChatMessage | ToolResultChatMessage;

  // Some rules apply to all context items since the last user message, inclusiv
  const lastUserMsgIndex = findLastIndex(
    msgs,
    (item) => item.message.role === "user",
  );
  const itemsBackToLastUserMessage = msgs
    .slice(lastUserMsgIndex, msgs.length)
    .filter(
      (item) => item.message.role === "tool" || item.message.role === "user",
    );
  const rulesContextItems = itemsBackToLastUserMessage
    .map((item) => item.ctxItems)
    .flat();

  // Kiro-style rules injection (mirrors kiro_session.log): rules are NOT
  // appended to the system prompt. Instead they are delivered as the first
  // conversation turn - a user message carrying the wrapped rule blocks,
  // followed by a synthetic assistant acknowledgement - and only then does
  // the real user message follow.
  const { systemMessage: rulesMessage, appliedRules } =
    getSystemMessageWithRules({
      baseSystemMessage: undefined,
      availableRules,
      userMessage: lastUserOrToolMsg,
      contextItems: rulesContextItems,
      rulePolicies,
    });

  // The base system prompt stays a proper system message; Kiro-style
  // environment blocks (<system_information>, <session_start_snapshot>, ...)
  // are appended to it, and the conversation summary comes last.
  let finalSystemMessage = baseSystemMessage ?? "";
  if (environmentContext?.trim()) {
    finalSystemMessage = finalSystemMessage
      ? `${finalSystemMessage}\n\n${environmentContext}`
      : environmentContext;
  }
  if (summaryContent) {
    finalSystemMessage = finalSystemMessage
      ? `${finalSystemMessage}\n\nPrevious conversation summary:\n\n ${summaryContent}`
      : `Previous conversation summary:\n\n ${summaryContent}`;
  }

  if (finalSystemMessage.trim()) {
    msgs.unshift({
      ctxItems: [],
      message: {
        role: "system",
        content: finalSystemMessage,
      },
    });
  }

  if (rulesMessage.trim()) {
    const insertAt = finalSystemMessage.trim() ? 1 : 0;
    msgs.splice(
      insertAt,
      0,
      {
        ctxItems: [],
        message: {
          role: "user",
          content: rulesMessage,
        },
      },
      {
        ctxItems: [],
        message: {
          role: "assistant",
          content: "I will follow these instructions.",
        },
      },
    );
  }

  const messages = msgs
    .map((m) => m.message)
    .map((message) => sanitizeMessageContent(message));

  return {
    messages,
    appliedRules,
    appliedRuleIndex,
  };
}

/** file:///d%3A/a/b.ts -> d:/a/b.ts ; POSIX paths keep their leading slash */
function uriToDisplayPath(uri: string): string {
  if (!uri.startsWith("file://")) {
    return uri;
  }
  let p = decodeURIComponent(uri.replace(/^file:\/\//, ""));
  // Windows file URIs keep a leading slash before the drive letter (/d:/...)
  if (/^\/[a-zA-Z]%3A\//.test(p) || /^\/[a-zA-Z]:\//.test(p)) {
    p = p.replace(/^\//, "");
  }
  return p;
}

/**
 * Builds the Kiro-style <EnvironmentContext> block appended to the last user
 * message (mirrors Kiro's currentMessage EnvironmentContext): open editor
 * file names plus the active editor file (name + content).
 */
function buildUserEnvironmentContext(
  activeFileItems: ContextItemWithId[],
  openEditorFiles: string[],
  activeEditorFileName?: string,
): string {
  const sections: string[] = [];

  if (openEditorFiles.length > 0) {
    const files = openEditorFiles
      .map((f) => `<file name="${uriToDisplayPath(f)}" />`)
      .join("\n");
    sections.push(`<OPEN-EDITOR-FILES>\n${files}\n</OPEN-EDITOR-FILES>`);
  }

  for (const item of activeFileItems) {
    const fileName = item.uri?.value ?? item.name ?? "unknown";
    const raw =
      typeof item.content === "string"
        ? item.content
        : contextItemContentToText(item.content);
    // Keep only the code block from the provider content (drop its prefix)
    const codeBlockIdx = raw.indexOf("```");
    const body = codeBlockIdx >= 0 ? raw.slice(codeBlockIdx) : raw;
    sections.push(
      `<ACTIVE-EDITOR-FILE>\n<file name="${uriToDisplayPath(fileName)}" />\n\n${body}\n</ACTIVE-EDITOR-FILE>`,
    );
  }

  // Agent/DeepAgent modes don't auto-inject the current file's content, but
  // Kiro still lists the active editor file NAME in EnvironmentContext.
  if (activeFileItems.length === 0 && activeEditorFileName) {
    sections.push(
      `<ACTIVE-EDITOR-FILE>\n<file name="${uriToDisplayPath(activeEditorFileName)}" />\n</ACTIVE-EDITOR-FILE>`,
    );
  }

  if (sections.length === 0) {
    return "";
  }

  return `<EnvironmentContext>
This information is provided as context about the user environment. Only consider it if it's relevant to the user request; ignore it otherwise.

${sections.join("\n\n")}
</EnvironmentContext>`;
}

/**
 * Last line of defense: guarantee that every message's text content is a real
 * string before it is sent to the model.
 *
 * If any upstream source (context items, restored history, tool outputs) hands
 * us an object instead of a string, `toChatMessage` joins it with `String(...)`
 * and the model receives the literal "[object Object]" instead of the user's
 * message. Coercing here keeps the prompt sane and logs the offending value so
 * the real source can be tracked down.
 */
function sanitizeMessageContent(message: ChatMessage): ChatMessage {
  const content = message.content as unknown;

  if (typeof content === "string") {
    return message;
  }

  if (content == null) {
    return { ...message, content: "" } as ChatMessage;
  }

  if (Array.isArray(content)) {
    const safeParts = content.map((part: any) => {
      if (part?.type !== "text" || typeof part.text === "string") {
        return part;
      }
      console.warn(
        "[constructMessages] Non-string text part coerced:",
        message.role,
        part.text,
      );
      return { ...part, text: contextItemContentToText(part.text) };
    });
    return { ...message, content: safeParts } as ChatMessage;
  }

  console.warn(
    "[constructMessages] Non-string/array message content coerced:",
    message.role,
    content,
  );
  return {
    ...message,
    content: contextItemContentToText(content),
  } as ChatMessage;
}
