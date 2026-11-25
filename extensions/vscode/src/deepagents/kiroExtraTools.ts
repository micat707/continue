/**
 * Additional Kiro tools aligned from kiro_tools.txt (the in-use Kiro capture).
 * Descriptions + parameter descriptions are verbatim; implementations are
 * self-contained and use only Node fs (no Continue-core dependencies), so the
 * extension can load them without pulling in tree-sitter wasm / core context.
 *
 * Scope (per align plan): read_code, create_hook, update_session_information,
 * create_artifact. The four platform-bound tools (semantic_rename,
 * smart_relocate, kiro_powers, disclose_context) are intentionally not
 * registered — they require Kiro IDE's LSP/VS Code/PowersManager/runtime skills.
 */

import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";

type ToRealPath = (p: string) => string;
type WorkspaceRootResolver = () => string;

const DEFAULT_TO_REAL = (p: string) =>
  path.normalize(p.trim().replace(/\\/g, "/"));
type SessionInfoUpdater = (info: {
  title?: string;
  description?: string;
  status?: string;
}) => void | Promise<void>;

export interface ArtifactPayload {
  id: string;
  title: string;
  kind: string;
  content: string;
  filePath: string;
  format?: string;
  url: string;
  sessionId?: string;
  createdAt: string;
}

type ArtifactPusher = (payload: ArtifactPayload) => void | Promise<void>;

/** Disk-backed writer; when absent falls back to the legacy tmpdir approach. */
type ArtifactWriter = (input: {
  sessionId: string;
  title: string;
  kind: string;
  content?: string;
  sourcePath?: string;
  format?: string;
  toRealPath?: ToRealPath;
}) => Promise<ArtifactPayload>;

export interface KiroExtraToolsDeps {
  /** Resolve a (possibly virtual) path to a real filesystem path. */
  toRealPath?: ToRealPath;
  /** Resolve the primary workspace root for writing .kiro/hooks. */
  workspaceRoot?: WorkspaceRootResolver;
  sessionInfoUpdater?: SessionInfoUpdater;
  sessionId?: string;
  /** Push an artifact to the GUI (artifact panel + inline preview). */
  pushArtifact?: ArtifactPusher;
  /** Disk-backed artifact writer (Kiro store); falls back to tmpdir when absent. */
  artifactWriter?: ArtifactWriter;
  /** Resolve symbols via core tree-sitter; falls back to regex when absent. */
  symbolResolver?: SymbolResolver;
}

const EXT_BY_KIND: Record<string, string> = {
  markdown: "md",
  image: "png",
  svg: "svg",
  mermaid: "mmd",
  html: "html",
  pdf: "pdf",
  code: "txt",
  office: "bin",
};

const CODE_EXTENSIONS =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|java|cs|go|rs|rb|php|c|cpp|h|hpp|swift|kt|scala|sql|lua|zig|dart|vue|svelte)$/i;
const MAX_FULL_CHARS = 10_000;
const MAX_FILE_CHARS = 1_000_000; // Kiro Fin = 1e6: larger files are rejected
const MAX_OUTPUT_CHARS = 64_000; // Kiro WMs = 64e3: output truncated with a hint

interface SymbolInfo {
  name: string;
  type: string;
  signature: string;
  line: number;
  className?: string;
  implementation: string;
}

