/**
 * Turns successful deepagents tool blocks injected by DeepAgentLLM into fenced
 * card blocks that StyledMarkdownPreview renders as Kiro-style outcome cards:
 *
 *   str_replace / edit_file -> ```editcard``` -> EditOutcomeCard
 *   read_file / read_files   -> ```readcard``` -> ReadOutcomeCard
 *   execute_pwsh / execute   -> ```commandcard``` -> CommandOutcomeCard
 *
 * DeepAgentLLM injects tool activity as markdown wrapped in HTML comments so
 * it can be stripped from history on the next turn. remark-rehype drops HTML
 * comments, so this rewrite has to happen on the source string, before parsing.
 *
 * Failed calls are deliberately left alone so their error text stays visible
 * as a normal markdown tool block.
 */

/** Must be a single word: getLanguageFromClassName splits on "-". */
export const EDIT_CARD_LANGUAGE = "editcard";
export const READ_CARD_LANGUAGE = "readcard";
export const COMMAND_CARD_LANGUAGE = "commandcard";

const BLOCK_RE = /<!--deepagent-tool-->([\s\S]*?)<!--\/deepagent-tool-->/g;
// Fallbacks for when streaming chunk boundaries split the HTML comment marker.
// formatToolBlock's structure is fixed: tool heading -> json fence -> Result
// -> output fence (the opening and closing fence markers have equal length).
const EDIT_BLOCK_RE =
  /\*\*Tool: `(?:edit_file|str_replace|fs_write|fs_append)`\*\*[\s\S]*?\*\*Result\*\*\s*\n+(`{3,})[^\n]*\n[\s\S]*?\1/g;
const READ_BLOCK_RE =
  /\*\*Tool: `(?:read_file|read_files)`\*\*[\s\S]*?\*\*Result\*\*\s*\n+(`{3,})[^\n]*\n[\s\S]*?\1/g;
const COMMAND_BLOCK_RE =
  /\*\*Tool: `(?:execute|execute_pwsh|execute_bash)`\*\*[\s\S]*?\*\*Result\*\*\s*\n+(`{3,})[^\n]*\n[\s\S]*?\1/g;

export interface EditCardPayload {
  filePath: string;
  result: string;
}

/** Unescape a JSON string literal captured from the args fence. */
function unescapeJsonString(raw: string): string {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
}

/** Our tools use `path`; Kiro legacy blocks used `file_path`. */
function extractFilePath(body: string): string {
  const raw = /"(?:file_path|path|targetFile)"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(
    body,
  )?.[1];
  if (raw !== undefined) return unescapeJsonString(raw);

  // read_files passes an array; showing the first path keeps the card compact.
  const array = /"paths"\s*:\s*\[([\s\S]*?)\]/.exec(body)?.[1];
  const first = array ? /"((?:[^"\\]|\\.)*)"/.exec(array)?.[1] : undefined;
  return first !== undefined ? unescapeJsonString(first) : "";
}

function hasToolHeading(body: string, names: string[]): boolean {
  return names.some((name) => body.includes(`**Tool: \`${name}\`**`));
}

/** Shared "heading -> fenced output" extraction used by both block parsers. */
function extractResultFence(body: string): string | undefined {
  const resultHeading = body.indexOf("**Result**");
  if (resultHeading < 0) return undefined;

  const afterHeading = body.slice(resultHeading + "**Result**".length);
  const fenceHead = /^\s*`{3,}[^\n]*\n/.exec(afterHeading);
  if (!fenceHead) return undefined;
  return afterHeading
    .slice(fenceHead[0].length)
    .replace(/`{3,}\s*$/, "")
    .trimEnd();
}

function parseEditFileBlock(body: string): EditCardPayload | undefined {
  if (
    !hasToolHeading(body, ["edit_file", "str_replace", "fs_write", "fs_append"])
  ) {
    return undefined;
  }

  const rawPath = extractFilePath(body);
  const result = extractResultFence(body);

  // Only successful edits carry the backend's real unified diff.
  if (!result || !result.includes("--- a/")) return undefined;
  return { filePath: rawPath, result };
}

export interface ReadCardPayload {
  filePath: string;
  /** 1-based inclusive range from the backend's status header, e.g. 566-695. */
  lines?: { start: number; end: number };
}

