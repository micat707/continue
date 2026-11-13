/**
 * Workspace-backed filesystem for DeepAgent
 * ------------------------------------------
 * DeepAgent's file tools operate on a virtual filesystem whose root `/` is
 * backed by the folders open in VS Code's Explorer — i.e. everything in
 * `vscode.workspace.workspaceFolders`, including folders added later via
 * "Add Folder to Workspace...".
 *
 *  - No folders open: fall back to the process cwd (read-only in practice).
 *  - One folder: a single `FilesystemBackend` rooted there, so paths stay
 *    exactly as before (`/ReadMe.txt`).
 *  - Multiple folders: a `WorkspaceRootBackend` (CompositeBackend subclass)
 *    where every folder is mounted as `/<folder-name>/...` and `ls("/")` lists
 *    ONLY those mount points, so the agent can discover all roots.
 *
 * `getWorkspaceLayout()` is the single source of truth for these mount paths:
 * the backend factory, the workspace context handed to the model, and future
 * authorization checks all derive from it, so they can never disagree.
 *
 * The backend is built by a factory on every agent run and the context is
 * rebuilt on every model call, so adding/removing a workspace folder takes
 * effect on the next message without rebuilding the agent or touching
 * persisted settings.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { exec, execFileSync } from "child_process";
import * as vscode from "vscode";
import {
  CompositeBackend,
  FilesystemBackend,
  type FileInfo,
  type GlobResult,
  type GrepResult,
  type LsResult,
} from "deepagents";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { isDestructiveRootCommand, type PermissionAction } from "./permissions";
import {
  postExecuteProgress,
  postExecuteProgressDone,
} from "./executeProgressBridge";

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

/**
 * Runtime OS/shell context handed to the model so it builds commands that
 * actually run. We DETECT the real shell (not assume), because the agent
 * terminal uses VS Code's default integrated shell and the rules differ a lot:
 * e.g. Windows PowerShell 5.1 does NOT support `&&`/`||` (a PowerShell 7+
 * feature), so a model-written `a && b` silently fails there — whereas cmd and
 * bash accept it. Telling the model the exact shell removes that failure class.
 */
interface DetectedShell {
  raw: string;
  family: "powershell5" | "powershell7" | "cmd" | "posix" | "other";
  version: string;
  supportsAmp: boolean;
}

let cachedShell: DetectedShell | undefined;
let cachedShellAt = 0;

function powerShellVersion(exe: string): string {
  try {
    const out = execFileSync(
      exe,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.ToString()",
      ],
      { timeout: 5000, encoding: "utf8" },
    ).trim();
    return out || (exe.toLowerCase().includes("pwsh") ? "7" : "5.1");
  } catch {
    return exe.toLowerCase().includes("pwsh") ? "7" : "5.1";
  }
}

function detectShell(): DetectedShell {
  const now = Date.now();
  if (cachedShell && now - cachedShellAt < 60_000) return cachedShell;
  const raw = (vscode.env.shell || "").toLowerCase();
  let s: DetectedShell;
  if (raw.includes("pwsh")) {
    s = {
      raw,
      family: "powershell7",
      version: powerShellVersion("pwsh"),
      supportsAmp: true,
    };
  } else if (raw.includes("powershell")) {
    s = {
      raw,
      family: "powershell5",
      version: powerShellVersion("powershell"),
      supportsAmp: false,
    };
  } else if (raw.includes("cmd")) {
    s = { raw, family: "cmd", version: "", supportsAmp: true };
  } else if (
    raw.includes("bash") ||
    raw.includes("sh") ||
    raw.includes("zsh") ||
    raw.includes("fish")
  ) {
    s = { raw, family: "posix", version: "", supportsAmp: true };
  } else {
    // No shell path known: assume the platform default.
    s =
      os.platform() === "win32"
        ? { raw, family: "powershell5", version: "5.1", supportsAmp: false }
        : { raw, family: "posix", version: "", supportsAmp: true };
  }
  cachedShell = s;
  cachedShellAt = now;
  return s;
}

/**
 * Per-shell command equivalents (ported from Kiro's platform command examples).
 * The model is trained mostly on bash; on Windows its `ls`/`cat`/`grep`/`rm`
 * don't exist in cmd and behave differently in PowerShell. Returned as bare
 * bullet lines so the caller wraps them in `<platform_specific_command_guidelines>`.
 * The command separator rule is the critical one — Windows PowerShell 5.1 has NO `&&`.
 */
function platformCommandExamples(shell: DetectedShell): string[] {
  if (shell.family === "powershell5" || shell.family === "powershell7") {
    return [
      "- List files: Get-ChildItem (alias ls also works)",
      "- Read a file: Get-Content file.txt (alias cat also works)",
      "- Change directory: cd path  (Set-Location — switches drives automatically; do NOT use cmd's `cd /d path`, `/d` is not a PowerShell flag)",
      "- Remove file: Remove-Item file.txt",
      "- Remove directory: Remove-Item -Recurse -Force dir",
      "- Copy: Copy-Item src dst",
      "- Make directory: New-Item -ItemType Directory -Path dir",
      '- Search text: Select-String -Path *.txt -Pattern "search"',
      shell.family === "powershell5"
        ? "- Command separator: ;  (Windows PowerShell does NOT support && — write `a ; b`, never `a && b`)"
        : "- Command separator: && and || are supported (PowerShell 7+).",
    ];
  }
  if (shell.family === "cmd") {
    return [
      "- List files: dir",
      "- Read a file: type file.txt",
      "- Remove file: del file.txt",
      "- Remove directory: rmdir /s /q dir",
      "- Copy: copy src dst",
      "- Make directory: mkdir dir",
      '- Search text: findstr "search" *.txt',
      "- Command separator: & or && (both work in cmd).",
    ];
  }
  return [
    "- List files: ls -la",
    "- Read a file: cat file.txt",
    "- Remove file: rm file.txt",
    "- Remove directory: rm -rf dir",
    "- Copy: cp src dst  (recursive: cp -r src dst)",
    "- Make directory: mkdir -p dir",
    '- Search text: grep -r "search" *.txt',
    "- Command separator: && (and ||) work as expected.",
  ];
}

/**
 * System information block (mirrors Kiro's `<system_information>`): the OS,
 * platform and the exact shell the agent terminal uses. Kept as its own tagged
 * block, separate from the command guidelines, to match Kiro's prompt layout.
 */
function systemInformationHint(): string[] {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
  const shell = detectShell();
  const osLabel =
    platform === "win32"
      ? "Windows"
      : platform === "darwin"
        ? "macOS"
        : platform === "linux"
          ? "Linux"
          : platform;
  const shellName =
    shell.family === "powershell5"
      ? `Windows PowerShell ${shell.version}`
      : shell.family === "powershell7"
        ? `PowerShell ${shell.version}`
        : shell.family === "cmd"
          ? "cmd.exe"
          : shell.family === "posix"
            ? "POSIX bash"
            : "unknown";
  return [
    "<system_information>",
    `Operating System: ${osLabel} ${arch} (release ${release})`,
    `Platform: ${platform}`,
    `Shell: ${shellName}`,
    "</system_information>",
  ];
}

/**
 * Per-shell command guidelines (mirrors Kiro's `<platform_specific_command_guidelines>`):
 * an adaptation sentence (Kiro's wording) followed by the command equivalents
 * and the critical separator rule (Windows PowerShell 5.1 has NO `&&`).
 */
function platformCommandGuidelines(): string[] {
  const platform = os.platform();
  const shell = detectShell();
  const osLabel =
    platform === "win32"
      ? "Windows"
      : platform === "darwin"
        ? "macOS"
        : platform === "linux"
          ? "Linux"
          : platform;
  const shellName =
    shell.family === "powershell5"
      ? `Windows PowerShell ${shell.version}`
      : shell.family === "powershell7"
        ? `PowerShell ${shell.version}`
        : shell.family === "cmd"
          ? "cmd.exe"
          : shell.family === "posix"
            ? "POSIX bash"
            : "unknown";
  const lines = [
    "<platform_specific_command_guidelines>",
    `Commands MUST be adapted to your ${osLabel} system running on ${platform} with ${shellName} shell.`,
    "",
  ];
  if (shell.family === "powershell5" || shell.family === "powershell7") {
    lines.push(
      shell.family === "powershell5"
        ? "Windows PowerShell 5.1 does NOT support `&&` or `||` (those require PowerShell 7+)."
        : "PowerShell 7+ supports `&&` / `||` like bash.",
      "Use `;` to chain commands (e.g. `cd dir ; mvn compile`) or issue them as separate `execute` calls.",
      // Change directory: Set-Location / `cd` switches drives on its own — the
      // cmd.exe `cd /d` idiom does NOT exist here and fails with
      // PositionalParameterNotFound. This is the single most common Windows
      // mistake a bash-trained model makes in PowerShell.
      "Change directory with plain `cd path` — Set-Location switches drives by itself. NEVER write the cmd.exe idiom `cd /d path` (PowerShell has no `/d` flag and the command errors).",
      "Environment variables: `$env:NAME = 'value'` (read `$env:NAME`), not `%NAME%` or `$NAME`.",
    );
  } else if (shell.family === "cmd") {
    lines.push(
      "cmd.exe supports `&&` / `||`, but has NO `ls`/`pwd`/`cat`/`rm` — use `dir`, `type`, `del` instead.",
      "Note: `cd /d path` IS valid in cmd.exe to change drive — but ONLY here; PowerShell rejects `/d`.",
    );
  } else {
    lines.push("POSIX bash supports `&&` / `||` like a normal terminal.");
  }
  lines.push(
    "Preferred commands (bash-trained models: use these, not ls/cat/grep/rm on Windows):",
  );
  lines.push(...platformCommandExamples(shell));
  lines.push("</platform_specific_command_guidelines>");
  return lines;
}

/**
 * Current date/time handed to the model (mirrors Kiro's `<current_date_and_time>`).
 * Without it the model can misjudge "now" and get past-vs-future / year wrong on
 * date-related queries. Generated fresh each call.
 */
function currentDateTimeHint(): string[] {
  const now = new Date();
  const date = now.toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  const weekday = now.toLocaleDateString("en-US", { weekday: "long" });
  const time = now.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return [
    "<current_date_and_time>",
    `Date: ${date}`,
    `Day of Week: ${weekday}`,
    `Local Time: ${time}`,
    "Use this for any query involving dates, times, or ranges. Pay close",
    "attention to the year when judging past vs future.",
    "</current_date_and_time>",
  ];
}