/** Shape returned by core's tree-sitter `getSymbolsForFile` (SymbolWithRange). */
export interface RawSymbol {
  name: string;
  type: string;
  content: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

/** Injected resolver so the tool needn't import core (keeps bundle/test clean). */
type SymbolResolver = (
  filePath: string,
  content: string,
) => Promise<RawSymbol[] | undefined>;

/**
 * Map core tree-sitter symbols into Kiro's ToolReadCode symbol shape.
 * Mirrors Kiro's extractSignatures (extension.js @10787596).
 */
function mapTreeSitterSymbols(
  raw: RawSymbol[],
  content: string,
): SymbolInfo[] | undefined {
  if (!raw || raw.length === 0) return raw ? [] : undefined;
  const lines = content.split(/\r?\n/);
  return raw.map((s) => {
    const startLine = s.range?.start?.line ?? 0;
    const endLine = s.range?.end?.line ?? startLine;
    const implementation =
      s.content ?? lines.slice(startLine, endLine + 1).join("\n");
    const firstLine = implementation.split(/\r?\n/)[0] ?? "";
    const nodeType = String(s.type ?? "");
    const classTypes = /class|struct|interface|enum|trait|namespace|module/i;
    return {
      name: s.name ?? "",
      type: classTypes.test(nodeType) ? "class" : "function",
      signature: firstLine.trim(),
      line: startLine + 1,
      implementation,
    };
  });
}

/** Group symbols into Kiro-style output (class/function sections). */
function formatSymbolsKiro(symbols: SymbolInfo[], filePath: string): string {
  if (symbols.length === 0) {
    return `No symbols found in ${filePath}`;
  }
  const classes = symbols.filter((s) => s.type === "class");
  const functions = symbols.filter((s) => s.type === "function");
  const render = (s: SymbolInfo) =>
    `${s.signature}  [line ${s.line}]${s.className ? `  (in ${s.className})` : ""}`;
  const parts: string[] = [];
  if (classes.length) {
    parts.push(
      `Classes (${classes.length}):\n${classes.map(render).join("\n")}`,
    );
  }
  if (functions.length) {
    parts.push(
      `Functions (${functions.length}):\n${functions.map(render).join("\n")}`,
    );
  }
  let out = parts.join("\n\n");
  if (out.length > MAX_OUTPUT_CHARS) {
    out =
      out.slice(0, MAX_OUTPUT_CHARS) +
      `\n\n[... truncated at ${MAX_OUTPUT_CHARS} chars; use selector to inspect a specific symbol]`;
  }
  return out;
}

/** Regex fallback used only when tree-sitter/wasm is unavailable. */
function extractSignaturesRegex(content: string, language: string): string {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  const sigRe = new RegExp(
    [
      "^\\s*(export\\s+)?(default\\s+)?(abstract\\s+)?(async\\s+)?",
      "(class|interface|enum|namespace|function|def|struct|impl|trait|type)",
      "\\s+([A-Za-z_$][\\w$]*)",
    ].join(""),
  );
  const methodRe =
    /^\s*(public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][\w$]*)\s*\(/;
  const arrowRe =
    /^\s*(export\s+)?(const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const m = sigRe.exec(line) || methodRe.exec(line) || arrowRe.exec(line);
    if (m) {
      const name = m[m.length - 1] || m[2] || "";
      out.push(`${i + 1}: ${line.trim()}${name ? `  [${name}]` : ""}`);
    }
  }
  return out.length
    ? out.join("\n")
    : `(no signatures matched for language=${language}; file has ${lines.length} lines)`;
}

function codeFilesRecursive(dir: string, max = 200): string[] {
  const results: string[] = [];
  const walk = (d: string) => {
    if (results.length >= max) return;
    let entries: import("fs").Dirent[];
    try {
      entries = require("fs").readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (results.length >= max) break;
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!/^(node_modules|\.git|dist|out|build|\.vscode)$/.test(e.name))
          walk(full);
      } else if (e.isFile() && CODE_EXTENSIONS.test(e.name)) {
        results.push(full);
      }
    }
  };
  walk(dir);
  return results;
}

