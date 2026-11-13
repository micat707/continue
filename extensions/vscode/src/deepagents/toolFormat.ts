/**
 * Shared formatting for DeepAgent tool activity.
 *
 * Used by the standalone webview panel (which renders real cards) and by the
 * main-chat wrapper (which injects markdown blocks into the assistant stream).
 */

/** Markers around an injected tool block so it can be stripped from history. */
export const TOOL_BLOCK_START = "<!--deepagent-tool-->";
export const TOOL_BLOCK_END = "<!--/deepagent-tool-->";

/**
 * Result-fence body marking a tool call that has STARTED but not finished yet.
 * DeepAgentLLM emits a pending `execute` block the moment the call starts (so
 * the Run Command card appears immediately, not only after completion); the
 * GUI's rewrite drops it once the matching completed block arrives.
 */
export const TOOL_PENDING_MARKER = "__deepagent_running__";

/** Remove injected tool blocks from text before feeding it back to the model. */
export function stripToolBlocks(text: string): string {
  if (!text.includes(TOOL_BLOCK_START)) return text;
  return text.replace(
    /<!--deepagent-tool-->[\s\S]*?<!--\/deepagent-tool-->/g,
    "",
  );
}

export function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + "\n…(truncated)" : s;
}

/**
 * Truncate a tool result WITHOUT breaking a JSON envelope. The `execute` tool's
 * card payload is a single-line JSON string ({ output, exitCode, truncated });
 * cutting the whole string mid-JSON (plus appending the truncation marker)
 * makes JSON.parse fail in the GUI, which falls back to showing the RAW JSON
 * text in the Run Command card and paints it red (exitCode null). Instead,
 * truncate the inner `output` string and keep the envelope parseable.
 */
export function truncateForCard(s: string, max: number): string {
  if (s.length <= max) return s;
  if (s.startsWith("{")) {
    try {
      const parsed = JSON.parse(s) as Record<string, unknown>;
      if (typeof parsed.output === "string") {
        const output: string = parsed.output;
        // The `execute` card (it carries exitCode) mirrors Kiro's Run Command
        // truncation: keep a SMALL head (a few leading context lines) PLUS the
        // TAIL (BUILD SUCCESS/FAILURE, the final error, the summary table), and
        // omit the noisy middle. Other tools keep the tail only.
        if (parsed.exitCode !== undefined) {
          const headKeep = output.slice(0, 400);
          const tailKeep = output.slice(-(max - 60));
          const headNL = headKeep.lastIndexOf("\n");
          const tailNL = tailKeep.indexOf("\n");
          const head = headNL >= 0 ? headKeep.slice(headNL + 1) : headKeep;
          const tail = tailNL >= 0 ? tailKeep.slice(tailNL + 1) : tailKeep;
          const omitted = output.length - head.length - tail.length;
          parsed.output =
            `${head}\n\n…（中间约 ${omitted} 字符已省略，完整输出见终端）…\n\n` +
            tail;
        } else {
          // Budget for the output field: everything else (keys, exitCode, …)
          // stays intact, so subtract the non-output overhead from `max`.
          const overhead = s.length - output.length;
          const budget = Math.max(0, max - overhead);
          const omitted = output.length - budget;
          let tail = output.slice(-budget);
          const nl = tail.indexOf("\n");
          if (nl >= 0) tail = tail.slice(nl + 1);
          parsed.output =
            `…（前面约 ${omitted} 字符已省略，完整输出见终端）\n` + tail;
        }
        parsed.truncated = true;
        return JSON.stringify(parsed);
      }
    } catch {
      // Not a JSON envelope — fall through to plain truncation.
    }
  }
  return truncate(s, max);
}

/** Prevent injected content from terminating its own block early. */
function neutralizeMarkers(s: string): string {
  return s
    .split(TOOL_BLOCK_START)
    .join("‹tool-start›")
    .split(TOOL_BLOCK_END)
    .join("‹tool-end›");
}

/**
 * Render a tool result. deepagents' filesystem tools often return a LangChain
 * content-block array (`[{ type: "text", text: "…" }]`) or a plain string.
 */
export function formatToolOutput(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  // A LangChain ToolMessage (or its serialized `kwargs`) keeps the text in
  // `content`. Unwrap it before falling back to JSON — JSON.stringify would
  // escape the newlines in a unified diff and make it unrecognizable.
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    const kwargs = obj.kwargs as Record<string, unknown> | undefined;
    const content = obj.content ?? kwargs?.content;
    if (content !== undefined && content !== raw) {
      return formatToolOutput(content);
    }
  }
  if (Array.isArray(raw)) {
    if (raw.every((b) => b && typeof b === "object" && "text" in b)) {
      return (raw as { text?: string }[]).map((b) => b.text ?? "").join("");
    }
    if (raw.every((b) => typeof b === "string")) {
      return (raw as string[]).join("\n");
    }
  }
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/**
 * Normalize the `execute` tool result into the JSON envelope the GUI's
 * `CommandOutcomeCard` expects: `{ output, exitCode, truncated }`. The card
 * reads `exitCode` for its green/red status and, crucially, `truncateForCard`
 * keeps the TAIL of `output` — where BUILD SUCCESS/FAILURE and the final error
 * live — so the card never hides the command's conclusion.
 *
 * Supported shapes (any of: raw object, ToolMessage `.content`, or a JSON
 * STRING carrying the envelope — deepagents serializes our backend's
 * `{ output, exitCode, truncated }` into a string before it reaches us):
 *  1. Our workspaceBackend `execute` override → `{ output, exitCode, truncated }`.
 *  2. deepagents' own `execute` → HUMAN string
 *     "<output>\n[Command succeeded|failed with exit code N]".
 * Any other shape falls back to wrapping the whole output verbatim (still an
 * envelope, so the card keeps the tail instead of head-truncating).
 */