/**
 * Virtual→REAL path mapping for shell commands. The filesystem tools only
 * accept virtual paths, but a shell command runs in the REAL directory where
 * `/mountName` does not exist — this is the source of "sometimes the command
 * works, sometimes 系统找不到指定的路径". Telling the model the real cwd and
 * the mapping removes the guesswork.
 */
function shellPathMapping(
  mounts: WorkspaceMount[],
  singleRoot: boolean,
): string[] {
  const first = mounts[0];
  const cwd = first?.realPath ?? "";
  const lines = [
    "IMPORTANT — shell paths: the virtual paths used by the filesystem tools",
    "(e.g. /mountName/...) do NOT exist inside shell commands. In a command,",
    "use REAL Windows/POSIX paths or paths RELATIVE to the working directory.",
    `The command's working directory is the REAL directory of the first`,
    `workspace folder: ${cwd}`,
    "Mapping (virtual tool path -> real path):",
    ...mounts.map((m) => `  ${m.virtualPath} -> ${m.realPath}`),
  ];
  if (singleRoot) {
    lines.push(
      "Since the single workspace root IS the working directory, prefer",
      "relative paths (e.g. src/main/java) in commands.",
    );
  } else {
    // Multi-root workspace: without this rule models assume "the shell already
    // sits in the project I'm working on" and emit a bare `mvn clean compile`,
    // which then fails with "no POM in this directory" because the shell is
    // really sitting in the FIRST workspace folder, not the target project.
    lines.push(
      `MULTI-ROOT RULE: the shell starts ONLY in the first workspace folder`,
      `(${cwd}). Every other workspace folder above is a DIFFERENT directory`,
      `the shell is NOT in. To build/test/run a project that lives in another`,
      `workspace folder, you MUST cd into that project's real path within the`,
      `SAME command, e.g.:`,
      `  cd "D:\\path\\to\\other-project" ; mvn clean compile`,
      `A bare "mvn clean compile" (no cd) runs in ${cwd} and fails with`,
      `"no POM in this directory" whenever the project is anywhere else.`,
    );
  }
  return lines;
}

/** All folders currently shown in the Explorer, in order. */
export function getWorkspaceFolders(): WorkspaceFolderInfo[] {
  return (vscode.workspace.workspaceFolders ?? []).map((f) => ({
    name: f.name,
    path: f.uri.fsPath,
  }));
}

/**
 * Resolve the effective roots.
 * `override` is an optional manually-chosen directory; when set it replaces
 * the workspace folders entirely (single-root mode).
 *
 * An override that points at one of the current workspace folders is ignored:
 * older versions persisted such a value when the user was asked to pick a
 * single root, and honouring it would silently hide the other folders. The
 * override is only meaningful for directories OUTSIDE the workspace.
 */
export function getEffectiveRoots(override?: string): WorkspaceFolderInfo[] {
  const folders = getWorkspaceFolders();
  if (override) {
    const trimmed = override
      .trim()
      .replace(/[\\/]+$/, "")
      .toLowerCase();
    if (
      trimmed &&
      !folders.some(
        (f) => f.path.replace(/[\\/]+$/, "").toLowerCase() === trimmed,
      )
    ) {
      const parts = override.trim().split(/[\\/]/).filter(Boolean);
      return [
        {
          name: parts[parts.length - 1] || override.trim(),
          path: override.trim(),
        },
      ];
    }
  }
  if (folders.length > 0) return folders;
  return [{ name: "cwd", path: process.cwd() }];
}

/**
 * True when `path` lies inside one of the effective workspace roots (the
 * folders mounted as the virtual filesystem). Used by the permission engine to
 * decide whether a path is served by the VIRTUAL backend (workspace) or the
 * REAL filesystem (everything else, including extra trusted dirs and
 * out-of-workspace paths).
 */
export function inWorkspaceFolders(path: string, override?: string): boolean {
  const n = normalizeForApproval(path);
  if (!n) return false;
  const realRootMatch = getEffectiveRoots(override).some((r) => {
    const rn = normalizeForApproval(r.path);
    return n === rn || n.startsWith(rn + "/");
  });
  if (realRootMatch) return true;
  // The tools are driven with VIRTUAL paths ("/", "/<mount>/...") per
  // buildWorkspaceContext, so a plain prefix match against the REAL root
  // paths above never fires for them. EVERY virtual path is served by the
  // virtual backend, not just the named mounts: in multi-root mode any path
  // outside the mounts falls through to the DEFAULT backend (the first
  // workspace folder — see createWorkspaceBackend's stray-path comment), and
  // glob happily returns such root-level files ("/TestA.txt"). Classifying
  // them "outside" (classifyPath only knows the mounts) let an approved read
  // hijack to the unrestricted real-fs backend, which lstat'ed "/TestA.txt"
  // at the drive root → ENOENT even though the file is in the workspace.
  // Windows real absolute paths (C:/…) never start with "/", so they keep
  // flowing through the real-root match above; the backend's own traversal
  // guard blocks "/.." escapes.
  return n.startsWith("/");
}

/** Human-readable description for the status bar / panel header. */
export function describeRoots(override?: string): string {
  const roots = getEffectiveRoots(override);
  const folders = getWorkspaceFolders();
  const isOverride =
    roots.length === 1 && !folders.some((f) => f.path === roots[0].path);
  if (isOverride) return roots[0].path + " (override)";
  if (folders.length) {
    return roots.map((r) => r.name).join(", ") + " (workspace)";
  }
  return roots[0].path + " (cwd — no workspace open)";
}

/**
 * Multi-root backend whose `/` lists ONLY the workspace folders.
 *
 * `CompositeBackend.ls("/")` normally prepends the default backend's own
 * entries before the mount points. That would mix one folder's files into the
 * workspace root listing, which is wrong. We override just `ls("/")` to return
 * a clean directory listing of the mount points.
 *
 * glob/grep get the same treatment, one level deeper: CompositeBackend.glob
 * searches BOTH the default backend (= the first folder) and every route, so
 * when the first folder is one of the mounts its files come back twice — once
 * bare ("/TestA.txt" via the default) and once mounted
 * ("/ai_download_plugin/TestA.txt" via its route) — the same physical file
 * under two virtual paths. We dedupe by RESOLVED REAL path and keep the
 * mount-prefixed (canonical) variant.
 */

/**
 * Extra environment variables for `execute` runs, from the
 * `continue.deepAgent.execute.env` setting. The exec child normally inherits
 * the EXTENSION HOST's environment — a snapshot taken when the IDE started —
 * so variables the user configures in Windows AFTER launching the IDE (e.g.
 * JAVA_HOME) are invisible to commands until a full IDE restart. This setting
 * lets the user inject such variables from settings.json, which is read fresh
 * on every run and therefore takes effect immediately.
 */
function extraCommandEnv(): Record<string, string> {
  return (
    vscode.workspace
      .getConfiguration("continue")
      .get<Record<string, string>>("deepAgent.execute.env") ?? {}
  );
}

/**
 * Decode raw console output. On Windows the console tools emit bytes in the
 * system ANSI code page (GBK on zh-CN systems), while English/UTF-8 output is
 * plain UTF-8. `exec` with the default utf8 encoding turns GBK text into
 * mojibake, so we receive BUFFERS and try a strict UTF-8 decode first — if it
 * fails the bytes cannot be UTF-8, so fall back to GBK (full-ICU TextDecoder
 * is available in the VS Code extension host).
 */
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const gbkDecoder = new TextDecoder("gbk");
function decodeConsoleOutput(buf: Buffer): string {
  if (!buf || buf.length === 0) return "";
  try {
    return strictUtf8.decode(buf);
  } catch {
    try {
      return gbkDecoder.decode(buf);
    } catch {
      return buf.toString("utf8"); // last resort: replacement chars
    }
  }
}

/**
 * Rewrite VIRTUAL filesystem paths inside a shell command into REAL paths.
 *
 * The filesystem tools address the workspace through the virtual root
 * (`/hello_world/...`), but a shell command runs in the REAL directory where
 * no such path exists — the model mixing the two is why commands sometimes
 * fail with "系统找不到指定的路径". This is a SAFETY NET behind the
 * `<shell_paths>` context section (which tells the model the real paths);
 * it catches the slips.
 *
 * Conservative on purpose:
 *  - Multi-root: only an EXACT mount name (`/<mountName>`) is replaced with
 *    that mount's real path.
 *  - Single-root: a leading `/segment` token is only replaced when `segment`
 *    matches a top-level entry of the real root (verified via readdirSync), so
 *    cmd switches like `xcopy /s` are never touched.
 *  - Tokens preceded by `:` (URLs like https://x, drive paths D:/x) or by a
 *    word character are never rewritten.
 */
/**
 * Rewrite foreign-shell idioms the model emits despite the prompt guidance.
 * Real case: a cmd/bash-trained model writes the cmd.exe `cd /d <path>` while
 * the agent terminal is PowerShell, where Set-Location has no `/d` flag — the
 * command fails with "PositionalParameterNotFound" before doing anything.
 * Verified in llm.log: Qwen3-27B keeps emitting `cd /d` even with an explicit
 * "NEVER write cd /d" system rule, so the fix belongs at the deterministic
 * shell-compat layer (same spirit as translateVirtualPathsInCommand), not in
 * more prompting.
 */
function adaptCommandToShell(command: string): string {
  if (!command) return command;
  const family = detectShell().family;
  if (family === "powershell5" || family === "powershell7") {
    // `cd /d path` -> `cd path` (Set-Location switches drives by itself).
    return command.replace(/(\bcd)\s+\/d\b/gi, "$1");
  }
  return command;
}