function createReadCodeTool(deps: KiroExtraToolsDeps) {
  const resolve = deps.toRealPath ?? DEFAULT_TO_REAL;
  return new DynamicStructuredTool({
    name: "read_code",
    description: `Read and analyze code files. For small files (<10k chars), returns full content. For larger files, uses AST parsing to extract signatures.

IMPORTANT: Prefer this tool over readFile for code files unless you need specific line ranges. This tool intelligently handles file size and provides structured code analysis.

CORE FEATURES:
• Auto-detects file size and chooses best approach
• Small files: Returns complete file content
• Large files: Extracts function/class signatures via AST
• Fuzzy search for symbols (classes, functions, methods)
• Scoped method search (Class.method syntax)
• Supports: classes, functions, methods, arrow functions, generators

BEHAVIOR:
• File <10k chars: Returns full file content (selector ignored)
• File ≥10k chars + no selector: Returns all signatures
• File ≥10k chars + selector: Searches for selector, shows implementation
• Directory: Returns signatures from code files

SUPPORTED PATTERNS:
• Traditional functions: function foo() {}
• Arrow functions: const foo = () => {}
• Async functions: async function foo() {}, const foo = async () => {}
• Generator functions: function* foo() {}, *methodName() {}, async *methodName() {}
• Class properties with arrow functions: filter = (x) => x
• Getters/setters: get status() {}, set status(v) {}
• Abstract classes: abstract class Base {}
• Nested classes: class Outer { static Inner = class {} }
• Enums: enum Status { Active, Inactive }
• Namespaces: namespace Utils { export class Helper {} }
• Interfaces: interface IData { method(): void }
• Class methods and constructors
• Scoped lookup: ClassName.methodName (single-level only, e.g., MyClass.method)

NOTE: Use readFile with line ranges for not supported patterns.

`,
    schema: z.object({
      path: z.string().describe("Absolute file or directory path to analyze"),
      selector: z
        .string()
        .nullish()
        .describe(
          "Symbol name to search (supports Class.method syntax for scoped search)",
        ),
      language: z
        .string()
        .optional()
        .meta({ default: "auto" })
        .describe("Programming language (auto-detected if not specified)"),
      explanation: z
        .string()
        .describe(
          "One sentence explanation as to why this tool is being used, and how it contributes to the goal.",
        ),
    }),
    func: async (input) => {
      const real = resolve(input.path);
      const stat = await fs.stat(real).catch(() => null);
      if (!stat) return `Path not found: ${input.path}`;

      /** Extract + format for one file via tree-sitter, regex fallback. */
      const extractFor = async (
        file: string,
        content: string,
      ): Promise<string> => {
        if (deps.symbolResolver) {
          try {
            const raw = await deps.symbolResolver(file, content);
            const ts = mapTreeSitterSymbols(raw ?? [], content);
            if (ts !== undefined) return formatSymbolsKiro(ts, file);
          } catch {
            /* fall through to regex */
          }
        }
        return extractSignaturesRegex(content, input.language || "auto");
      };

      if (stat.isDirectory()) {
        const files = codeFilesRecursive(real);
        const chunks: string[] = [];
        for (const f of files) {
          try {
            const content = await fs.readFile(f, "utf8");
            if (content.length > MAX_FILE_CHARS) continue;
            const sigs = await extractFor(f, content);
            if (
              !sigs.startsWith("(no signatures") &&
              !sigs.startsWith("No symbols")
            ) {
              chunks.push(`// ${path.relative(real, f)}\n${sigs}`);
            }
          } catch {
            /* skip unreadable */
          }
        }
        return chunks.length
          ? chunks.join("\n\n")
          : `No code symbols found in ${input.path}`;
      }

      const raw = await fs.readFile(real, "utf8");
      if (raw.length > MAX_FILE_CHARS) {
        return `File too large to read: ${input.path} (${raw.length} chars > ${MAX_FILE_CHARS})`;
      }
      if (raw.length < MAX_FULL_CHARS) return raw;

      let symbols: SymbolInfo[] | undefined;
      if (deps.symbolResolver) {
        try {
          const rawSymbols = await deps.symbolResolver(real, raw);
          symbols = mapTreeSitterSymbols(rawSymbols ?? [], raw);
        } catch {
          symbols = undefined;
        }
      }
      if (symbols === undefined) {
        return extractSignaturesRegex(raw, input.language || "auto");
      }
      if (!input.selector) return formatSymbolsKiro(symbols, input.path);

      const sel = input.selector.includes(".")
        ? input.selector.split(".").pop()!
        : input.selector;
      const matches = symbols.filter((s) => s.name === sel);
      if (matches.length === 0) {
        return `Symbol "${input.selector}" not found in ${input.path}`;
      }
      const impl = matches
        .map(
          (s) => `// ${s.type} ${s.name} [line ${s.line}]\n${s.implementation}`,
        )
        .join("\n\n");
      return impl.length > MAX_OUTPUT_CHARS
        ? impl.slice(0, MAX_OUTPUT_CHARS) +
            `\n\n[... truncated at ${MAX_OUTPUT_CHARS} chars]`
        : impl;
    },
  });
}