function parseReadFileBlock(body: string): ReadCardPayload | undefined {
  if (!hasToolHeading(body, ["read_file", "read_files"])) return undefined;

  const rawPath = extractFilePath(body);
  const result = extractResultFence(body);

  // Errors stay as plain markdown (same policy as failed edits).
  if (!result || result.startsWith("Error")) return undefined;

  // The filesystem backend prefixes read_file output with a status header
  // ("@@ lines A-B of T @@", optionally preceded by a bracketed truncation /
  // offset-clamp notice). The card only surfaces the line RANGE (Kiro style
  // "L566-695"); the content itself is never echoed — it already lives in
  // the conversation history for the model, and re-rendering it would just
  // duplicate noise.
  const header = /^@@ lines (\d+)-(\d+)(?: of \d+)?(?: \|[^@\n]*)? @@/.exec(
    result,
  );
  const lines = header
    ? { start: Number(header[1]), end: Number(header[2]) }
    : undefined;
  return { filePath: rawPath, lines };
}

export interface CommandCardPayload {
  command: string;
  output: string;
  exitCode: number | null;
  /** True while the command is still executing (pending card, no output yet). */
  running?: boolean;
  /** Identifies this execution run; used to subscribe to live progress events. */
  runId?: string;
}

/**
 * Result-fence body marking a started-but-unfinished `execute` call. Must match
 * TOOL_PENDING_MARKER in extensions/vscode/src/deepagents/toolFormat.ts (the
 * GUI cannot import from the extension package, hence the local copy).
 */
const TOOL_PENDING_MARKER = "__deepagent_running__";

/**
 * Parse a deepagents `execute` tool block. The command lives in the input JSON.
 *
 * The Result fence is the tool's TEXT output — deepagents' `createExecuteTool`
 * formats the backend's `{ output, exitCode, truncated }` response as:
 *   "<stdout/stderr>\n[Command succeeded|failed with exit code N]"
 * (see deepagents' fs.ts). So we recover the real output and the exit code by
 * pulling the status line off the END of the string, rather than JSON-parsing
 * (which would fail and leave exitCode null, wrongly painting every card red).
 * As a fallback we still accept a raw `{ output, exitCode }` JSON envelope.
 */
function parseExecuteBlock(body: string): CommandCardPayload | undefined {
  if (!hasToolHeading(body, ["execute", "execute_pwsh", "execute_bash"])) {
    return undefined;
  }

  const rawCommand = /"command"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
  if (rawCommand === undefined) return undefined;
  const command = unescapeJsonString(rawCommand);

  const result = extractResultFence(body);
  if (!result) return { command, output: "", exitCode: null };

  // Pending card: the extension pushes this block the moment the command
  // STARTS, before any output exists.
  if (result.trim() === TOOL_PENDING_MARKER) {
    return { command, output: "", exitCode: null, running: true };
  }

  // Live pending card: emitted every second while the command runs, carrying
  // the latest output tail so the chat shows progress in place of a static
  // "running" placeholder.
  try {
    const parsed = JSON.parse(result) as {
      running?: boolean;
      output?: string;
      exitCode?: number | null;
      runId?: string;
    };
    if (parsed.running === true) {
      return {
        command,
        output: typeof parsed.output === "string" ? parsed.output : "",
        exitCode: null,
        running: true,
        runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
      };
    }
  } catch {
    // not the running JSON — fall through to the completed-card branches
  }

  // Fast path: deepagents' own "[Command <status> with exit code N]" trailer.
  // "succeeded" may come WITHOUT a code (means exit 0); "failed" may too.
  // NOTE: deepagents appends "[Output was truncated due to size limits]" AFTER
  // the status line, so the status line is not the last thing in the string —
  // strip that trailer before matching (otherwise a successful build ends up
  // with an "unknown exit code").
  const cleaned = result.replace(
    /\s*\[Output was truncated due to size limits\]\s*$/,
    "",
  );
  const statusRe =
    /\[Command (succeeded|failed)(?: with exit code (-?\d+))?\]\s*$/;
  const m = cleaned.match(statusRe);
  if (m) {
    const code =
      m[2] !== undefined ? Number(m[2]) : m[1] === "succeeded" ? 0 : 1;
    const output = cleaned.slice(0, m.index).replace(/\s+$/, "");
    return { command, output, exitCode: code };
  }

  // Fallback: a structured JSON envelope ({ output, exitCode }).
  let output = result;
  let exitCode: number | null = null;
  try {
    const parsed = JSON.parse(result) as {
      output?: string;
      exitCode?: number | null;
    };
    if (typeof parsed.output === "string") output = parsed.output;
    if (typeof parsed.exitCode === "number") exitCode = parsed.exitCode;
  } catch {
    // Leave output as the raw result string; exitCode stays null.
  }
  return { command, output, exitCode };
}