export function translateVirtualPathsInCommand(
  command: string,
  mounts: WorkspaceMount[],
  singleRoot: boolean,
): string {
  if (!command) return command;
  // Token start boundary: start/space/quote/paren/comma/equals/ampersand —
  // deliberately NOT ":" (URL scheme / drive separator) and NOT "\\" (already
  // inside a Windows path).
  const PRE = "(^|[\\s\"'=(,;&])";

  if (singleRoot) {
    const root = mounts[0].realPath.replace(/[\\/]+$/, "");
    let top: Set<string>;
    try {
      top = new Set(fs.readdirSync(root).map((e) => e.toLowerCase()));
    } catch {
      return command;
    }
    return command.replace(
      new RegExp(`${PRE}\\/([A-Za-z0-9_.\\-\\u4e00-\\u9fff]+)`, "g"),
      (full, pre: string, seg: string) => {
        if (!top.has(seg.toLowerCase())) return full;
        return `${pre}${root}\\${seg}`;
      },
    );
  }

  let result = command;
  for (const m of mounts) {
    const re = new RegExp(`${PRE}\\/${m.name}(?=[\\\\/]|\\s|'|"|$)`, "gi");
    result = result.replace(re, (_full, pre: string) => `${pre}${m.realPath}`);
  }
  return result;
}

/** Run a shell command in `cwd`, returning the deepagents `ExecuteResponse`. */
const EXEC_TIMEOUT_MS = 120_000;
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;
/** How long to wait for VS Code shell integration to come up before giving up
 *  and falling back to headless exec. */
const SHELL_INTEGRATION_TIMEOUT_MS = 10_000;
/** Cap on bytes held in memory from a real-terminal run (the full text is also
 *  offloaded to disk, so this only bounds in-process memory). */
const TERMINAL_MEMORY_CAP = 30 * 1024 * 1024;
/** Silence window after which a prompt-like last line is treated as an
 *  interactive stall (focuses the terminal so the user can type). Mirrors
 *  Kiro's INPUT_STALL_TIMEOUT (5s). */
const INPUT_STALL_TIMEOUT_MS = 5_000;
/** Longer silence window after which a non-prompt command is still revealed
 *  (no focus steal) so it never hangs invisibly. Mirrors Kiro's
 *  RAW_DATA_READ_TIMEOUT (10s). */
const RAW_DATA_READ_TIMEOUT_MS = 10_000;

/**
 * Cap the output that flows back into the model's context. A verbose command
 * (build / test / log) can emit megabytes; echoing all of it would burn tokens
 * on every subsequent turn. When output exceeds the cap we keep a HEAD and a
 * TAIL (so the start of the run AND the final error/result survive) and offload
 * the FULL text to a scratch file under the workspace `tmp/` folder — the model
 * can then `grep`/`read_file` that file if it needs more. The note embedded in
 * the returned string tells the model where the full text went.
 */
const MAX_MODEL_OUTPUT = 6 * 1024;
const OUTPUT_HEAD = 2_500;
const OUTPUT_TAIL = 2_500;
function offloadIfLarge(
  output: string,
  cwd: string,
): { output: string; offloaded: boolean } {
  if (output.length <= MAX_MODEL_OUTPUT) {
    return { output, offloaded: false };
  }
  const head = output.slice(0, OUTPUT_HEAD);
  const tail = output.slice(-OUTPUT_TAIL);
  const kb = Math.round(output.length / 1024);
  let note: string;
  try {
    const dir = path.join(cwd, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = `offload-${Date.now()}.log`;
    fs.writeFileSync(path.join(dir, file), output, "utf8");
    note =
      `\n… [${kb} KB of output omitted; FULL TEXT saved to ` +
      `tmp/${file} — grep/read it with the execute or read_file tools] …\n`;
  } catch {
    note = `\n… [${kb} KB of output omitted] …\n`;
  }
  return { output: `${head}${note}${tail}`, offloaded: true };
}

// ---------------------------------------------------------------------------
// LLM I/O logging (debug aid). Appends every prompt we SEND to the model and
// every message bundle the agent RETURNS to `<workspace>/tmp/llm.log`, so the
// user can inspect whether large content (command output, file dumps, …) can be
// trimmed to save tokens. Gated by the `continue.deepAgent.llmLogEnabled`
// setting (default on). Messages are dumped as role + text (not raw LangChain
// objects) to avoid circular-ref / junk serialization.
// ---------------------------------------------------------------------------
export function logLlmIo(
  section: string,
  content: string,
  rootOverride?: string,
  sessionId?: string,
): void {
  try {
    const enabled = vscode.workspace
      .getConfiguration("continue")
      .get<boolean>("deepAgent.llmLogEnabled", true);
    if (!enabled) return;
    // Resolve the workspace root for the file. Prefer the agent's actual
    // operating root (rootOverride), then the first mounted workspace folder,
    // then the extension's cwd as a last resort — so the log lands inside the
    // project the user is actually working on, not some unrelated directory.
    const layout = getWorkspaceLayout(rootOverride);
    const root =
      rootOverride ||
      layout.mounts[0]?.realPath ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      process.cwd();
    const p = path.join(root, "tmp", "llm.log");
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const ts = new Date().toISOString();
    // `sid` is the chat-session id (one per DeepAgent panel). The log viewer
    // groups entries by it so a long llm.log can be browsed per conversation.
    const header =
      `\n\n========== ${section} @ ${ts}` +
      (sessionId ? ` [sid=${sessionId}]` : ``) +
      ` (chars=${content.length}, ~tokens≈${Math.round(content.length / 3.5)}) ` +
      `==========\n`;
    fs.appendFileSync(p, header + content + "\n", "utf8");
    // Surface the real path so a failed / mis-targeted write is discoverable —
    // the old silent catch hid where (or whether) the file was created.
    console.log(`[DeepAgent] llm.log -> ${p}`);
  } catch (e) {
    console.log(`[DeepAgent] llm.log write FAILED: ${String(e)}`);
  }
}

/** Render a LangChain message list (or ChatMessage list) into readable text. */
export function formatMessagesForLog(messages: any[]): string {
  if (!Array.isArray(messages)) return String(messages ?? "");
  const parts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const role = m?.role ?? m?._getType?.() ?? m?.type ?? "?";
    let text = "";
    if (typeof m?.content === "string") text = m.content;
    else if (Array.isArray(m?.content))
      text = m.content
        .filter((p: any) => p?.type === "text")
        .map((p: any) => p.text ?? "")
        .join("");
    else if (m?.content != null) text = String(m.content);
    const calls =
      Array.isArray(m?.tool_calls) && m.tool_calls.length
        ? `\n  [tool_calls: ${m.tool_calls.map((c: any) => c.name).join(", ")}]`
        : "";
    parts.push(`--- [${i}] ${role} ---\n${text}${calls}`);
  }
  return parts.join("\n");
}

/**
 * Strip ANSI escape sequences and VS Code shell-integration OSC markers
 * (OSC 633 / 133) from terminal output so the text we hand to the model and
 * write to the offload log is clean plaintext. Built with fromCharCode so the
 * pattern carries no literal control characters.
 */
const ANSI_REGEX = (() => {
  const ESC = String.fromCharCode(27);
  const BEL = String.fromCharCode(7);
  // CSI: ESC [ params intermediates final. The literal `[` after ESC MUST be
  // escaped ("\\[") — unescaped it opens a character class and the pattern
  // degenerates into stripping ESC + one char, leaving "1;33m…" junk behind
  // (and eating the ESC] of OSC sequences so "633:…" survived too).
  // OSC: ESC ] id ; payload terminated by BEL *or* ST (ESC + literal backslash
  // — regex source "\\\\", JS string "\\\\"). VS Code shell-integration
  // sequences (OSC 633/133) end with ST; only matching BEL used to leave the
  // whole payload — including the wrapped command output — in the text.
  return new RegExp(
    ESC +
      "\\[[0-9;?]*[ -/]*[@-~]" +
      "|" +
      ESC +
      "][0-9;]*;[^" +
      BEL +
      ESC +
      "]*(?:" +
      BEL +
      "|" +
      ESC +
      "\\\\)",
    "g",
  );
})();
function stripAnsi(s: string): string {
  return (
    s
      .replace(ANSI_REGEX, "")
      // Stray C0 control bytes that survive decoding (NUL, …). Keep the useful
      // whitespace ones (\n \r \t).
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  );
}

/**
 * Interactive-prompt patterns (ported from Kiro) — used to detect when a
 * command is blocked waiting for user input ([y/n], password, sudo, …) so we
 * can surface the terminal to the user instead of letting the agent hang.
 */
const INTERACTIVE_PROMPT_PATTERNS: RegExp[] = [
  // Yes/No confirmation brackets
  /\[y(?:es)?\/n(?:o)?\]/i,
  /\(y(?:es)?\/n(?:o)?\)/i,
  /\[n(?:o)?\/y(?:es)?\]/i,
  /\(n(?:o)?\/y(?:es)?\)/i,
  // Password / credential prompts
  /password\s*:\s*$/i,
  /passphrase.*:\s*$/i,
  /username\s*:\s*$/i,
  /login\s*:\s*$/i,
  // sudo
  /\[sudo\] password for /i,
  // SSH host key verification
  /authenticity of host .* can't be established/i,
  /Are you sure you want to continue connecting/i,
  // Git credential prompts
  /Username for '.*':\s*$/i,
  /Password for '.*':\s*$/i,
  // npm / npx
  /Ok to proceed\?\s*\(y\)/i,
  // General confirmation phrases that end the line
  /Are you sure\b.*\?\s*$/i,
  /Do you want to\b.*\?\s*$/i,
  /Do you wish to\b.*\?\s*$/i,
  /Would you like to\b.*\?\s*$/i,
  /Overwrite\b.*\?\s*$/i,
  // Press key prompts
  /Press (ENTER|any key|RETURN|a key) to /i,
  /Hit Enter to /i,
  // apt / apt-get (Linux)
  /\d+ upgraded, \d+ newly installed.*Do you want to continue/i,
  // yum / dnf (Linux)
  /Is this ok \[y\/d\/N\]/i,
  /Is this ok \[y\/N\]/i,
  // pacman (Arch Linux)
  /:: Proceed with installation\?/i,
  // brew (macOS)
  /Press RETURN to continue/i,
  // PowerShell / Windows
  /\[Y\] Yes\s+\[A\] Yes to All\s+\[N\] No/i,
  /Confirm\s*\[Y\/N\]/i,
  /\(default is "Y"\)\s*:\s*$/i,
  /\(default is "N"\)\s*:\s*$/i,
  // Docker
  /Are you sure you want to prune/i,
  // pip
  /Proceed \(Y\/n\)\?\s*$/i,
  // Ruby bundler / gem
  /Overwrite .*\? \[Ynaqdhm\]/i,
  // General "type to continue" patterns
  /Enter a (name|value|number|project|password|username).*:\s*$/i,
  /Type .* to confirm/i,
  // Heredoc prompt
  /^heredoc>/i,
];
function detectInteractivePrompt(lastLine: string): boolean {
  const trimmed = lastLine.trim();
  if (!trimmed) return false;
  return INTERACTIVE_PROMPT_PATTERNS.some((p) => p.test(trimmed));
}