const HOOK_TRIGGERS = [
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "Stop",
  "UserPromptSubmit",
  "PreTaskExec",
  "PostTaskExec",
  "PostFileCreate",
  "PostFileSave",
  "PostFileDelete",
];

function createHookTool(deps: KiroExtraToolsDeps) {
  const resolve = deps.toRealPath ?? DEFAULT_TO_REAL;
  return new DynamicStructuredTool({
    name: "create_hook",
    description: `Creates a v2 hook file at \`.kiro/hooks/<id>.json\` that the agent executes directly.

v2 hooks are JSON files the agent reads at session start and executes in-process. No IDE round-trip needed.

File format written:
\`\`\`json
{
  "version": "v1",
  "hooks": [{
    "name": "<name>",
    "trigger": "<Trigger>",
    "matcher": "<optional regex>",
    "action": { "type": "command", "command": "<shell command>" }
  }]
}
\`\`\`

Trigger names (PascalCase): PreToolUse, PostToolUse, SessionStart, Stop, UserPromptSubmit, PreTaskExec, PostTaskExec, PostFileCreate, PostFileSave, PostFileDelete

Action types:
  command — runs a shell command; receives JSON on stdin with session context
  agent   — appends a static prompt to the model context

Exit-code semantics for command actions:
  exit 0  — success; stdout forwarded for SessionStart/UserPromptSubmit/PreToolUse
  exit 2  — block the action (PreToolUse, UserPromptSubmit, PreTaskExec); stderr forwarded
  other   — silent failure, no block

For PreToolUse hooks, exit 0 stdout may contain a JSON decision:
  {"hookSpecificOutput":{"permissionDecision":"ask","permissionDecisionReason":"reason"}}
  When permissionDecision is "ask", the user is prompted to confirm before the tool proceeds.

Matcher (optional regex):
  - PreToolUse/PostToolUse: tested against tool name
  - PostFileCreate/PostFileSave/PostFileDelete: tested against file path
  - Other triggers: ignored (always matches)`,
    schema: z.object({
      id: z
        .string()
        .describe(
          'Short dashed identifier for the hook file (e.g. "lint-on-save")',
        ),
      name: z.string().describe("Human-readable hook name"),
      description: z.string().optional().describe("What the hook does"),
      trigger: z
        .string()
        .describe(`Trigger event. Valid: ${HOOK_TRIGGERS.join(", ")}`),
      matcher: z
        .string()
        .optional()
        .describe("Optional regex to filter which events fire this hook"),
      actionType: z
        .enum(["command", "agent"])
        .describe('Action type: "command" or "agent"'),
      command: z
        .string()
        .optional()
        .describe(
          'Shell command to run (required when actionType is "command")',
        ),
      prompt: z
        .string()
        .optional()
        .describe(
          'Prompt text to inject (required when actionType is "agent")',
        ),
      timeout: z
        .number()
        .optional()
        .describe("Timeout in seconds for command actions (default: 60)"),
    }),
    func: async (input) => {
      if (!/^[a-zA-Z0-9_-]+$/.test(input.id)) {
        return `Invalid hook id: "${input.id}". Use only alphanumeric characters, hyphens, and underscores.`;
      }
      if (!HOOK_TRIGGERS.includes(input.trigger)) {
        return `Invalid trigger: "${input.trigger}". Valid: ${HOOK_TRIGGERS.join(", ")}`;
      }
      if (input.actionType === "command" && !input.command) {
        return 'command is required when actionType is "command"';
      }
      if (input.actionType === "agent" && !input.prompt) {
        return 'prompt is required when actionType is "agent"';
      }
      const root = deps.workspaceRoot ? deps.workspaceRoot() : process.cwd();
      const hookDir = path.join(root, ".kiro", "hooks");
      await fs.mkdir(hookDir, { recursive: true });
      const hookPath = path.join(hookDir, `${input.id}.json`);
      const action =
        input.actionType === "command"
          ? {
              type: "command",
              command: input.command,
              ...(input.timeout ? { timeout: input.timeout } : {}),
            }
          : { type: "agent", prompt: input.prompt };
      const hookObj: Record<string, unknown> = {
        version: "v1",
        hooks: [
          {
            name: input.name,
            trigger: input.trigger,
            ...(input.matcher ? { matcher: input.matcher } : {}),
            ...(input.description ? { description: input.description } : {}),
            action,
          },
        ],
      };
      await fs.writeFile(hookPath, JSON.stringify(hookObj, null, 2), "utf8");
      return `Hook "${input.name}" created at ${hookPath}`;
    },
  });
}