function toFence(
  payload: EditCardPayload | ReadCardPayload | CommandCardPayload,
  language: string,
): string {
  // Single-line JSON: JSON.stringify escapes the newlines, so the fence body
  // can never break the block. A longer fence marker is used when the payload
  // itself contains backticks (mirrors toolFormat.ts's fence()).
  const json = JSON.stringify(payload);
  const longestBackticks = Math.max(
    3,
    ...[...json.matchAll(/`+/g)].map((match) => match[0].length),
  );
  const marker = "`".repeat(longestBackticks + 1);
  return `\n\n${marker}${language}\n${json}\n${marker}\n\n`;
}

/**
 * Drop redundant pending (running) `execute` blocks. The live output is now
 * streamed to the card via the `deepagentExecuteProgress` webview event (keyed
 * by runId), so the extension emits only ONE pending block per command at start
 * — no per-second re-emission. This dedup still guards the pairing: it keeps
 * the single pending while the command runs and drops it once the completed
 * block arrives (per command, in order). Runs on the full accumulated source
 * (re-processed on every streamed token) so pairing stays consistent.
 */
function dropMatchedPendingCommandBlocks(source: string): string {
  // Pending blocks come in two shapes: the legacy TOOL_PENDING_MARKER body and
  // the running-JSON body ({"running":true,...,"runId":...}) emitted by the
  // event-stream pending card. Guard on EITHER so the scan is skipped only when
  // there is truly nothing to dedupe — with the event-stream pending the marker
  // no longer appears, and guarding on the marker alone silently disabled the
  // whole dedup (stuck "running" card next to the completed one).
  if (
    !source.includes(TOOL_PENDING_MARKER) &&
    !source.includes('"running":true')
  ) {
    return source;
  }

  // Collect every comment-delimited execute block with its offset, command, and
  // running/completed flag. (formatToolBlock always emits comment-delimited
  // blocks, so BLOCK_RE is the canonical source for pairing.)
  interface Block {
    start: number;
    end: number;
    command: string;
    running: boolean;
  }
  const blocks: Block[] = [];
  let m: RegExpExecArray | null;
  BLOCK_RE.lastIndex = 0;
  while ((m = BLOCK_RE.exec(source))) {
    const whole = m[0];
    const p = parseExecuteBlock(m[1] ?? whole);
    if (p) {
      blocks.push({
        start: m.index,
        end: m.index + whole.length,
        command: p.command,
        running: Boolean(p.running),
      });
    }
  }
  if (blocks.length === 0) return source;

  // Order-aware pairing: a pending pairs with the next completed of the same
  // command (start before end). Drop a pending if (a) a completed block of the
  // same command appears after it (it belongs to a finished run), or (b) another
  // pending of the same command appears after it (superseded live update).
  const drop = new Set<number>();
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b.running) continue;
    const completedAfter = blocks.some(
      (o, j) => j > i && o.command === b.command && !o.running,
    );
    if (completedAfter) {
      drop.add(i);
      continue;
    }
    const pendingAfter = blocks.some(
      (o, j) => j > i && o.command === b.command && o.running,
    );
    if (pendingAfter) drop.add(i);
  }
  if (drop.size === 0) return source;

  // Splice out the dropped blocks, preserving everything else.
  let out = "";
  let cursor = 0;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (drop.has(i)) {
      cursor = b.end;
    } else {
      out += source.slice(cursor, b.end);
      cursor = b.end;
    }
  }
  out += source.slice(cursor);
  return out;
}

export function rewriteDeepAgentToolBlocks(source: string): string {
  if (!source.includes("**Tool: `")) return source;

  source = dropMatchedPendingCommandBlocks(source);

  // Preferred: exact comment-delimited block produced by formatToolBlock.
  let out = source.replace(BLOCK_RE, (whole, body: string) => {
    const edit = parseEditFileBlock(body);
    if (edit) return toFence(edit, EDIT_CARD_LANGUAGE);
    const read = parseReadFileBlock(body);
    if (read) return toFence(read, READ_CARD_LANGUAGE);
    const cmd = parseExecuteBlock(body);
    if (cmd) return toFence(cmd, COMMAND_CARD_LANGUAGE);
    return whole;
  });

  // Fallback: if a streamed chunk split the comment markers, recognize the
  // block by its markdown structure instead. Already-replaced blocks no
  // longer contain the tool heading, so they are not matched twice.
  out = out.replace(EDIT_BLOCK_RE, (whole) => {
    const payload = parseEditFileBlock(whole);
    return payload ? toFence(payload, EDIT_CARD_LANGUAGE) : whole;
  });
  out = out.replace(READ_BLOCK_RE, (whole) => {
    const payload = parseReadFileBlock(whole);
    return payload ? toFence(payload, READ_CARD_LANGUAGE) : whole;
  });
  out = out.replace(COMMAND_BLOCK_RE, (whole) => {
    const payload = parseExecuteBlock(whole);
    return payload ? toFence(payload, COMMAND_CARD_LANGUAGE) : whole;
  });

  return out;
}