/**
 * Maximum runtime for a command, in ms. Mirrors Kiro's `terminalCommandTimeout`
 * setting — configurable via `continue.deepAgent.execute.commandTimeout`,
 * falling back to EXEC_TIMEOUT_MS when unset. On timeout the command is NOT
 * killed (it keeps running in the visible terminal); the agent just receives
 * the partial output plus a timeout note.
 */
function execTimeoutMs(): number {
  const cfg = vscode.workspace
    .getConfiguration("continue")
    .get<number>("deepAgent.execute.commandTimeout");
  return typeof cfg === "number" && cfg > 0 ? cfg : EXEC_TIMEOUT_MS;
}

// ─── Real-terminal execution (live + interactive, with disk offload) ─────────
// A single VS Code terminal is reused for every command so the user sees a
// continuous shell session. Shell integration (when the user's shell supports
// it) yields a clean output stream + exit code; if it is unavailable we fall
// back to headless exec (see runCommandViaExec). The FULL output is always
// captured and offloaded to a scratch file, so the model can later grep/read
// the ENTIRE result regardless of how much was truncated for the context.

// Live-tail of the currently running `execute` command, surfaced to the chat's
// "Run Command" card so it can show the latest output while the command runs
// (instead of a static "running" placeholder). `DeepAgentLLM` polls this every
// second and re-emits the pending block. Single-slot: the agent runs tools
// sequentially, so at most one execute is in flight — if that ever changes,
// this would need keying by command.
let liveExecuteText = "";
let liveExecuteActive = false;
export function getLiveExecuteTail(maxLines = 10): string {
  if (!liveExecuteActive) return "";
  const text = stripAnsi(liveExecuteText);
  const lines = text.split(/\r?\n/);
  return lines.slice(-maxLines).join("\n");
}

// runId of the currently running `execute` command, set by DeepAgentLLM so the
// progress events can be keyed per run (avoids cross-command contamination in
// the GUI's live card). Single-slot: matches the sequential tool execution.
let pendingExecuteRunId = "";
export function setExecuteRunId(id: string): void {
  pendingExecuteRunId = id;
}
let agentTerminal: vscode.Terminal | undefined;
let agentTerminalCwd: string | undefined;
let agentShellIntegration: Promise<any> | undefined;

// The abort signal for the CURRENT chat turn (set by the DeepAgent wrapper when
// a turn starts, cleared when it ends). The execute tool reads it so a "Stop"
// press interrupts the running terminal command instead of leaving the tool
// await (and the whole turn) hanging on "processing".
let activeTurnAbort: AbortSignal | undefined;
export function setActiveTurnAbort(signal: AbortSignal | undefined): void {
  activeTurnAbort = signal;
}

function waitForShellIntegration(
  term: vscode.Terminal,
  timeoutMs: number,
): Promise<any> {
  if (term.shellIntegration) return Promise.resolve(term.shellIntegration);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      listener.dispose();
      resolve(undefined);
    }, timeoutMs);
    const listener = vscode.window.onDidChangeTerminalShellIntegration((e) => {
      if (e.terminal === term && e.shellIntegration) {
        clearTimeout(timer);
        listener.dispose();
        resolve(e.shellIntegration);
      }
    });
  });
}

/**
 * Directory equality for the agent-terminal reuse check. Windows paths are
 * case-insensitive and may arrive with different separators/drive-letter case
 * (`D:\a\b` vs `d:\a\b` vs `D:/a/b`) depending on which backend produced the
 * cwd — treating those as different directories used to spawn a NEW terminal
 * for every command while the old ones stayed open forever.
 */