export function formatExecuteOutput(raw: unknown): string {
  const structured = resolveExecuteResult(raw);
  if (structured) {
    const out = structured.output ?? structured.content;
    const output =
      typeof out === "string"
        ? out
        : // non-string payload (rare) — serialize so it stays in the envelope
          formatToolOutput(out ?? "");
    const exitCode =
      typeof structured.exitCode === "number" ? structured.exitCode : null;
    const truncated = structured.truncated === true;
    return JSON.stringify({ output, exitCode, truncated });
  }

  const str = formatToolOutput(raw);
  if (typeof str !== "string") return str;
  const m = str.match(
    /\[Command (?:succeeded|failed) with exit code (-?\d+)\]\s*$/,
  );
  if (m) {
    const code = Number(m[1]);
    const output = str.slice(0, m.index).replace(/\s+$/, "");
    return JSON.stringify({ output, exitCode: code, truncated: false });
  }
  // No recognizable status line — still wrap verbatim so the card keeps the
  // TAIL (the command's conclusion) rather than head-truncating it.
  return JSON.stringify({ output: str, exitCode: null, truncated: false });
}

/**
 * Pull a structured `{ output, exitCode, truncated }` out of the `execute`
 * result, tolerating the several shapes deepagents may hand us:
 *  - a plain object
 *  - a LangChain ToolMessage whose `.content` is either the object or a JSON
 *    STRING (deepagents serializes our backend's structured response)
 *  - a bare JSON STRING carrying the envelope
 */
function resolveExecuteResult(
  raw: unknown,
): { output?: unknown; exitCode?: unknown; truncated?: unknown } | undefined {
  const objs: Record<string, unknown>[] = [];
  const strings: string[] = [];
  const consider = (v: unknown) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      objs.push(v as Record<string, unknown>);
    } else if (typeof v === "string") {
      strings.push(v);
    }
  };
  consider(raw);
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    consider((raw as Record<string, unknown>).content);
  }
  for (const s of strings) {
    try {
      const j = JSON.parse(s);
      if (j && typeof j === "object" && !Array.isArray(j)) {
        objs.push(j as Record<string, unknown>);
      }
    } catch {
      // not JSON — leave it as a plain string candidate
    }
  }
  for (const o of objs) {
    if (o.output !== undefined || o.exitCode !== undefined) return o;
  }
  return undefined;
}

/** Safely stringify a tool call's input. */
export function formatToolInput(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  try {
    return JSON.stringify(raw, null, 2);
  } catch {
    return String(raw);
  }
}

/** Fenced block that won't break if the content itself contains backticks. */
function fence(content: string, lang = ""): string {
  const longest = Math.max(
    0,
    ...[...content.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}${lang}\n${content}\n${marker}`;
}

/**
 * Build a markdown block describing one tool call and its result, suitable for
 * injection into Continue's main chat. Wrapped in HTML comments (invisible in
 * most markdown renderers) so `stripToolBlocks` can remove it from history.
 */
export function formatToolBlock(
  name: string,
  input: string,
  output: string,
  maxOutput = 2000,
): string {
  const safeInput = neutralizeMarkers(input.trim());
  const safeOutput = neutralizeMarkers(output.trim());
  const args = safeInput
    ? fence(truncate(safeInput, 1000), "json")
    : "_(no arguments)_";
  // edit_file carries a real unified diff (up to ~4k chars). Keep it intact so
  // the GUI can turn the tool block into an edit outcome card. execute output can
  // be long; give it a bigger budget so more of the TAIL (BUILD SUCCESS/FAILURE,
  // the final error) survives truncateForCard's tail-keeping.
  const cap =
    name === "edit_file"
      ? Math.max(maxOutput, 6000)
      : name === "execute"
        ? Math.max(maxOutput, 4000)
        : maxOutput;
  const result = safeOutput
    ? fence(truncateForCard(safeOutput, cap))
    : "_(empty)_";
  return (
    `\n\n${TOOL_BLOCK_START}\n` +
    `**Tool: \`${name}\`**\n\n` +
    `${args}\n\n` +
    `**Result**\n\n${result}\n` +
    `${TOOL_BLOCK_END}\n\n`
  );
}