function createUpdateSessionInformationTool(deps: KiroExtraToolsDeps) {
  return new DynamicStructuredTool({
    name: "update_session_information",
    description: `Update the session's status so the user can see what you're working on without opening the session. Call this when the focus of your work changes meaningfully — for example when you start a new sub-task, finish one, become blocked on the user, or complete the overall request. Provide whichever fields changed; omit the rest.
- title: a short label for the session (at most ~6 words). Set this once you understand the task, and update it if the focus shifts.
- description: one or two sentences on what you're doing right now and the progress so far. Write in first person.
- status: "waiting_on_user" when you are blocked on a user question or decision; "completed" when the overall task is done. Omit otherwise — the system knows when you are actively working.
This is lightweight and does not interrupt your work. Prefer calling it a few times across a task over narrating in chat.`,
    schema: z.object({
      title: z
        .string()
        .max(100)
        .optional()
        .describe("Short session label (~6 words max). Omit if unchanged."),
      description: z
        .string()
        .max(500)
        .optional()
        .describe(
          "One or two sentences on current work and progress, first person. Omit if unchanged.",
        ),
      status: z
        .enum(["waiting_on_user", "completed"])
        .optional()
        .describe(
          'Activity status: "waiting_on_user" when blocked on a question or decision for the user, "completed" when you finish the task. Omit while simply working — the system tracks that automatically.',
        ),
    }),
    func: async (input) => {
      const fields = [
        input.title ? `title="${input.title}"` : "",
        input.description
          ? `description="${input.description.slice(0, 80)}..."`
          : "",
        input.status ? `status=${input.status}` : "",
      ].filter(Boolean);
      if (deps.sessionInfoUpdater) {
        await deps.sessionInfoUpdater({
          ...(input.title ? { title: input.title } : {}),
          ...(input.description ? { description: input.description } : {}),
          ...(input.status ? { status: input.status } : {}),
        });
      }
      console.log(
        `[update_session_information] sid=${deps.sessionId ?? "?"} ${fields.join(" ")}`,
      );
      return `Session information updated: ${fields.join(", ") || "(no fields)"}`;
    },
  });
}