function sameAgentDir(a: string | undefined, b: string): boolean {
  if (!a) return false;
  if (a === b) return true;
  if (process.platform !== "win32") return false;
  const norm = (p: string) =>
    p
      .replace(/[\\/]+/g, "\\")
      .replace(/\\$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

async function ensureAgentTerminal(
  cwd: string,
): Promise<vscode.Terminal | undefined> {
  if (agentTerminal && sameAgentDir(agentTerminalCwd, cwd)) {
    return agentTerminal;
  }
  // The terminal is STATEFUL — a previous command's `cd` persists, so a
  // different cwd cannot be safely reused (relative-path commands would run
  // in the wrong directory). Replace the session, and DISPOSE the stale
  // terminal so at most ONE "DeepAgent" terminal is ever alive (the old code
  // leaked one terminal per cwd switch).
  if (agentTerminal) {
    try {
      agentTerminal.dispose();
    } catch {
      /* ignore */
    }
    agentTerminal = undefined;
    agentTerminalCwd = undefined;
    agentShellIntegration = undefined;
  }
  let term: vscode.Terminal;
  try {
    term = vscode.window.createTerminal({
      name: "DeepAgent",
      cwd,
      isTransient: true,
      // Disable pagers so commands (git/gh/man/…) never block waiting for the
      // user to scroll/press a key inside the agent terminal.
      env: {
        ...process.env,
        ...extraCommandEnv(),
        PAGER: "",
        GIT_PAGER: "",
        GH_PAGER: "",
        MANPAGER: "",
        BAT_PAGER: "",
        DELTA_PAGER: "",
        SYSTEMD_PAGER: "",
        AWS_PAGER: "",
      },
    });
  } catch {
    return undefined;
  }
  agentTerminal = term;
  agentTerminalCwd = cwd;
  agentShellIntegration = waitForShellIntegration(
    term,
    SHELL_INTEGRATION_TIMEOUT_MS,
  );
  registerAgentTerminalCloseListener();
  return term;
}

// Registered ONCE for the extension lifetime — the old code registered a fresh
// onDidCloseTerminal listener on EVERY terminal creation, leaking listeners.
let agentTerminalCloseListenerRegistered = false;
function registerAgentTerminalCloseListener(): void {
  if (agentTerminalCloseListenerRegistered) return;
  agentTerminalCloseListenerRegistered = true;
  vscode.window.onDidCloseTerminal((t) => {
    if (t === agentTerminal) {
      agentTerminal = undefined;
      agentTerminalCwd = undefined;
      agentShellIntegration = undefined;
    }
  });
}

/**
 * Reveal/focus the shared agent terminal (Run Command card's terminal icon).
 * Shows the REAL terminal where commands run, so the user can watch live
 * output the model may have truncated. If the terminal doesn't exist yet
 * (no command ran this session), create it at the workspace root first.
 */
export function showAgentTerminal(): void {
  if (agentTerminal) {
    try {
      agentTerminal.show(true);
    } catch {
      /* terminal was disposed between check and show — ignore */
    }
    return;
  }
  const root = getWorkspaceLayout().mounts[0]?.realPath ?? process.cwd();
  void ensureAgentTerminal(root)
    .then((term) => {
      try {
        term?.show(true);
      } catch {
        /* ignore */
      }
    })
    .catch(() => {
      /* ignore */
    });
}

/**
 * Run `command` in the shared real VS Code terminal. Returns null when shell
 * integration is unavailable or the run cannot be performed, signalling the
 * caller to fall back to headless exec.
 */
async function runCommandViaTerminal(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{
  output: string;
  exitCode: number | null;
  truncated: boolean;
} | null> {
  const term = await ensureAgentTerminal(cwd);
  const si = await agentShellIntegration;
  if (!term || !si || typeof (si as any).executeCommand !== "function")
    return null;
  if (signal?.aborted) {
    return {
      output: "（命令已被用户终止，未执行）",
      exitCode: null,
      truncated: false,
    };
  }

  let execution: any;
  try {
    execution = (si as any).executeCommand(command);
  } catch {
    return null;
  }
  const readFn =
    typeof execution?.read === "function"
      ? execution.read.bind(execution)
      : undefined;
  if (!readFn) return null;

  liveExecuteActive = true;
  liveExecuteText = "";

  // Stream INCREMENTAL (ANSI-stripped) output to the GUI's running card via a
  // webview event keyed by runId — NOT a chat-text re-emission, so the GUI needs
  // no dedup. Each tick we send only the NEW text since the last send, so a
  // single command accumulates its FULL output on the card and the user can
  // scroll back through the whole history. DeepAgentLLM set `pendingExecuteRunId`
  // right before this call started.
  const progressRunId = pendingExecuteRunId;
  let sentLen = 0;
  const postProgress = (done = false, code: number | null = null) => {
    try {
      const stripped = stripAnsi(liveExecuteText);
      const chunk = stripped.slice(sentLen);
      if (chunk) {
        postExecuteProgress(progressRunId, chunk);
        sentLen = stripped.length;
      }
      if (done) postExecuteProgressDone(progressRunId, code);
    } catch {
      /* ignore */
    }
  };
  postProgress(); // arm the timer (no new text yet on the first call)
  const progressTimer = setInterval(postProgress, 1000);

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  let timedOut = false;
  let finished = false;
  let interactiveStall = false;
  let revealedIdle = false;
  let lastDataAt = Date.now();
  let accText = "";

  // Surface the terminal when a command is blocked on input (focus it so the
  // user can type), or — after a longer silence with no identifiable prompt —
  // just reveal it (no focus steal) so nothing hangs invisibly.
  const revealForStall = () => {
    if (interactiveStall) return;
    interactiveStall = true;
    try {
      term.show(false); // focus the terminal
    } catch {
      /* ignore */
    }
  };
  const revealIdle = () => {
    if (revealedIdle || interactiveStall) return;
    revealedIdle = true;
    try {
      term.show(true); // reveal without stealing focus
    } catch {
      /* ignore */
    }
  };

  // Silence watcher (mirrors Kiro's stall detection): if the command goes quiet
  // it may be waiting for input or hung. After INPUT_STALL_TIMEOUT of silence
  // with a prompt-like last line, focus the terminal; after RAW_DATA_READ_TIMEOUT
  // of silence even without a recognised prompt, still reveal it.
  const stallWatcher = setInterval(() => {
    if (finished || timedOut) return;
    const idle = Date.now() - lastDataAt;
    const lastLine = accText.trimEnd().split("\n").pop() ?? "";
    if (idle >= INPUT_STALL_TIMEOUT_MS && detectInteractivePrompt(lastLine)) {
      revealForStall();
    } else if (idle >= RAW_DATA_READ_TIMEOUT_MS) {
      revealIdle();
    }
  }, 1000);

  const readTask = (async () => {
    try {
      for await (const data of readFn() as AsyncIterable<Uint8Array>) {
        if (timedOut) break;
        const buf = Buffer.from(data);
        if (totalBytes < TERMINAL_MEMORY_CAP) {
          chunks.push(buf);
          totalBytes += buf.length;
        }
        accText += buf.toString("utf8");
        liveExecuteText = accText; // expose latest output for the live card
        lastDataAt = Date.now();
      }
    } catch {
      // ignore stream errors — we already have whatever arrived
    }
  })();

  let abortedByUser = false;

  const timeoutMs = execTimeoutMs();
  // Wait for the execution to actually END. `execution.exitCode` is a plain
  // property that stays undefined WHILE the command is running — resolving
  // Promise.resolve(exitCode) returns instantly with a fake exit 0 and we
  // would capture almost no output (the "（无输出）" Run Command card). The
  // reliable end signals are the onDidEndTerminalShellExecution event, the
  // terminal being closed/killed, and exitCode becoming defined (polled as a
  // safety net).
  let resolveExit!: (value: { exit: number | null }) => void;
  let resolved = false;
  let exitListener: vscode.Disposable | undefined;
  let exitPoll: ReturnType<typeof setInterval> | undefined;
  let closeListener: vscode.Disposable | undefined;
  let abortRemover: (() => void) | undefined;
  const doResolve = (exit: number | null) => {
    if (resolved) return;
    resolved = true;
    try {
      exitListener?.dispose();
    } catch {
      /* ignore */
    }
    if (exitPoll) clearInterval(exitPoll);
    try {
      closeListener?.dispose();
    } catch {
      /* ignore */
    }
    try {
      abortRemover?.();
    } catch {
      /* ignore */
    }
    exitListener = undefined;
    exitPoll = undefined;
    closeListener = undefined;
    abortRemover = undefined;
    // Resolve with the OBJECT shape `exitPromise` declares — resolving a bare
    // number made `const { exit } = await exitOrTimeout` destructure to
    // undefined, so every normally-finished command reported
    // "exit code undefined" and its Run Command card was painted red even on
    // success (BUILD SUCCESS but red card).
    resolveExit({ exit });
  };
  const exitPromise = new Promise<{ exit: number | null }>((res) => {
    resolveExit = res;
    if (execution.exitCode !== undefined) {
      // Fast command — already finished.
      doResolve((execution.exitCode ?? 0) as number);
      return;
    }
    try {
      exitListener = vscode.window.onDidEndTerminalShellExecution((e: any) => {
        if (e.execution === execution) doResolve((e.exitCode ?? 0) as number);
      });
    } catch {
      exitListener = undefined;
    }
    // Safety net in case the end event never fires on this fork.
    exitPoll = setInterval(() => {
      if (execution.exitCode !== undefined)
        doResolve(execution.exitCode as number);
    }, 250);
    // Terminal killed directly (the "kill terminal" button): the running
    // command is gone; stop waiting so the turn can wind down.
    try {
      closeListener = vscode.window.onDidCloseTerminal((t: any) => {
        if (t === term) doResolve(execution.exitCode ?? null);
      });
    } catch {
      closeListener = undefined;
    }
  });

  // User abort (the "Stop" button): interrupt the running command with Ctrl+C
  // and stop waiting. Without this, a long-running terminal command keeps the
  // tool await pending and the whole turn hangs on "processing".
  if (signal) {
    const onAbort = () => {
      abortedByUser = true;
      try {
        term.sendText("\u0003"); // Ctrl+C
      } catch {
        /* ignore */
      }
      doResolve(null);
    };
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener("abort", onAbort);
      abortRemover = () => signal.removeEventListener("abort", onAbort);
    }
  }

  // STALL-AWARE timeout (replaces the old hard total-time limit). A timer
  // checks every second and only fires when the command goes SILENT for
  // `timeoutMs` (hung / waiting forever) or the absolute hard cap is reached.
  // A long but actively-streaming build (mvn: several minutes of continuous
  // [INFO] lines) is NEVER cut off — previously a 2-minute hard limit painted
  // successful slow builds red (exitCode null) while the command went on to
  // finish fine in the visible terminal.
  let killTimeoutTimer: ReturnType<typeof setInterval> | undefined;
  let timeoutReason = "";
  const exitOrTimeout = Promise.race([
    exitPromise,
    new Promise<{ exit: number | null }>((resolve) => {
      const startedAt = Date.now();
      const hardCapMs = Math.max(timeoutMs * 5, 10 * 60_000);
      killTimeoutTimer = setInterval(() => {
        if (finished) return;
        const idleMs = Date.now() - lastDataAt;
        const totalMs = Date.now() - startedAt;
        if (totalMs >= hardCapMs) {
          timeoutReason = `hard limit of ${Math.round(hardCapMs / 1000)} s total`;
        } else if (idleMs >= timeoutMs) {
          timeoutReason = `no output for ${Math.round(timeoutMs / 1000)} s`;
        } else {
          return; // still streaming (or below both thresholds) — keep waiting
        }
        timedOut = true;
        // On timeout we do NOT kill the command (mirrors Kiro) — it keeps
        // running in the now-visible terminal so the user can interact with it.
        if (interactiveStall) {
          try {
            term.show(false); // focus so the user can respond
          } catch {
            /* ignore */
          }
        } else {
          try {
            term.show(true);
          } catch {
            /* ignore */
          }
        }
        resolve({ exit: null });
      }, 1000);
    }),
  ]);

  const { exit } = await exitOrTimeout;
  finished = true;
  doResolve(exit); // ensure all listeners are cleaned up
  if (killTimeoutTimer) clearInterval(killTimeoutTimer);
  clearInterval(stallWatcher);
  // Give the output stream a moment to flush trailing bytes (terminal data
  // events can lag slightly behind the end-of-execution signal).
  await Promise.race([readTask, new Promise<void>((r) => setTimeout(r, 1500))]);

  const full = stripAnsi(decodeConsoleOutput(Buffer.concat(chunks)));
  const offloaded = offloadIfLarge(full, cwd);
  let output = offloaded.output;
  if (timedOut) {
    const kb = Math.round(full.length / 1024);
    const stallNote = interactiveStall
      ? " Command appears to be WAITING FOR INPUT (e.g. [y/n] / password) — the terminal is focused; type your response there, or ask the user to respond."
      : " The command may still be RUNNING in the visible terminal (not killed).";
    const where = offloaded.offloaded
      ? "the offload file referenced above"
      : "tmp/ (open the terminal or re-run to capture it)";
    output +=
      `\n… [stopped waiting: ${timeoutReason}; ${kb} KB captured so far.${stallNote} ` +
      `Full captured text is at ${where}] …\n`;
  } else if (abortedByUser) {
    output = output.trimEnd()
      ? output +
        "\n… [命令已被用户终止（Ctrl+C）。已捕获的中断前输出见上/落盘文件] …\n"
      : "（命令已被用户终止，无输出）";
  }
  if (progressTimer) clearInterval(progressTimer);
  postProgress(true, exit); // final slice + completion signal (flip card in place)
  liveExecuteActive = false; // done — stop exposing live tail
  return { output, exitCode: exit, truncated: offloaded.offloaded };
}

/** Headless fallback — the original child_process.exec implementation. */
function runCommandViaExec(
  command: string,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        windowsHide: true,
        shell: true,
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: execTimeoutMs(),
        encoding: "buffer", // raw bytes — decoded by decodeConsoleOutput below
        // Kill the child immediately when the user presses "Stop".
        ...(signal ? { signal } : {}),
        // Inherit the extension host env, then layer the user's overrides on
        // top (JAVA_HOME, PATH additions, …).
        env: { ...process.env, ...extraCommandEnv() },
      },
      (error, stdout, stderr) => {
        const out = stdout as unknown as Buffer;
        const err = stderr as unknown as Buffer;
        const full = stripAnsi(
          decodeConsoleOutput(out) + decodeConsoleOutput(err),
        );
        const offloaded = offloadIfLarge(full, cwd);
        let exitCode: number | null = 0;
        if (error) {
          if (typeof error.code === "number") exitCode = error.code;
          else if (
            (error as NodeJS.ErrnoException).killed ||
            error.code === "ETIMEDOUT"
          )
            exitCode = null;
          else exitCode = 1;
        }
        resolve({
          output: offloaded.output,
          exitCode,
          truncated: offloaded.offloaded,
        });
      },
    );
  });
}

/**
 * Command execution entry point.
 *
 * Best of both worlds: try a REAL VS Code terminal with shell integration so
 * the user can watch the command live and interact with it, while the FULL
 * output is still captured and offloaded to a scratch file for later `grep`/
 * `read_file`. If shell integration is unavailable (e.g. shells without
 * integration support) or anything fails, fall back to the original headless
 * `child_process.exec` so behaviour never regresses.
 */
function runCommand(
  command: string,
  cwd: string,
  danger?: { real: string[]; prefixes: string[] },
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  // Observe the current turn's abort so "Stop" ends a running command too.
  const signal = activeTurnAbort;
  // HARD BLOCK: never let a command recursively delete the OS root, a drive
  // root, the user's home, or an ENTIRE workspace (real path or virtual mount).
  // This is independent of the permission policy and the allowlist — those
  // cannot grant it. Returns immediately; the model just sees a denial.
  const fallback = getWorkspaceLayout();
  const real = danger?.real ?? fallback.mounts.map((m) => m.realPath);
  const prefixes =
    danger?.prefixes ?? fallback.mounts.map((m) => m.virtualPath);
  if (isDestructiveRootCommand(command, real, prefixes)) {
    return Promise.resolve({
      output:
        "⛔ 已阻止执行：该命令会递归删除系统根目录或整个工作区（如 rm -rf /、" +
        "del /s /q C:\\、format、mkfs 等），不允许运行。",
      exitCode: 1,
      truncated: false,
    });
  }
  // The prompt steers the model to redirect verbose output to `tmp/…`, but
  // Windows `>` creates the FILE only, NOT the directory — a missing tmp/
  // folder fails the redirect ("系统找不到指定的路径") before the command even
  // runs. Pre-create the standard scratch folder so redirects never fail.
  try {
    fs.mkdirSync(path.join(cwd, "tmp"), { recursive: true });
  } catch {
    // ignore — the command itself will surface a real error if it matters
  }
  return runCommandViaTerminal(command, cwd, signal)
    .catch(() => null)
    .then((r) => r ?? runCommandViaExec(command, cwd, signal));
}

