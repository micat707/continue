/**
 * File-content pruning, ported from Kiro's PruningService.
 *
 * The main agent declares `explanation` when calling `read_file`; that text is
 * injected verbatim into a second LLM prompt asking a cheap model which line
 * ranges to keep. Any failure falls back to the original content.
 *
 * This module is deliberately free of `vscode` / provider imports: the caller
 * supplies `invokePrompt`, so the same code can run with the main LLM or in a
 * unit test.
 */

/** 1-indexed inclusive range returned by the pruning model. */
export interface LineRange {
  start: number;
  end: number;
  reason?: string;
}

/**
 * Describes which slice of the source file `content` represents. Passed from
 * `read_file` so the pruning prompt can tell the model the content is a partial
 * excerpt and how many lines the full file has (mirrors Kiro's totalLines /
 * readLines notice that `Ze2` embeds before pruning).
 */
export interface PruneContentContext {
  /** 1-indexed source line the content starts at. */
  startLine?: number;
  /** 1-indexed source line the content ends at. */
  endLine?: number;
  /** Total number of lines in the source file. */
  totalLines?: number;
  /** True when content is only part of the file (pagination / char cap). */
  isPartial?: boolean;
}

/**
 * Kiro only prunes content above this many tokens.
 */
export const MIN_TOKENS_FOR_PRUNING = 1250;

/**
 * Replica of Kiro's `T4.estimateGeneric`. Although Kiro passes a model id to
 * `estimateTokens`, its tokenizer map is empty in the shipped bundle, so every
 * model resolves to `generic` and this is the formula actually used:
 *   ceil(chars / 4) + ceil(lines * 0.5) + (count of ```) * 2
 */
export function estimateTokens(content: string): number {
  if (!content || content.length === 0) return 0;
  const chars = Math.ceil(content.length / 4);
  const lines = Math.ceil(content.split("\n").length * 0.5);
  const fences = (content.match(/```/g) || []).length * 2;
  return chars + lines + fences;
}

const CODE_GUIDELINES = `PRUNING GUIDELINES:
1. Identify line ranges that are directly relevant to the current task
2. Preserve important structural elements (class definitions, key interfaces, main functions)
3. For large methods, you can include just the signature lines if not directly relevant
4. Include enough context around relevant sections to maintain code coherence`;

const PLAIN_TEXT_GUIDELINES = `PRUNING GUIDELINES:
1. Identify line ranges containing information directly relevant to the current task
2. Preserve section headers and structural markers for context
3. You can omit repetitive content or verbose explanations
4. Include introductory and concluding sections if they provide useful context`;

/** Build the exact Kiro-style pruning prompt, with 5-column right-aligned line numbers. */
export function buildPruningPrompt(
  content: string,
  contextIdentifier: string,
  pruningReasoning: string,
  contentType: "code" | "plain_text" = "code",
  context?: PruneContentContext,
): string {
  const lines = content.split("\n");
  const numbered = lines
    .map((line, i) => `${(i + 1).toString().padStart(5, " ")} | ${line}`)
    .join("\n");

  // Kiro's Ze2 embeds totalLines/readLines meta when a read is truncated so
  // the model knows it is seeing a partial view. Reproduce that here: line
  // numbers stay relative to the excerpt (1..N), but we state where the
  // excerpt sits in the source and how big the full file is.
  let partialNotice = "";
  if (
    context?.isPartial &&
    context.totalLines &&
    context.totalLines > lines.length
  ) {
    const from = context.startLine ?? 1;
    const to = context.endLine ?? from + lines.length - 1;
    partialNotice =
      `\nNOTE: This content is a PARTIAL EXCERPT of a larger file. ` +
      `It covers source lines ${from}-${to} of ${context.totalLines} total lines ` +
      `(${lines.length} lines provided here). The line numbers in the content below ` +
      `are relative to THIS EXCERPT (1 through ${lines.length}), not the original file. ` +
      `Return ranges using those excerpt-relative numbers.\n`;
  }

  return `You are helping to optimize context for an AI agent. Your task is to identify which line ranges to preserve from the following content based on the reasoning provided.

IMPORTANT: You must respond with ONLY a valid JSON array of line ranges. Do not include any explanatory text before or after the JSON.

${contentType === "code" ? CODE_GUIDELINES : PLAIN_TEXT_GUIDELINES}

OUTPUT FORMAT:
Respond with a JSON array of objects, each with "start" and "end" properties (and optionally "reason"):
[
  {"start": 1, "end": 25, "reason": "relevant section"},
  {"start": 50, "end": 100, "reason": "important content"}
]

Line numbers are 1-indexed and inclusive (both start and end are included).
Ranges should be in ascending order and non-overlapping.
If the entire content seems relevant, return a single range covering all lines.

PRUNING REASONING:
${pruningReasoning}

CONTENT TYPE: ${contentType}
CONTEXT: ${contextIdentifier}
Total lines: ${lines.length}
${partialNotice}
${numbered}`;
}

/**
 * Parse the model response the same way Kiro does: grab the first `[...]`,
 * JSON.parse it, keep only well-formed integer ranges, sort by start.
 */
export function parseLineRanges(response: string): LineRange[] {
  if (!response || typeof response !== "string") return [];
  const match = response.match(/\[[\s\S]*\]/);
  if (!match) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const ranges: LineRange[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const { start, end, reason } = item as Record<string, unknown>;
    if (typeof start !== "number" || typeof end !== "number") continue;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 1 || end < 1 || start > end) continue;
    ranges.push({
      start,
      end,
      ...(typeof reason === "string" ? { reason } : {}),
    });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** Slice the requested 1-indexed inclusive ranges and join with Kiro's omission marker. */
export function extractLineRanges(
  content: string,
  ranges: LineRange[],
): string {
  const lines = content.split("\n");
  const chunks: string[] = [];
  for (const { start, end } of ranges) {
    if (start < 1 || end > lines.length || start > end) continue;
    chunks.push(lines.slice(start - 1, end).join("\n"));
  }
  return chunks.join("\n\n⋮ [content omitted by pruning]\n\n");
}

/** Caller-supplied LLM invocation. Must return the raw text response. */
export type PruningInvokePrompt = (
  prompt: string,
  signal?: AbortSignal,
) => Promise<string>;

export interface CreatePruneFileContentOptions {
  contentType?: "code" | "plain_text";
  /** Override for tests. */
  minTokens?: number;
}

/**
 * Build the callback consumed by FilesystemMiddleware's `read_file`.
 * It NEVER throws: every failure path returns the original content.
 */
export function createPruneFileContent(
  invokePrompt: PruningInvokePrompt,
  options: CreatePruneFileContentOptions = {},
) {
  const contentType = options.contentType ?? "code";
  const minTokens = options.minTokens ?? MIN_TOKENS_FOR_PRUNING;

  return async function pruneFileContent(
    content: string,
    path: string,
    explanation: string,
    skipPruning: boolean,
    signal?: AbortSignal,
    context?: PruneContentContext,
  ): Promise<string> {
    if (skipPruning) return content;

    const estimatedTokens = estimateTokens(content);
    if (estimatedTokens < minTokens) return content;

    try {
      const prompt = buildPruningPrompt(
        content,
        path,
        explanation,
        contentType,
        context,
      );
      const response = await invokePrompt(prompt, signal);
      const ranges = parseLineRanges(response);
      if (ranges.length === 0) return content;

      const pruned = extractLineRanges(content, ranges);
      // Kiro falls back when pruning does not actually reduce the content.
      if (!pruned || pruned.length >= content.length) return content;
      return pruned;
    } catch {
      return content;
    }
  };
}