function createArtifactTool(deps: KiroExtraToolsDeps) {
  const resolve = deps.toRealPath ?? DEFAULT_TO_REAL;
  return new DynamicStructuredTool({
    name: "create_artifact",
    description: `Produce a durable, reviewable artifact for the user: a document, mock, diagram, or image that deserves to be reviewed on its own rather than buried in the conversation.

The artifact is saved for the life of the session, previewed inline in the chat, and rendered full-size in the artifact panel. It can also be opened in an editor tab.

Parameters:
- title: Short human-readable name shown in the artifact list (required).
- kind: How to render it (required). One of:
  - markdown — a document for review (design doc, plan, report, spec). Renders with full formatting, tables, and math.
  - svg — a vector mock, wireframe, chart, or icon you author inline. Best choice for UI mocks.
  - mermaid — a diagram definition (flowchart, sequence, ER, gantt, state, class).
  - html — an HTML fragment/page for a richer mock. Rendered without scripts.
  - code — source code or plain text, syntax highlighted.
  - image — a raster image (png/jpg/gif/webp). Requires sourcePath.
  - pdf — a PDF document. Requires sourcePath.
  - office — a Word/Excel/PowerPoint file. Requires sourcePath.
- content: The artifact's text. Required for markdown, svg, mermaid, html, and code.
- sourcePath: Absolute path to an existing file to adopt instead of inline text. Required for image, pdf, and office.
- format: Optional hint. For code, the highlight language (e.g. "typescript", "python"). For binaries, the file extension (e.g. "png", "docx").

Returns the artifact id and a reference URL.

When to use:
- The user asks for a mock, wireframe, diagram, or design
- You have written a document meant to be read and reviewed as a whole
- You captured or generated an image, chart, or PDF worth showing
- You want to show a visual result rather than describe it

To show an artifact inline in your reply, embed its reference URL as a markdown image:
![Login screen mock](kiro-artifact://<id>)
Do this for visual artifacts (svg, image, mermaid) so the user sees a preview without opening the panel. Use it once per artifact, right where you discuss it.

Notes:
- Prefer one artifact per deliverable. Do not create an artifact for a one-line answer or a small code snippet that belongs inline in your message.
- For a raster image or PDF you generated with a script or another tool, write the file first, then register it here with sourcePath.
- Binary kinds cannot be authored inline; content is ignored for them.`,
    schema: z.object({
      title: z.string().describe("Short human-readable name for the artifact."),
      kind: z
        .enum([
          "markdown",
          "image",
          "svg",
          "mermaid",
          "html",
          "pdf",
          "code",
          "office",
        ])
        .describe("How the artifact should be rendered."),
      content: z
        .string()
        .optional()
        .describe(
          "The artifact text. Required for markdown, svg, mermaid, html, and code.",
        ),
      sourcePath: z
        .string()
        .optional()
        .describe(
          "Absolute path to an existing file to adopt. Required for image, pdf, and office.",
        ),
      format: z
        .string()
        .optional()
        .describe(
          'Highlight language for code (e.g. "typescript"), or file extension for binaries (e.g. "png").',
        ),
    }),
    func: async (input) => {
      const binaryKinds = ["image", "pdf", "office"];
      const inlineKinds = ["markdown", "svg", "mermaid", "html", "code"];
      if (binaryKinds.includes(input.kind) && !input.sourcePath) {
        return `${input.kind} artifacts require sourcePath`;
      }
      if (inlineKinds.includes(input.kind) && !input.content) {
        return `${input.kind} artifacts require content`;
      }
      let payload: ArtifactPayload;
      if (deps.artifactWriter && deps.sessionId) {
        // Kiro-aligned: persist under globalStorage/artifacts/<session>/ with
        // a manifest; survives webview reload and IDE restart.
        payload = await deps.artifactWriter({
          sessionId: deps.sessionId,
          title: input.title,
          kind: input.kind,
          content: input.content,
          sourcePath: input.sourcePath,
          format: input.format,
          toRealPath: resolve,
        });
      } else {
        // Fallback (no store initialized): legacy tmpdir approach.
        const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const ext = input.format || EXT_BY_KIND[input.kind] || "bin";
        const dir = path.join(os.tmpdir(), "micat-artifacts");
        await fs.mkdir(dir, { recursive: true });
        const filePath = path.join(dir, `${id}.${ext}`);
        let content = input.content ?? "";
        if (input.sourcePath) {
          await fs.copyFile(resolve(input.sourcePath), filePath);
          if (inlineKinds.includes(input.kind))
            content = await fs.readFile(filePath, "utf8");
        } else {
          await fs.writeFile(filePath, content, "utf8");
        }
        payload = {
          id,
          title: input.title,
          kind: input.kind,
          content,
          filePath,
          ...(input.format ? { format: input.format } : {}),
          url: `kiro-artifact://${id}`,
          sessionId: deps.sessionId,
          createdAt: new Date().toISOString(),
        };
      }
      const { id, url, filePath } = payload;
      // Note: with the disk store, artifactWriter already notifies listeners,
      // so pushArtifact is only needed for the legacy fallback path.
      if (deps.pushArtifact && !deps.artifactWriter) {
        try {
          await deps.pushArtifact(payload);
        } catch {
          /* disk persisted anyway */
        }
      }
      return `Artifact "${input.title}" created (id=${id}, kind=${input.kind}).\nReference: ${url}\nFile: ${filePath}\nEmbed in your reply with ![${input.title}](${url}) for visual kinds.`;
    },
  });
}

export function createKiroExtraTools(deps: KiroExtraToolsDeps = {}) {
  return [
    createReadCodeTool(deps),
    createHookTool(deps),
    createUpdateSessionInformationTool(deps),
    createArtifactTool(deps),
  ];
}