// ---------------------------------------------------------------------------
// Background process management (mirrors Kiro's `control_pwsh_process` +
// `get_process_output` / `list_processes`). Each background process gets its OWN
// VS Code terminal so it can run indefinitely (dev servers, watchers) WITHOUT
// blocking the agent turn. The model starts it (returns immediately with an id),
// polls its output, and stops it. Exposed to the model as three custom tools.
// ---------------------------------------------------------------------------
interface BackgroundProcess {
  id: string;
  terminal: vscode.Terminal;
  command: string;
  cwd: string;
  output: string[];
  running: boolean;
  startedAt: number;
  dataListener?: vscode.Disposable;
  closeListener?: vscode.Disposable;
}

const backgroundProcesses = new Map<string, BackgroundProcess>();
let bgSeq = 0;

/**
 * Start `command` as a background process in its own terminal. If an identical
 * running process (same command + cwd) already exists it is reused. Returns
 * immediately; the caller polls via `getBackgroundProcessOutput`.
 */
export function startBackgroundProcess(
  command: string,
  cwd: string,
): { terminalId: string; isReused: boolean; error?: string } {
  for (const p of backgroundProcesses.values()) {
    if (p.running && p.command === command && p.cwd === cwd) {
      return { terminalId: p.id, isReused: true };
    }
  }
  // HARD BLOCK destructive root commands even in background.
  const layout = getWorkspaceLayout();
  const real = layout.mounts.map((m) => m.realPath);
  const prefixes = layout.mounts.map((m) => m.virtualPath);
  if (isDestructiveRootCommand(command, real, prefixes)) {
    return {
      terminalId: "",
      isReused: false,
      error:
        "⛔ 已阻止：该命令会递归删除系统根目录或整个工作区，不允许后台运行。",
    };
  }
  try {
    fs.mkdirSync(path.join(cwd, "tmp"), { recursive: true });
  } catch {
    // ignore
  }
  const id = `bg-${++bgSeq}-${Date.now().toString(36)}`;
  let term: vscode.Terminal;
  try {
    term = vscode.window.createTerminal({
      name: `BG ${id}: ${command.slice(0, 36)}`,
      cwd,
      env: {
        ...process.env,
        ...extraCommandEnv(),
        PAGER: "cat",
        GIT_PAGER: "cat",
      },
    });
  } catch {
    return { terminalId: "", isReused: false, error: "无法创建后台终端。" };
  }
  const proc: BackgroundProcess = {
    id,
    terminal: term,
    command,
    cwd,
    output: [],
    running: true,
    startedAt: Date.now(),
  };
  proc.closeListener = vscode.window.onDidCloseTerminal((t) => {
    if (t === term) proc.running = false;
  });
  // Run the command and capture its output. `term.onDidWriteData` is NOT part
  // of the stable Terminal API (and is absent on this VS Code fork) — calling
  // it threw "term.onDidWriteData is not a function" and crashed the whole
  // turn right after the user approved the background start. Capture instead:
  //   1. preferred — shell-integration execution stream (the same proven
  //      mechanism the foreground Run Command path uses);
  //   2. fallback — window-level onDidWriteTerminalData (proposed API);
  //   3. last resort — run without capture (polling then reports a notice
  //      instead of throwing).
  void (async () => {
    // Wait: shell integration arrives asynchronously after creation (the
    // foreground "DeepAgent" terminal uses the same 10s budget via
    // SHELL_INTEGRATION_TIMEOUT_MS). A too-short wait would wrongly fall back to
    // the window-level data event for a shell that was merely slow to start.
    const si: any = await waitForShellIntegration(
      term,
      SHELL_INTEGRATION_TIMEOUT_MS,
    );
    console.log(
      `[DeepAgent][BG ${id}] shellIntegration=${si ? "yes" : "no(absent after 10s)"} | command=${command.slice(0, 80)}`,
    );
    const launchCommand = adaptCommandToShell(command);
    if (si && typeof si.executeCommand === "function") {
      try {
        const execution = si.executeCommand(launchCommand);
        if (execution && typeof execution.read === "function") {
          try {
            for await (const data of execution.read() as AsyncIterable<Uint8Array>) {
              proc.output.push(Buffer.from(data).toString("utf8"));
              if (proc.output.length > 4000) proc.output.shift();
            }
          } catch {
            // stream ended (terminal closed / process killed) — output so far
            // is already buffered
          }
          return;
        }
      } catch {
        // executeCommand threw — fall through to the sendText paths below
      }
    }
    const w = vscode.window as any;
    if (typeof w.onDidWriteTerminalData === "function") {
      proc.dataListener = w.onDidWriteTerminalData((e: any) => {
        if (e?.terminal === term) {
          proc.output.push(Buffer.from(e.data ?? "").toString("utf8"));
          if (proc.output.length > 4000) proc.output.shift();
        }
      });
      term.sendText(launchCommand);
      return;
    }
    // No capture mechanism available at all: the process still runs in its
    // visible terminal, and polling surfaces a clear notice instead of the
    // previous hard TypeError.
    proc.output.push(
      "（此环境不支持后台输出捕获——进程已在终端中启动，请直接查看终端窗口。）\n",
    );
    term.sendText(launchCommand);
  })();
  // Reveal so the user can watch the long-running process.
  try {
    term.show(true);
  } catch {
    /* ignore */
  }
  backgroundProcesses.set(id, proc);
  return { terminalId: id, isReused: false };
}

/** Return the captured output (and running state) of a background process. */
export function getBackgroundProcessOutput(terminalId: string): {
  output: string;
  running: boolean;
  found: boolean;
} {
  const p = backgroundProcesses.get(terminalId);
  if (!p) return { output: "", running: false, found: false };
  // stripAnsi: terminal streams carry cursor/color escapes that only waste
  // model tokens (mvn/npm output is full of them).
  return {
    output: stripAnsi(p.output.join("")),
    running: p.running,
    found: true,
  };
}

/** Stop and dispose a background process. */
export function stopBackgroundProcess(terminalId: string): {
  success: boolean;
  message: string;
} {
  const p = backgroundProcesses.get(terminalId);
  if (!p) {
    return {
      success: false,
      message: `没有 id 为 "${terminalId}" 的后台进程。`,
    };
  }
  try {
    p.dataListener?.dispose();
    p.closeListener?.dispose();
    p.terminal.dispose();
  } catch {
    // ignore
  }
  p.running = false;
  backgroundProcesses.delete(terminalId);
  return {
    success: true,
    message: `已停止后台进程 ${terminalId}（命令：${p.command}）。`,
  };
}

/** List all tracked background processes. */
export function listBackgroundProcesses(): Array<{
  terminalId: string;
  command: string;
  cwd: string;
  running: boolean;
  startedAt: number;
}> {
  return [...backgroundProcesses.values()].map((p) => ({
    terminalId: p.id,
    command: p.command,
    cwd: p.cwd,
    running: p.running,
    startedAt: p.startedAt,
  }));
}

/**
 * Build the three custom tools that expose the background-process registry to the
 * model (mirrors Kiro's `control_pwsh_process` + `get_process_output` /
 * `list_processes`). Returned as LangChain `DynamicStructuredTool`s so they drop
 * straight into `createDeepAgent({ tools })`. The model receives their schemas
 * in the system prompt automatically.
 */
export function createBackgroundProcessTools(): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: "control_process",
      description: [
        "Control LONG-RUNNING background processes (dev servers, build watchers,",
        "test watchers, daemons) so they run in their own terminal WITHOUT blocking",
        "your turn.",
        "",
        "# ACTIONS",
        '- "start": run a shell command as a background process (e.g. `npm run dev`,',
        "  `yarn start`, `webpack --watch`, `python manage.py runserver`). Returns",
        "  IMMEDIATELY with a `terminalId`; the process keeps running in its own",
        "  terminal. Poll its output with `get_process_output` and list all with",
        "  `list_processes`. An identical running process (same command + cwd) is",
        "  reused instead of starting a duplicate.",
        '- "stop": terminate a background process by `terminalId` and free its terminal.',
        "",
        "# RULES",
        "- Use `start` ONLY for commands that do NOT exit quickly. For normal",
        "  one-shot commands use the `execute` tool instead.",
        "- NEVER use `cd` — pass the `cwd` argument to choose the working directory.",
        "  A bare `cd` will fail.",
        "- The `start` action returns immediately; do not wait for the process to",
        "  finish before continuing with other tasks.",
      ].join("\n"),
      schema: z.object({
        action: z
          .enum(["start", "stop"])
          .describe(
            '"start" to launch a background process, "stop" to end one',
          ),
        command: z
          .string()
          .optional()
          .nullable()
          .describe(
            "The shell command to run as a background process (required for 'start')",
          ),
        cwd: z
          .string()
          .optional()
          .nullable()
          .describe("Working directory for the process (optional for 'start')"),
        terminalId: z
          .string()
          .optional()
          .nullable()
          .describe(
            "The terminalId of the process to stop (required for 'stop')",
          ),
      }),
      func: async (input: any) => {
        if (input.action === "start") {
          const layout = getWorkspaceLayout();
          const cwd = input.cwd || layout.mounts[0]?.realPath || process.cwd();
          const r = startBackgroundProcess(input.command ?? "", cwd);
          if (r.error) return r.error;
          return JSON.stringify({
            terminalId: r.terminalId,
            isReused: r.isReused,
          });
        }
        return JSON.stringify(stopBackgroundProcess(input.terminalId ?? ""));
      },
    }),
    new DynamicStructuredTool({
      name: "get_process_output",
      description:
        "Read the captured output of a background process started with `control_process` 'start'. Returns the `output` and whether it is still `running`. Use it to confirm a dev server started ('ready'/'listening') or to surface later errors.",
      schema: z.object({
        terminalId: z
          .string()
          .describe("The terminalId returned by `control_process` 'start'"),
      }),
      func: async (input: any) => {
        const r = getBackgroundProcessOutput(input.terminalId);
        if (!r.found) {
          return JSON.stringify({
            found: false,
            message: `No process with id ${input.terminalId}`,
          });
        }
        // Cap returned output to the last 20k chars to protect the context.
        const out = r.output.slice(-20000);
        return JSON.stringify({ running: r.running, output: out });
      },
    }),
    new DynamicStructuredTool({
      name: "list_processes",
      description:
        "List all currently tracked background processes (terminalId, command, cwd, running). Use it to discover terminalIds or check what is still running.",
      schema: z.object({}),
      func: async () => JSON.stringify(listBackgroundProcesses()),
    }),
  ];
}

