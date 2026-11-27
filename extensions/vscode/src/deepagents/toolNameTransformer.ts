import { StreamChannel, type StreamTransformer } from "@langchain/langgraph";

/**
 * Kiro-aligned authoritative tool-name channel.
 *
 * LangChain's built-in `run.toolCalls` projection derives the tool name from
 * `content-block-finish`, whose `cb.name` gets corrupted into ""/"unknown"/
 * "function" when streaming `tool_call_chunks` lose the name fragment.
 *
 * Kiro never has this problem because its `tool_call` event carries `toolName`
 * straight from `on_tool_start`. We replicate that by registering a custom
 * `StreamTransformer` that listens to the SAME `tool-started` event
 * (`event.params.data.tool_name`, sourced from `on_tool_start`'s `p8.name`)
 * and publishes `{ callId, name }` on `run.extensions.toolNames`.
 *
 * NOTE: we deliberately do NOT filter by namespace — subagent tools must be
 * captured too (exactly the flat-tag model Kiro uses for SubtaskToolCall).
 */
export interface ToolNameEntry {
  callId: string;
  name: string;
  namespace: string[];
}

export interface ToolNamesProjection {
  toolNames: StreamChannel<ToolNameEntry>;
}

export function createToolNameTransformer(): StreamTransformer<ToolNamesProjection> {
  const toolNames = StreamChannel.local<ToolNameEntry>();
  return {
    init: () => ({ toolNames }),
    process: (event: any) => {
      if (event?.method !== "tools") return true;
      const data = event.params?.data;
      if (!data || data.event !== "tool-started") return true;
      const callId = data.tool_call_id;
      const name = data.tool_name;
      if (typeof callId !== "string" || callId.length === 0) return true;
      if (typeof name !== "string" || name.length === 0) return true;
      toolNames.push({
        callId,
        name,
        namespace: Array.isArray(event.params?.namespace)
          ? [...event.params.namespace]
          : [],
      });
      return true;
    },
  };
}
