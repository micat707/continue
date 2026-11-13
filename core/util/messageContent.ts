import {
  ChatMessage,
  ContextItem,
  MessageContent,
  MessagePart,
  TextMessagePart,
} from "../index";

export function stripImages(messageContent: MessageContent): string {
  if (typeof messageContent === "string") {
    return messageContent;
  }

  return messageContent
    .filter((part) => part.type === "text")
    .map((part) => (part as TextMessagePart).text)
    .join("\n");
}

export function renderChatMessage(message: ChatMessage): string {
  switch (message?.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
      return stripImages(message.content);
    case "tool":
      return message.content;
    default:
      return "";
  }
}

/**
 * Coerce a context item's `content` into plain text.
 *
 * `ContextItem.content` is typed as `string`, but context items can arrive from
 * providers/webviews where `content` is actually a `MessagePart[]` (or some
 * other object). Interpolating those with `${content}` produces the infamous
 * "[object Object]", which then gets sent to the model as if it were the user's
 * message. This gives every call site one safe conversion.
 */
export function contextItemContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "string"
          ? part
          : typeof (part as TextMessagePart)?.text === "string"
            ? (part as TextMessagePart).text
            : "",
      )
      .join("");
  }
  if (content == null) {
    return "";
  }
  if (typeof content === "object") {
    // A stray MessagePart (or similar) — prefer its text over raw JSON.
    const maybeText = (content as { text?: unknown }).text;
    if (typeof maybeText === "string") {
      return maybeText;
    }
    try {
      return JSON.stringify(content);
    } catch {
      return "";
    }
  }
  return String(content);
}

export function renderContextItems(contextItems: ContextItem[]): string {
  return contextItems
    .map((item) => contextItemContentToText(item.content))
    .join("\n\n");
}

export function renderContextItemsWithStatus(contextItems: any[]): string {
  return contextItems
    .map((item) => {
      let result = contextItemContentToText(item.content);

      // If this item has a status, append it directly after the content
      if (item.status) {
        result += `\n[Status: ${item.status}]`;
      }

      return result;
    })
    .join("\n\n");
}

export function normalizeToMessageParts(message: ChatMessage): MessagePart[] {
  switch (message.role) {
    case "user":
    case "assistant":
    case "thinking":
    case "system":
      return Array.isArray(message.content)
        ? message.content
        : [{ type: "text", text: message.content }];
    case "tool":
      return [{ type: "text", text: message.content }];
  }
}