/**
 * `FilesystemBackend` + command execution. Giving it an `execute` method and a
 * non-empty `id` makes `isSandboxBackend` return true, so deepagents registers
 * its BUILT-IN `execute` tool automatically (canonical description + output
 * format) — exactly how Kiro does it. Commands run in the workspace dir.
 */
class WorkspaceExecBackend extends FilesystemBackend {
  readonly id = "workspace";
  private readonly cwd: string;
  constructor(dir: string) {
    super({ rootDir: dir, virtualMode: true });
    this.cwd = dir;
  }
  async execute(command: string) {
    return runCommand(
      adaptCommandToShell(
        translateVirtualPathsInCommand(
          command,
          [{ virtualPath: "/", name: "root", realPath: this.cwd }],
          true,
        ),
      ),
      this.cwd,
      { real: [this.cwd], prefixes: ["/"] },
    );
  }
}

class WorkspaceRootBackend extends CompositeBackend {
  readonly id = "workspace";
  constructor(
    defaultBackend: FilesystemBackend,
    routes: Record<string, FilesystemBackend>,
    private readonly mounts: WorkspaceMount[],
  ) {
    super(defaultBackend, routes);
  }

  /**
   * Command execution runs in the FIRST workspace folder (the same dir the
   * default backend serves stray paths from). The built-in `execute` tool calls
   * this once `isSandboxBackend` is satisfied via `id` + this method.
   */
  async execute(command: string) {
    const singleRoot =
      this.mounts.length === 1 && this.mounts[0].virtualPath === "/";
    return runCommand(
      adaptCommandToShell(
        translateVirtualPathsInCommand(command, this.mounts, singleRoot),
      ),
      this.mounts[0].realPath,
      {
        real: this.mounts.map((m) => m.realPath),
        prefixes: this.mounts.map((m) => m.virtualPath),
      },
    );
  }

  async ls(path: string): Promise<LsResult> {
    if (path === "/" || path === "" || path === ".") {
      return {
        files: this.routePrefixes.map((prefix) => ({
          path: prefix,
          is_dir: true,
          size: 0,
          modified_at: "",
        })),
      };
    }
    return super.ls(path);
  }

  override async glob(
    pattern: string,
    path: string = "/",
  ): Promise<GlobResult> {
    const result = await super.glob(pattern, path);
    if (result.error) return result;
    const files = this.dedupeByRealPath(result.files ?? []).sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    return { ...result, files };
  }

  override async grep(
    pattern: string,
    path: string | null = "/",
    glob: string | null = null,
    maxCount: number | null = null,
  ): Promise<GrepResult> {
    const result = await super.grep(pattern, path, glob, maxCount);
    if (result.error) return result;
    const matches = this.dedupeByRealPath(result.matches ?? [], (m) =>
      String((m as { line_number?: number }).line_number ?? ""),
    ).sort((a, b) => {
      const byPath = a.path.localeCompare(b.path);
      if (byPath !== 0) return byPath;
      const la = (a as { line_number?: number }).line_number ?? 0;
      const lb = (b as { line_number?: number }).line_number ?? 0;
      return la - lb;
    });
    return { ...result, matches };
  }

  /**
   * Drop results that denote the same file on disk, preferring entries whose
   * virtual path goes through a mount prefix. Bare default-backend paths only
   * survive when no mounted alias exists (true strays).
   */
  private dedupeByRealPath<T extends { path: string }>(
    items: T[],
    subKey?: (item: T) => string,
  ): T[] {
    const byKey = new Map<string, T>();
    for (const item of items) {
      const key =
        this.resolveReal(item.path).toLowerCase() +
        (subKey ? ":" + subKey(item) : "");
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, item);
      } else if (
        !this.hasMountPrefix(existing.path) &&
        this.hasMountPrefix(item.path)
      ) {
        byKey.set(key, item);
      }
    }
    return [...byKey.values()];
  }

  /** Resolve a virtual result path to the real path it denotes. */
  private resolveReal(virtualPath: string): string {
    const n =
      "/" +
      virtualPath
        .trim()
        .replace(/\\/g, "/")
        .replace(/^\/+/, "")
        .replace(/\/+$/, "");
    for (const m of this.mounts) {
      const base = m.realPath.replace(/[\\/]+$/, "");
      if (n === m.virtualPath || n.startsWith(m.virtualPath)) {
        return base + "/" + n.slice(m.virtualPath.length);
      }
    }
    // Bare stray path — served by the default backend (the first folder).
    return this.mounts[0].realPath.replace(/[\\/]+$/, "") + n;
  }

  private hasMountPrefix(virtualPath: string): boolean {
    const n = "/" + virtualPath.trim().replace(/\\/g, "/").replace(/^\/+/, "");
    return this.mounts.some((m) => n.startsWith(m.virtualPath));
  }
}

/** A single workspace folder as seen through the virtual filesystem root. */
export interface WorkspaceMount {
  /** Virtual-root-relative path the agent must use, e.g. `/ai_download_plugin/`. */
  virtualPath: string;
  /** Sanitized, unique directory name used for the mount. */
  name: string;
  /** Real directory on disk. Never handed to the model as a tool argument. */
  realPath: string;
}

export interface WorkspaceLayout {
  mounts: WorkspaceMount[];
  /** One folder maps directly to `/`, so there are no per-folder prefixes. */
  singleRoot: boolean;
}

/**
 * SINGLE SOURCE OF TRUTH for the virtual root layout.
 *
 * Both the backend factory and the context injected into the model derive their
 * mount paths from here. Duplicating the sanitization / de-duplication logic
 * would make the two disagree as soon as a folder name contains special
 * characters, two folders share a name, or a folder is added later via
 * "Add Folder to Workspace…".
 */
export function getWorkspaceLayout(override?: string): WorkspaceLayout {
  const roots = getEffectiveRoots(override);
  if (roots.length === 1) {
    return {
      mounts: [
        { virtualPath: "/", name: roots[0].name, realPath: roots[0].path },
      ],
      singleRoot: true,
    };
  }

  const used = new Map<string, number>();
  const mounts = roots.map((folder) => {
    let name = folder.name.replace(/[^\w.-]/g, "_") || "folder";
    const seen = used.get(name) ?? 0;
    used.set(name, seen + 1);
    if (seen > 0) name = `${name}_${seen + 1}`;
    return { virtualPath: `/${name}/`, name, realPath: folder.path };
  });
  return { mounts, singleRoot: false };
}

/**
 * Workspace information handed to the model as CONTEXT rather than as a rule
 * in the system prompt.
 *
 * It contains the virtual-root-relative directory paths the filesystem tools
 * use, plus (in the shell sections) the REAL paths shell commands need —
 * the tools cannot accept real paths, but shell commands cannot accept
 * virtual ones, so the model needs both sides of the mapping.
 * Rebuilt for every model call, so folders added with "Add Folder to
 * Workspace…" appear on the next message.
 */
export function buildWorkspaceContext(override?: string): string {
  const { mounts, singleRoot } = getWorkspaceLayout(override);
  return [
    ...currentDateTimeHint(),
    "",
    ...systemInformationHint(),
    "",
    ...platformCommandGuidelines(),
    "",
    "<workspace_context>",
    singleRoot
      ? "Workspace directory (virtual-root-relative path):"
      : "Workspace directories (virtual-root-relative paths):",
    ...mounts.map((m) => m.virtualPath),
    "</workspace_context>",
    "",
    "<filesystem_capabilities>",
    "Absolute paths OUTSIDE the workspace directories listed above are fully",
    "accessible with the filesystem tools (ls, read_file, glob, grep, write_file,",
    "edit_file). When a tool call targets such a path, the user is simply asked",
    "to approve it — that approval is automatic on your side and requires no",
    "special handling. NEVER refuse an out-of-workspace path or claim the tools",
    "cannot reach it; just make the tool call.",
    "</filesystem_capabilities>",
    "",
    "<temp_files>",
    "Scratch and execution files — shell scripts (.bat/.cmd/.sh), generated",
    "helpers, intermediate outputs — MUST be created under the virtual",
    "directory /tmp/, e.g. /tmp/check_syntax.bat. /tmp/ lives INSIDE the",
    "workspace (the tmp/ subfolder of the first workspace folder), so",
    "write_file/edit_file/delete there NEVER triggers an approval prompt.",
    "NEVER write scratch files to real absolute paths (D:\\..., C:\\..., or a",
    "/tmp outside the workspace): those target the user's drive root, require",
    "explicit approval, and pollute their disk. When done, clean up with",
    "delete on the same /tmp/... virtual path.",
    "</temp_files>",
    "",
    "<command_execution>",
    "To RUN a script or shell command, use the `execute` tool directly — it",
    "executes the command in the workspace directory and returns its output.",
    "The command runs in the default integrated terminal, which is visible live",
    "in the TERMINALS panel so you and the user can watch output as it streams.",
    "`2>&1` is valid in both cmd and PowerShell — prefer it over `2>nul`.",
    ...shellPathMapping(mounts, singleRoot),
    singleRoot
      ? "The shell ALREADY starts in the workspace root. Do NOT `cd` first — " +
        "it is redundant. Run the tool directly (mvn, gradle, npm, …). If the " +
        "tool is not on PATH, use its full absolute path instead of relying " +
        "on the environment."
      : "The shell starts ONLY in the FIRST workspace folder. If the project " +
        "you are building/testing lives in ANOTHER workspace folder, you MUST " +
        "prefix the command with a real-path cd in the SAME command (see the " +
        "MULTI-ROOT RULE above). NEVER `cd /mount-name` — virtual paths do not " +
        "exist in the shell. If the tool is not on PATH, use its full absolute " +
        "path instead of relying on the environment.",
    "If you write a script, write it under /tmp/ and then execute it via the",
    "execute tool. NEVER leave a command for the user to run manually.",
    "For LONG-RUNNING commands (dev servers like `npm run dev`, build watchers",
    "like `webpack --watch`, test watchers, daemons) do NOT use `execute` — it",
    "would block waiting for them to finish. Use the `control_process` tool with",
    'action "start" instead; it returns immediately with a `terminalId`, then',
    "poll its output with `get_process_output` and stop it with `control_process`",
    'action "stop" when done.',
    "NEVER write a script to a real absolute path like D:\\... or C:\\...",
    "",
    "<output_handling_and_token_budget>",
    "Commands can emit LARGE output (builds, test runs, logs). For every command",
    "the execute tool returns:",
    "  - a PARTIAL view of the output inline (a HEAD and a TAIL — the start of",
    "    the run AND the final error/result), so the most relevant parts reach",
    "    the conversation without flooding it;",
    "  - the FULL output saved to a scratch file under the workspace tmp/ folder",
    "    (e.g. tmp/offload-<timestamp>.log). The exact path is printed in the",
    "    result text.",
    "If the partial view is not enough, search or inspect the full text by",
    "GREP-ing / read_file-ing that offload file.",
    "  - The success/failure signal must be reachable: prefer the tool's own",
    "    marker (maven prints BUILD SUCCESS) or the exit code. If you grep the",
    "    offload file for a keyword (e.g. BUILD SUCCESS, 0 failures,",
    "    All tests passed), that is fine — just make sure the marker still",
    "    reaches the command's own output.",
    "  - CAVEAT: quiet flags (-q, --quiet, --silent) SUPPRESS those markers",
    "    (maven -q prints nothing on success). Do not combine them with keyword",
    "    checks — either drop the flag, or rely on the exit code alone (a quiet",
    "    command with empty output + exit 0 = success).",
    "  - Only when you MUST inspect content, read the offload file with",
    "    read_file; otherwise leave the raw output out of the conversation.",
    "  - Offload files live inside the workspace (tmp/) and never prompt for",
    "    approval; clean them up with delete when done.",
    "</output_handling_and_token_budget>",
    "</command_execution>",
  ].join("\n");
}

