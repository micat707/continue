/**
 * Qwen3.5 thinking occasionally serializes a tool call as XML inside the
 * reasoning stream instead of emitting a real provider tool_call. That text is
 * then surfaced in the GUI's "deep thinking" block and looks like a bogus tool
 * invocation (e.g. `<tool_call><function=create_artifact>...`).
 *
 * Put this in every DeepAgent system prompt so the model uses the native tool
 * calling channel only. Keep it short and explicit: reasoning is not a tool
 * channel, and XML tool calls are not executable.
 */
export const NATIVE_TOOL_CALL_RULE = `
<tool_call_protocol>
CRITICAL: You MUST invoke tools ONLY through the provider's native tool_calls / function-calling channel.

Never write tool calls as plain text or XML. In particular, NEVER output any of these in the final answer, in reasoning, in thinking, or in any assistant message:

<tool_call>
<function=NAME>
<parameter=ARG>
...
</parameter>
</function>
</tool_call>

They are NOT tool calls. They are plain text, will NOT be executed, and will be shown to the user as garbage.

When you need a tool, emit a native tool_call with the exact tool name and JSON arguments. If native tool calls are unavailable, explain the limitation in normal text instead of faking a tool call.
</tool_call_protocol>`.trim();

/**
 * When the user asks to read/show a file and the model is echoing the file's
 * original content verbatim, require an explicit language on the markdown
 * fence. A bare fence (or no fence at all) makes the GUI treat the content as
 * a runnable one-line terminal command, which produces a bogus "Run" button.
 * If the language cannot be inferred from the path, `text` is the safe fallback.
 */
export const FILE_CONTENT_DISPLAY_RULE = `
<file_content_display>
When the user asks to read, show, or display a file and you are returning that file's original/unmodified content verbatim, wrap the content in a fenced markdown code block whose info string is the file's language identifier inferred from the file extension (for example \`java\`, \`typescript\`, \`python\`, \`json\`, \`xml\`).

If the language cannot be determined from the file path or extension, use \`text\` as the info string. ALWAYS include an explicit language identifier — a bare fence with no language is not acceptable for verbatim file content.

This rule applies ONLY when echoing a file's original content. Do not use it for short answers, explanations, summaries, or code you author yourself.
</file_content_display>`.trim();