export type PathScope = "inside" | "outside";

/**
 * Pure helper for the future authorization rule: "edits inside the workspace
 * need no approval, edits outside do". It operates on the SAME virtual paths
 * the tools use, so it can be wired into `interruptOn.when` without any
 * real/virtual path conversion.
 */
export function classifyPath(
  virtualPath: string,
  override?: string,
): PathScope {
  const raw = virtualPath.trim().replace(/\\/g, "/");
  if (!raw.startsWith("/")) return "outside";

  const segments: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (segments.length === 0) return "outside";
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const normalized = "/" + segments.join("/");
  if (normalized === "/") return "inside";

  const { mounts } = getWorkspaceLayout(override);
  const withSlash = normalized + "/";
  return mounts.some(
    (m) => withSlash === m.virtualPath || withSlash.startsWith(m.virtualPath),
  )
    ? "inside"
    : "outside";
}

/** Build a fresh backend for one agent run. */
export function createWorkspaceBackend(override?: string) {
  const { mounts } = getWorkspaceLayout(override);
  const fsBackend = (dir: string) =>
    new FilesystemBackend({ rootDir: dir, virtualMode: true });

  // The model is told to put scratch/execution files under /tmp/ (see
  // buildWorkspaceContext's <temp_files>). Virtual /tmp/x always resolves to
  // the FIRST workspace folder's tmp/ subdir in both single- and multi-root
  // mode, so pre-create it — otherwise the first write lands ENOENT-free but
  // tools that don't mkdir parents (and read/delete before any write) fail.
  if (mounts.length > 0) {
    try {
      fs.mkdirSync(path.join(mounts[0].realPath, "tmp"), { recursive: true });
    } catch {
      // Read-only workspace or sandboxed dir — the tools will surface their
      // own error if the model actually needs to write there.
    }
  }

  if (mounts.length === 1) {
    return new WorkspaceExecBackend(mounts[0].realPath);
  }

  const routes: Record<string, FilesystemBackend> = {};
  for (const mount of mounts) {
    routes[mount.virtualPath] = fsBackend(mount.realPath);
  }

  // The default backend is never used for listing (see `WorkspaceRootBackend`),
  // but CompositeBackend requires one; use the first folder for any stray
  // non-route paths such as `/file`. The mounts list powers the real-path
  // dedupe that keeps glob/grep from returning the first folder's files twice
  // (bare via the default backend AND mounted via their route). It must be an
  // Exec backend so the composite's `execute` has a concrete dir to run in.
  return new WorkspaceRootBackend(
    new WorkspaceExecBackend(mounts[0].realPath),
    routes,
    mounts,
  );
}

/** Normalize a path for approved-set matching: slashes, lowercase, no trailing slash. */
function normalizeForApproval(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Register a user-approved path for ALL tools (call when the HITL card is
 * accepted for a write-style tool — the user explicitly saw and approved that
 * exact operation, so remembering it for the subtree is safe).
 */
export function approvePath(approvedPaths: Set<string>, path: string): void {
  const n = normalizeForApproval(path);
  if (n) approvedPaths.add(n);
}

/**
 * Register a user-approved path for READ-ONLY tools (call when the HITL card
 * is accepted for a read tool such as ls/read_file/grep). Matching is by
 * subtree prefix; write-style tools never consult this set.
 */
export function approveReadPath(
  approvedReadPaths: Set<string>,
  path: string,
): void {
  const n = normalizeForApproval(path);
  if (n) approvedReadPaths.add(n);
}

/** True if `path` (or any parent of it) was previously approved. */
export function isPathApproved(
  approvedPaths: Set<string>,
  path: string,
): boolean {
  const n = normalizeForApproval(path);
  if (!n) return false;
  return [...approvedPaths].some((a) => n === a || n.startsWith(a + "/"));
}

/**
 * Wrap a backend so paths the user approved via the HITL interrupt card are
 * executed by an unrestricted backend. Everything else — including
 * out-of-workspace paths that were NOT approved — behaves exactly like the
 * wrapped backend.
 *
 * A `virtualMode: false` FilesystemBackend accepts absolute paths as-is
 * (FilesystemBackend.resolvePath returns them untouched and skips the
 * containment check), which is exactly what an approved `F:\...` path needs.
 */
/**
 * Wrap a backend so that, for path-bearing tools, the effective permission
 * decision drives execution:
 *   - "deny"            → throw (hard block, no card)
 *   - "allow" + a path outside the workspace folders → run on the REAL
 *                        filesystem (unrestricted backend)
 *   - anything else     → the original (virtual, workspace-only) backend
 *
 * `decide(tool, path)` returns the effective action ("allow" | "ask" | "deny")
 * and already folds in session approvals/denials, so this proxy only has to
 * act on the verdict. The HITL card (interruptOn) handles "ask" BEFORE a tool
 * runs; this proxy is the safety net + the real-fs router.
 */
export function withApprovedPaths<T extends object>(
  backend: T,
  opts: {
    decide: (tool: string, path: string) => PermissionAction;
    override?: string;
    /** True when the policy hard-blocks shell commands ("deny"). */
    executeDenied?: () => boolean;
  },
): T {
  const unrestricted = new FilesystemBackend({ virtualMode: false });
  // Tools whose first (or second, for glob/grep) argument is a path.
  const pathArgIndex: Record<string, number> = {
    read: 0,
    ls: 0,
    write: 0,
    edit: 0,
    delete: 0,
    glob: 1,
    grep: 1,
  };

  return new Proxy(backend, {
    get(target, prop, receiver) {
      // `execute` runs an arbitrary shell command — the path rules cannot
      // describe what it touches, so its only policy lever is a hard block.
      // When not denied, the HITL card (interruptOn) gates every run.
      if (typeof prop === "string" && prop === "execute") {
        if (opts.executeDenied?.()) {
          return async () => {
            throw new Error(
              `Command execution ('execute') is DENIED by the DeepAgent ` +
                `permission policy. Enable it on the permissions settings ` +
                `page if this is intended.`,
            );
          };
        }
        return Reflect.get(target, prop, receiver);
      }
      if (typeof prop === "string" && prop in pathArgIndex) {
        const original = (target as Record<string, unknown>)[prop] as (
          ...args: unknown[]
        ) => unknown;
        return async (...args: unknown[]) => {
          const pathArg = args[pathArgIndex[prop]];
          if (typeof pathArg === "string" && pathArg.trim()) {
            const action = opts.decide(prop, pathArg);
            if (action === "deny") {
              throw new Error(
                `Path '${pathArg}' is denied by the DeepAgent permission ` +
                  `policy and will not be accessed. ` +
                  `The workspace roots are: ${describeRoots(opts.override)}.`,
              );
            }
            // A real-filesystem path that is allowed (incl. session-approved)
            // must bypass the virtual workspace backend.
            if (
              action === "allow" &&
              !inWorkspaceFolders(pathArg, opts.override)
            ) {
              return (
                unrestricted as unknown as Record<
                  string,
                  (...a: unknown[]) => unknown
                >
              )[prop](...args);
            }
          }
          return original.apply(target, args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

/**
 * Optional manual override picker. Kept for cases where the user wants the
 * agent to work on a directory that is NOT part of the workspace. The first
 * entry always restores automatic workspace tracking.
 */
export async function pickRootOverride(
  current?: string,
): Promise<{ override: string | undefined } | undefined> {
  const picks: (vscode.QuickPickItem & { value?: string })[] = [
    {
      label: "$(sync) Auto — follow VS Code workspace folders",
      description: `All ${getWorkspaceFolders().length} folder(s) in Explorer, incl. ones added later`,
      value: "",
    },
    {
      label: "$(folder-opened) Override with a folder outside the workspace…",
      description: "Single-root mode; `/` maps to the chosen directory",
      value: "__pick__",
    },
  ];
  if (current) {
    picks.splice(1, 0, {
      label: "$(check) Keep current",
      description: current,
      value: current,
    });
  }

  const chosen = await vscode.window.showQuickPick(picks, {
    placeHolder: "DeepAgent file tools: which directory should `/` map to?",
    ignoreFocusOut: true,
  });
  if (!chosen) return undefined;
  if (chosen.value === "__pick__") {
    const uris = await vscode.window.showOpenDialog({
      canSelectFolders: true,
      canSelectFiles: false,
      canSelectMany: false,
      openLabel: "Use as DeepAgent root",
    });
    if (!uris?.[0]) return undefined;
    return { override: uris[0].fsPath };
  }
  return { override: chosen.value || undefined };
}
