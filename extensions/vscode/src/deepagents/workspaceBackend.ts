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
import { exec, execFile, execFileSync } from "child_process";
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
/**
 * Shared in-flight detection. Both the activation prewarm and the chat
 * request path await this SAME promise, so a first message that arrives
 * before prewarm finishes never spawns a second (synchronous) powershell.
 */
let shellDetectionPromise: Promise<DetectedShell> | undefined;

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
  // Long TTL: version detection spawns powershell.exe synchronously (slow).
  // A mid-session shell switch is unrealistic; re-spawning per minute would
  // add a multi-second stall to the first request of every minute.
  if (cachedShell && now - cachedShellAt < 10 * 60_000) return cachedShell;
  // Async detection is already in flight - return a conservative provisional
  // shell instead of spawning a second one synchronously. (Windows assumes
  // PowerShell 5.1: no `&&`, which is the safe guidance.)
  if (shellDetectionPromise) {
    const raw = (vscode.env.shell || "").toLowerCase();
    if (raw.includes("pwsh")) {
      return { raw, family: "powershell7", version: "7", supportsAmp: true };
    }
    if (raw.includes("powershell")) {
      return { raw, family: "powershell5", version: "5.1", supportsAmp: false };
    }
    if (os.platform() === "win32") {
      return { raw, family: "powershell5", version: "5.1", supportsAmp: false };
    }
    return { raw, family: "posix", version: "", supportsAmp: true };
  }
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
export function systemInformationHint(
  shell: DetectedShell = detectShell(),
): string[] {
  const platform = os.platform();
  const arch = os.arch();
  const release = os.release();
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
    `Home Directory: ${os.homedir()}`,
    "</system_information>",
  ];
}

/**
 * Per-shell command guidelines (mirrors Kiro's `<platform_specific_command_guidelines>`):
 * an adaptation sentence (Kiro's wording) followed by the command equivalents
 * and the critical separator rule (Windows PowerShell 5.1 has NO `&&`).
 */
export function platformCommandGuidelines(
  shell: DetectedShell = detectShell(),
): string[] {
  const platform = os.platform();
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
export function currentDateTimeHint(): string[] {
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
/**
 * Async shell detection (execFile, never blocks the extension host thread).
 * Callers share a single in-flight promise: even if the first chat request
 * arrives while the activation prewarm is still running, it awaits the same
 * spawn instead of starting another one. No sync spawn on the request path.
 */
export function detectShellAsync(): Promise<DetectedShell> {
  const now = Date.now();
  if (cachedShell && now - cachedShellAt < 10 * 60_000) {
    return Promise.resolve(cachedShell);
  }
  if (shellDetectionPromise) {
    return shellDetectionPromise;
  }

  const raw = (vscode.env.shell || "").toLowerCase();
  const isPwsh = raw.includes("pwsh");
  const isPowerShell = isPwsh || raw.includes("powershell");
  const isCmd = raw.includes("cmd");
  const isPosix =
    raw.includes("bash") ||
    raw.includes("sh") ||
    raw.includes("zsh") ||
    raw.includes("fish");

  // cmd/posix/other needs no spawn - fill the cache synchronously.
  if (isCmd || isPosix || (!isPowerShell && os.platform() !== "win32")) {
    return Promise.resolve(detectShell());
  }

  // PowerShell family: spawn once asynchronously and fill the shared cache.
  const exe = isPwsh ? "pwsh" : "powershell";
  const family: DetectedShell["family"] = isPwsh
    ? "powershell7"
    : "powershell5";
  const fallbackVersion = isPwsh ? "7" : "5.1";
  shellDetectionPromise = new Promise<DetectedShell>((resolve) => {
    execFile(
      exe,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$PSVersionTable.PSVersion.ToString()",
      ],
      { timeout: 5000, encoding: "utf8" },
      (err: Error | null, stdout?: string) => {
        const version =
          err || !stdout?.trim() ? fallbackVersion : stdout.trim();
        const shell: DetectedShell = {
          raw,
          family,
          version,
          supportsAmp: isPwsh,
        };
        cachedShell = shell;
        cachedShellAt = Date.now();
        shellDetectionPromise = undefined;
        resolve(shell);
      },
    );
  });
  return shellDetectionPromise;
}

/**
 * Pre-warm the shell detection cache at activation (~1-3s on Windows PS).
 * Fire-and-forget; the shared promise means a concurrent first request
 * simply awaits this instead of spawning again.
 */
export function prewarmShellDetection(): void {
  void detectShellAsync().catch(() => {
    // non-fatal
  });
}

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

/**
 * Resolve an execute `cwd` (Kiro-style) to a real path inside the workspace.
 * Accepts a virtual mount path (`/memories`), a workspace-relative path
 * (`src`), or an absolute path that is already one of the workspace roots.
 * Returns null when the path is empty/outside the workspace; callers then
 * fall back to the backend's default cwd.
 */
function resolveExecuteCwd(
  cwd: string | null | undefined,
  mounts: WorkspaceMount[],
): string | null {
  if (!cwd || !cwd.trim()) return null;
  const raw = cwd.trim();
  const roots = mounts.map((m) => m.realPath.replace(/[\\/]+$/, ""));
  const isInside = (p: string): boolean =>
    roots.some(
      (r) =>
        p.toLowerCase() === r.toLowerCase() ||
        p.toLowerCase().startsWith(r.toLowerCase() + path.sep),
    );

  // Virtual mount path, e.g. "/memories" or "/memories/sub"
  for (const m of mounts) {
    const vp = m.virtualPath.replace(/\/+$/, "") || "/";
    if (vp === "/") {
      if (raw.startsWith("/")) {
        const rel = raw.replace(/^[/\\]+/, "");
        const candidate = path.resolve(m.realPath, rel);
        if (isInside(candidate)) return candidate;
      }
      continue;
    }
    if (raw === vp || raw.startsWith(vp + "/") || raw.startsWith(vp + "\\")) {
      const rel = raw.slice(vp.length).replace(/^[/\\]+/, "");
      const candidate = path.resolve(m.realPath, rel);
      if (isInside(candidate)) return candidate;
    }
  }

  // Absolute real path (already inside workspace)
  if (path.isAbsolute(raw)) {
    const candidate = path.resolve(raw);
    return isInside(candidate) ? candidate : null;
  }

  // Workspace-relative path, e.g. "src" → first root/src
  const candidate = path.resolve(roots[0], raw);
  return isInside(candidate) ? candidate : null;
}

/** Run a shell command in `cwd`, returning the deepagents `ExecuteResponse`. */
const EXEC_TIMEOUT_MS = 120_000;
/**
 * Execution tracing for the "exit code unknown" class of bugs. Every decision
 * point in the terminal-execution path (which API existed, which event fired,
 * what the exit code was, which path resolved the promise) is written here so a
 * failing run can be diagnosed from the log alone.
 *
 * Goes to two places:
 *   • the shared "DeepAgent Debug" OutputChannel (same channel name ⇒ same
 *     instance as the panel/adapter logs), and
 *   • `<workspace>/tmp/execute-trace.log` (append) — easy to hand over.
 */
let execTraceChannel: vscode.OutputChannel | undefined;
let execTraceFile: string | undefined;
function execTrace(msg: string, data?: Record<string, unknown>): void {
  const line = data ? `${msg} ${JSON.stringify(data)}` : msg;
  // console.log FIRST: the Extension Host's DEBUG CONSOLE is where the user is
  // actually looking, and it only shows console output (OutputChannel content
  // lives in the separate OUTPUT panel).
  try {
    console.log(`[exec] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    if (!execTraceChannel) {
      execTraceChannel = vscode.window.createOutputChannel("DeepAgent Debug");
    }
    execTraceChannel.appendLine(`[exec] ${line}`);
  } catch {
    /* ignore */
  }
  try {
    if (!execTraceFile) {
      const root = getWorkspaceLayout().mounts[0]?.realPath ?? process.cwd();
      execTraceFile = path.join(root, "tmp", "execute-trace.log");
      fs.mkdirSync(path.dirname(execTraceFile), { recursive: true });
    }
    fs.appendFileSync(
      execTraceFile,
      `${new Date().toISOString()} ${line}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}
/**
 * Ask the SHELL for the previous command's exit status.
 *
 * This fork's `TerminalShellExecution` exposes no exit code at all
 * (`execution.exitCode` is permanently null — verified in the trace log), and
 * `onDidEndTerminalShellExecution` doesn't exist. But every shell keeps the
 * status of the last command:
 *   • PowerShell → `$LASTEXITCODE` (number)  / `$?` (bool)
 *   • POSIX sh   → `$?` (number)
 *   • cmd.exe    → `%ERRORLEVEL%`
 * We send all three spellings in ONE line and parse whichever the shell
 * actually understood. The probe runs in the SAME terminal as the command, so
 * it sees that command's status.
 */
async function probeShellExitCode(
  si: any,
  term: vscode.Terminal,
): Promise<number | null> {
  try {
    const probe =
      'echo "__EXITCODE__$LASTEXITCODE"; echo "__EXITCODE__$?"; echo "__EXITCODE__%ERRORLEVEL%"';
    const ex = si.executeCommand(probe);
    if (!ex || typeof ex.read !== "function") return null;
    let text = "";
    for await (const data of ex.read() as AsyncIterable<Uint8Array>) {
      text += Buffer.from(data).toString("utf8");
      if (text.length > 8192) break;
    }
    // A number is authoritative (PowerShell's $LASTEXITCODE, sh's $?, cmd's
    // %ERRORLEVEL%). Take the FIRST numeric match: in PowerShell the first
    // echo already carries $LASTEXITCODE.
    const nums = [...text.matchAll(/__EXITCODE__(\d+)/g)].map((m) =>
      Number(m[1]),
    );
    if (nums.length) return nums[0];
    // PowerShell's `$?` is a boolean — True means the previous command
    // succeeded.
    const bool = /__EXITCODE__\s*(True|False)/i.exec(text);
    if (bool) return bool[1].toLowerCase() === "true" ? 0 : 1;
    return null;
  } catch {
    return null;
  }
}

/**
 * Maximum TOTAL runtime for a command, in ms — the hard cap that applies even
 * while the command keeps producing output. Configurable via
 * `continue.deepAgent.execute.maxCommandRuntime` (default 10 minutes). When it
 * is exceeded the command is TERMINATED (Ctrl+C) and the agent is told to try a
 * different approach — the command is NOT left running in the background.
 */
function execMaxRuntimeMs(): number {
  const cfg = vscode.workspace
    .getConfiguration("continue")
    .get<number>("deepAgent.execute.maxCommandRuntime");
  return typeof cfg === "number" && cfg > 0 ? cfg : 10 * 60_000;
}
/**
 * Exit code used when WE terminate a command that ran past its time budget.
 * 124 matches GNU `timeout`'s convention, so it reads as "timed out" rather
 * than "the tool crashed".
 */
const EXIT_CODE_TIMED_OUT = 124;
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
// Aligned with Kiro's LargeOutputHandler (LF constants in its extension.js):
//   CHAR_THRESHOLD = 3e4, HEAD_PREVIEW_SIZE = 500, TAIL_PREVIEW_SIZE = 500
// i.e. only offload when output exceeds 30,000 chars, and keep a small 500-char
// head + 500-char tail in the model-facing preview.
const MAX_MODEL_OUTPUT = 3e4;
const OUTPUT_HEAD = 500;
const OUTPUT_TAIL = 500;
function offloadIfLarge(
  output: string,
  cwd: string,
): { output: string; offloaded: boolean } {
  if (output.length <= MAX_MODEL_OUTPUT) {
    return { output, offloaded: false };
  }
  const head = output.slice(0, OUTPUT_HEAD);
  const tail = output.slice(-OUTPUT_TAIL);
  const omitted = Math.max(0, output.length - head.length - tail.length);
  let note: string;
  try {
    const dir = path.join(cwd, "tmp");
    fs.mkdirSync(dir, { recursive: true });
    const file = `offload-${Date.now()}.log`;
    const absPath = path.join(dir, file).replace(/\\/g, "/");
    fs.writeFileSync(path.join(dir, file), output, "utf8");
    note =
      `\n--- HEAD (first ${head.length.toLocaleString()} chars) ---\n${head}\n\n` +
      `--- ${omitted.toLocaleString()} chars omitted ---\n\n` +
      `--- TAIL (last ${tail.length.toLocaleString()} chars) ---\n${tail}\n--- END ---\n\n` +
      `If more context is needed:\n` +
      `1. Retry with narrower arguments so the result fits.\n` +
      `2. The full output was saved to '${absPath}'. Inspect it with targeted shell commands (e.g. head -c 2000, tail -c 5000, grep -n 'pattern' | head -c 2000).`;
    return { output: note, offloaded: true };
  } catch {
    note =
      `\n[Output exceeded ${MAX_MODEL_OUTPUT.toLocaleString()} chars; ` +
      `${omitted.toLocaleString()} chars omitted — no offload file could be written.]`;
    return { output: `${head}${note}${tail}`, offloaded: true };
  }
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
    const err = e instanceof Error ? e : new Error(String(e));
    console.error(
      `[DeepAgent] llm.log write FAILED: ${err.message}`,
      "\nSTACK:",
      err.stack,
    );
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
  // Do NOT reuse the cached `agentShellIntegration` promise here. It is
  // resolved once when the terminal is created, and in this fork that object
  // can go stale between long builds; calling `executeCommand` on the stale
  // object throws and silently falls back to headless exec, leaving the
  // visible terminal empty. Always pick up the terminal's current integration.
  let si: any;
  if (term) {
    si =
      term.shellIntegration ??
      (await waitForShellIntegration(term, SHELL_INTEGRATION_TIMEOUT_MS));
  }
  execTrace("run:start", {
    command,
    cwd,
    terminalReused: !!term,
    shellIntegrationAvailable: !!si,
    hasExecuteCommand: typeof (si as any)?.executeCommand === "function",
  });
  if (!term || !si || typeof (si as any).executeCommand !== "function")
    return null;
  if (signal?.aborted) {
    return {
      output: "（命令已被用户终止，未执行）",
      exitCode: null,
      truncated: false,
    };
  }

  // Some forks' shell-integration `read()` only yields at process end, so the
  // chat card would stay empty while the real terminal streams output. Capture
  // terminal writes directly as a second live source (same approach as the
  // background-process path). Final output still comes from `read()`, so this
  // only feeds the live card and the silence watcher.
  let terminalLiveText = "";
  let terminalDataListener: vscode.Disposable | undefined;
  let lastDataAt = Date.now();
  const w = vscode.window as any;
  // `onDidWriteTerminalData` EXISTS as a function on this fork's `window` API
  // but THROWS "CANNOT use API proposal: terminalDataWriteEvent" at call time
  // when the proposal isn't granted via product.json. A bare `typeof` check
  // isn't enough — the throw used to escape runCommandViaTerminal, forcing the
  // whole command down the headless fallback, which emits NO progress events
  // and leaves the Run Command card stuck on "（命令执行中…）" with no output.
  let hasTerminalDataStream = false;
  try {
    if (typeof w.onDidWriteTerminalData === "function") {
      terminalDataListener = w.onDidWriteTerminalData((e: any) => {
        if (e?.terminal === term) {
          terminalLiveText += Buffer.from(e.data ?? "").toString("utf8");
          lastDataAt = Date.now();
        }
      });
      hasTerminalDataStream = true;
      execTrace("run:live-terminal-data", { source: "onDidWriteTerminalData" });
    } else {
      execTrace("run:live-terminal-data", { source: "unavailable" });
    }
  } catch (err) {
    execTrace("run:live-terminal-data", {
      source: "proposal-denied",
      error: String(err),
    });
  }

  let execution: any;
  let readFn: (() => Promise<string | undefined>) | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      execution = (si as any)?.executeCommand(command);
      if (typeof execution?.read === "function") {
        readFn = execution.read.bind(execution);
        break;
      }
      execTrace("run:execute-no-read", {
        attempt,
        keys: Object.keys(execution ?? {}),
      });
    } catch (err) {
      execTrace("run:execute-threw", { attempt, error: String(err) });
    }
    execution = undefined;
    readFn = undefined;
    if (attempt === 0 && term) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      si =
        term.shellIntegration ??
        (await waitForShellIntegration(term, SHELL_INTEGRATION_TIMEOUT_MS));
    }
  }
  if (!readFn) {
    execTrace("run:no-terminal-execution", { command });
    terminalDataListener?.dispose();
    return null;
  }

  // Which VS Code APIs actually EXIST at runtime in this fork? The typings
  // don't declare onDidEndTerminalShellExecution / TerminalShellExecution, so
  // the exit-code plumbing may be running against APIs that aren't there —
  // this line answers that question directly.
  execTrace("run:apis", {
    window_onDidEndTerminalShellExecution: typeof (vscode.window as any)
      .onDidEndTerminalShellExecution,
    window_onDidChangeTerminalShellIntegration: typeof (vscode.window as any)
      .onDidChangeTerminalShellIntegration,
    window_onDidCloseTerminal: typeof vscode.window.onDidCloseTerminal,
    execution_ctor: execution?.constructor?.name,
    execution_hasExitCodeProp: "exitCode" in (execution ?? {}),
    execution_exitCodeAtStart: execution?.exitCode,
    execution_keys: Object.keys(execution ?? {}).slice(0, 12),
  });

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
  // Choose ONE live source for the whole run and stick with it: `sentLen` is an
  // offset into a single stream, so switching streams mid-run would duplicate
  // or skip output in the card. When the proposed-API subscription succeeded
  // use the terminal-write stream (echo + output); otherwise use the shell
  // integration read() stream. Crucially, an ungranted proposal must not leave
  // terminalLiveText permanently "" and shadow a perfectly good read() stream.
  const getLiveSource = () =>
    hasTerminalDataStream ? terminalLiveText : liveExecuteText;
  const postProgress = (done = false, code: number | null = null) => {
    try {
      const stripped = stripAnsi(getLiveSource());
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
  let accText = "";
  // Start of THIS command (for timings in the trace log).
  const startedAtMs = Date.now();
  // Set when the command's OUTPUT STREAM ends — for VS Code shell integration
  // that stream closes exactly when the command finishes, so it is the one
  // reliable "the command is over" signal when no exit code is reported.
  let outputStreamEnded = false;
  let onOutputStreamEnded: (() => void) | undefined;

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
    // The stream ended → the command is over (shell integration closes the
    // execution's output stream when the command finishes). This is the
    // dependable end-of-command signal on forks that don't report an exit
    // code.
    outputStreamEnded = true;
    execTrace("run:output-stream-ended", {
      elapsedMs: Date.now() - startedAtMs,
      bytes: totalBytes,
      executionExitCode: execution?.exitCode,
    });
    onOutputStreamEnded?.();
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
  const doResolve = (exit: number | null, source: string) => {
    if (resolved) return;
    resolved = true;
    execTrace("run:resolved", {
      exit,
      source,
      elapsedMs: Date.now() - startedAtMs,
      idleMs: Date.now() - lastDataAt,
      timedOut,
      abortedByUser,
      interactiveStall,
    });
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
    if (typeof execution.exitCode === "number") {
      // Fast command — already finished with a status.
      doResolve(execution.exitCode as number, "fast-path");
      return;
    }
    try {
      exitListener = vscode.window.onDidEndTerminalShellExecution((e: any) => {
        execTrace("run:event-end-execution", {
          sameExecution: e.execution === execution,
          eventExitCode: e.exitCode,
          executionExitCode: execution?.exitCode,
        });
        if (e.execution === execution)
          doResolve((e.exitCode ?? 0) as number, "end-execution-event");
      });
      execTrace("run:listeners", {
        endExecutionListener: exitListener ? "registered" : "unavailable",
      });
    } catch (err) {
      exitListener = undefined;
      execTrace("run:listeners", {
        endExecutionListener: "threw",
        error: String(err),
      });
    }
    // Safety net in case the end event never fires on this fork.
    // NOTE: `execution.exitCode` starts out as NULL on this fork, so testing
    // only `!== undefined` resolved the promise ~250 ms into the run — the
    // command was still going, we returned immediately, and the card ended up
    // with a truncated log and an "unknown" exit code. Only a NUMBER means
    // "the command finished and here is its status".
    exitPoll = setInterval(() => {
      const ec = execution?.exitCode;
      if (typeof ec === "number") {
        execTrace("run:poll-exit-code", { exitCode: ec });
        doResolve(ec, "exit-code-poll");
      }
    }, 250);
    // Terminal killed directly (the "kill terminal" button): the running
    // command is gone; stop waiting so the turn can wind down.
    try {
      closeListener = vscode.window.onDidCloseTerminal((t: any) => {
        if (t === term) {
          execTrace("run:event-terminal-closed", {
            executionExitCode: execution?.exitCode,
          });
          doResolve(execution.exitCode ?? null, "terminal-closed");
        }
      });
    } catch {
      closeListener = undefined;
    }
  });

  // The output stream closing IS the end-of-command signal on forks that don't
  // report an exit code. Wire it up now (after doResolve exists), and also
  // handle the case where the stream already ended before we got here.
  onOutputStreamEnded = async () => {
    if (resolved) return;
    const ec = execution?.exitCode;
    if (typeof ec === "number") {
      doResolve(ec, "output-stream-ended");
      return;
    }
    // No exit code from VS Code on this fork → ask the shell itself.
    const probed = await probeShellExitCode(si, term);
    execTrace("run:shell-probe", { probed });
    doResolve(probed, probed === null ? "output-stream-ended" : "shell-probe");
  };
  if (outputStreamEnded && !resolved) {
    onOutputStreamEnded();
  }

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
      doResolve(null, "user-abort");
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
      const hardCapMs = execMaxRuntimeMs();
      killTimeoutTimer = setInterval(() => {
        if (finished) return;
        const idleMs = Date.now() - lastDataAt;
        const totalMs = Date.now() - startedAt;
        // Two independent budgets:
        //  • hard cap — TOTAL runtime. Applies even while the command streams
        //    output; when it expires the command is TERMINATED so the agent
        //    stops waiting and can try a different approach.
        //  • idle  — SILENCE. A command that keeps producing output never
        //    trips this one, so long builds are fine.
        const hitHardCap = totalMs >= hardCapMs;
        if (!hitHardCap && idleMs < timeoutMs) {
          return; // still streaming (or below both thresholds) — keep waiting
        }
        timedOut = true;
        if (hitHardCap) {
          timeoutReason = `exceeded the maximum runtime of ${Math.round(
            hardCapMs / 1000,
          )} s`;
        } else {
          timeoutReason = `no output for ${Math.round(timeoutMs / 1000)} s`;
        }
        if (interactiveStall && !hitHardCap) {
          // Waiting for USER input ([y/n], password): don't kill it — focus the
          // terminal so the user can answer, and report the status as unknown.
          try {
            term.show(false); // focus so the user can respond
          } catch {
            /* ignore */
          }
          resolve({ exit: execution.exitCode ?? null });
          execTrace("run:timeout-interactive-stall", {
            exit: execution.exitCode ?? null,
            idleMs,
            totalMs,
          });
          return;
        }
        // Terminate the command (Ctrl+C) — it is past its time budget, so
        // leaving it running would only keep the agent waiting on a result
        // that may never matter. The terminal stays open with the captured
        // output so the user can still inspect it.
        try {
          term.sendText("\u0003"); // Ctrl+C
        } catch {
          /* ignore */
        }
        try {
          term.show(true);
        } catch {
          /* ignore */
        }
        resolve({ exit: EXIT_CODE_TIMED_OUT });
        execTrace("run:timeout-terminated", {
          exit: EXIT_CODE_TIMED_OUT,
          reason: timeoutReason,
          idleMs,
          totalMs,
          hardCap: hitHardCap,
        });
      }, 1000);
    }),
  ]);

  const { exit } = await exitOrTimeout;
  finished = true;
  doResolve(exit, "race-winner"); // ensure all listeners are cleaned up
  if (killTimeoutTimer) clearInterval(killTimeoutTimer);
  clearInterval(stallWatcher);
  // Wait for the output stream to finish so the card gets the command's FULL
  // output (BUILD SUCCESS and the trailing error live at the very end). The
  // 1.5 s cap only applies when the stream never closes (e.g. we terminated the
  // command ourselves) — otherwise it would truncate the log.
  if (!outputStreamEnded) {
    await Promise.race([
      readTask,
      new Promise<void>((r) => setTimeout(r, 1500)),
    ]);
  } else {
    await readTask;
  }

  const full = stripAnsi(decodeConsoleOutput(Buffer.concat(chunks)));
  const offloaded = offloadIfLarge(full, cwd);
  let output = offloaded.output;
  if (timedOut) {
    const kb = Math.round(full.length / 1024);
    // The note is read by the MODEL, so it must tell it what to do next —
    // otherwise the agent just re-runs the same doomed command.
    const stallNote = interactiveStall
      ? " The command appears to be WAITING FOR INPUT (e.g. [y/n] / password) — the terminal is focused; type your response there, or ask the user to respond."
      : " The command was TERMINATED (Ctrl+C) because it ran past its time budget.";
    const advice =
      " Do NOT re-run the same command — try a different approach (e.g. a faster/smaller target, an explicit --timeout flag, or splitting the work into steps). Do NOT use `control_process` to track it either: that command was terminated, so start the next attempt with `execute`.";
    const where = offloaded.offloaded
      ? "the offload file referenced above"
      : "tmp/ (open the terminal or re-run to capture it)";
    output +=
      `\n… [stopped waiting: ${timeoutReason}; ${kb} KB captured so far.${stallNote}${advice} ` +
      `Full captured text is at ${where}] …\n`;
  } else if (abortedByUser) {
    output = output.trimEnd()
      ? output +
        "\n… [命令已被用户终止（Ctrl+C）。已捕获的中断前输出见上/落盘文件] …\n"
      : "（命令已被用户终止，无输出）";
  } else if (exit === null) {
    // No exit code at all (terminal closed / this fork's shell integration
    // didn't report one). Say it explicitly: the card shows "unknown" for this
    // case, and the note explains why instead of silently looking failed.
    output = output.trimEnd()
      ? output +
        "\n… [未能获取退出码（终端被关闭或 shell integration 未回传）—— 状态未知，不代表失败] …\n"
      : "（命令无输出，且未能获取退出码——状态未知，不代表失败）";
  }
  if (progressTimer) clearInterval(progressTimer);
  terminalDataListener?.dispose();
  postProgress(true, exit); // final slice + completion signal (flip card in place)
  liveExecuteActive = false; // done — stop exposing live tail
  execTrace("run:final", {
    exit,
    totalMs: Date.now() - startedAtMs,
    bytes: full.length,
    timedOut,
    abortedByUser,
    interactiveStall,
    outputTail: full.slice(-200).replace(/\s+/g, " ").slice(-200),
  });
  return { output, exitCode: exit, truncated: offloaded.offloaded };
}

/** Headless fallback — the original child_process.exec implementation. */
function runCommandViaExec(
  command: string,
  cwd: string,
  signal?: AbortSignal,
  timeoutMs?: number | null,
): Promise<{ output: string; exitCode: number | null; truncated: boolean }> {
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        windowsHide: true,
        shell: true,
        maxBuffer: EXEC_MAX_BUFFER,
        // `exec` only supports a total-time budget (no "silence" mode), so the
        // hard cap is the right knob here. The command is killed by Node when
        // it fires. An explicit per-call timeout (Kiro's `timeout` param)
        // overrides the configured default.
        timeout: timeoutMs && timeoutMs > 0 ? timeoutMs : execMaxRuntimeMs(),
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
        let timedOutNote = false;
        execTrace("exec:done", {
          cwd,
          exitCode,
          errorCode: (error as any)?.code,
          errorSignal: (error as any)?.signal,
          killed: (error as any)?.killed,
          bytes: full.length,
        });
        if (error) {
          if (typeof error.code === "number") exitCode = error.code;
          else if (
            error.code === "ETIMEDOUT" ||
            (error as NodeJS.ErrnoException).killed
          ) {
            // Node killed the child — either our time budget fired or the user
            // pressed "Stop". Only the former is a timeout.
            if (signal?.aborted === true) {
              exitCode = null; // user stop — status unknown
            } else {
              exitCode = EXIT_CODE_TIMED_OUT;
              timedOutNote = true;
            }
          } else exitCode = 1;
        }
        let output = offloaded.output;
        if (timedOutNote) {
          const kb = Math.round(full.length / 1024);
          output +=
            `\n… [stopped waiting: exceeded the maximum runtime of ${Math.round(
              execMaxRuntimeMs() / 1000,
            )} s; ${kb} KB captured so far. The command was TERMINATED because it ran past its time budget.` +
            ` Do NOT re-run the same command — try a different approach (e.g. a faster/smaller target, an explicit --timeout flag, or splitting the work into steps).] …\n`;
        }
        resolve({
          output,
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
  timeoutMs?: number | null,
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
    .then((r) => r ?? runCommandViaExec(command, cwd, signal, timeoutMs));
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
 * Split a leading `cd "<dir>" ; <cmd>` into the directory and the real
 * command. The `control_process` tool description tells the model to pass
 * `cwd` instead, but models frequently prefix the command with a `cd` anyway —
 * without this the process would start in the wrong directory (or fail on a
 * bare `cd`).
 */
function splitCdPrefix(command: string): { cwd?: string; command: string } {
  const m = /^\s*cd\s+("[^"]+"|'[^']+'|\S+)\s*;\s*([\s\S]+)$/.exec(command);
  if (!m) return { command };
  const dir = m[1].replace(/^["']|["']$/g, "");
  return { cwd: dir, command: m[2] };
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
      name: "control_pwsh_process",
      description: [
        "Control background processes by starting or stopping them. This tool combines process management functionality into a single interface.",
        "",
        "# ACTIONS:",
        '- "start": Execute a PowerShell command as a background process. Designed for commands that don\'t terminate quickly (like dev servers, build watchers, etc.).',
        '- "stop": Terminate a background process and close its terminal, cleaning up resources.',
        "",
        "# START ACTION:",
        "If a process already exists for the same command and working directory, it will be reused. Once a process is started you can read its output using the get_process_output tool and list all ongoing processes using the list_processes tool.",
        "",
        "## Examples:",
        "- npm run dev (development servers)",
        "- webpack --watch (build watchers)  ",
        "- python manage.py runserver (Django dev server)",
        "- yarn start (React development server)",
        "",
        '## Parameters for "start":',
        '- action: "start"',
        "- command: (required) The command of the background process",
        "- cwd: (optional) The working directory path where the process is supposed to run",
        "",
        '## Returns for "start":',
        "- terminalId: a unique identifier of the process",
        "- isReused: indicates whether a process was reused",
        "",
        "# STOP ACTION:",
        'Stops a background process that was started with the "start" action and cleans up its associated resources.',
        "",
        '## Parameters for "stop":',
        '- action: "stop"',
        '- terminalId: (required) The unique identifier of the background process (returned by "start" action or found in list_processes)',
        "",
        '## Returns for "stop":',
        "- success: boolean indicating if termination was successful",
        "- message: descriptive message about the operation",
        "",
        "# RULES",
        '- USE "start" exclusively for long-running commands like development servers (npm run dev, yarn start) and build watchers (webpack --watch).',
        "- NEVER use the 'cd' command! If you wish to run a command in a subdirectory of the workspace, provide the relative path in the 'cwd' parameter.",
        "- USING THE 'cd' command will result in a failure.",
        "",
        "# NOTES",
        '- The "start" action returns immediately without waiting for the process to complete, allowing you to continue with other tasks while the process runs in the background.',
        "- If a process with the same command and working directory is already running, it will be reused instead of creating a new process.",
        '- A terminated process cannot be started again with the same terminalId. But an equivalent process can be started again with the "start" action, which may result in a different terminalId.',
      ].join("\n"),
      schema: z.object({
        action: z
          .enum(["start", "stop"])
          .describe(
            'The action to perform: "start" to create a new background process, "stop" to terminate an existing process',
          ),
        command: z
          .string()
          .optional()
          .nullable()
          .describe(
            'The shell command to execute as a background process (required for "start" action)',
          ),
        cwd: z
          .string()
          .optional()
          .nullable()
          .describe(
            "Current working directory. The command will run in this directory. Defaults to workspace root if omitted.",
          ),
        terminalId: z
          .string()
          .optional()
          .nullable()
          .describe(
            'The unique identifier of the background process to terminate (required for "stop" action)',
          ),
      }),
      func: async (input: any) => {
        if (input.action === "start") {
          const layout = getWorkspaceLayout();
          // Models sometimes write `cd "<dir>" ; <cmd>` instead of passing
          // `cwd` (the tool description forbids it, but they do it anyway).
          // Peel that prefix off so the command still runs in the right place.
          const peeled = splitCdPrefix(input.command ?? "");
          const preferred = input.cwd || peeled.cwd;
          const cwd =
            preferred && fs.existsSync(preferred)
              ? preferred
              : layout.mounts[0]?.realPath || process.cwd();
          const r = startBackgroundProcess(peeled.command, cwd);
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
        "Read the output from a background process. This tool allows you to monitor the output of background processes started with the control_pwsh_process tool. This is useful for:\n" +
        "- Checking if a development server started successfully\n" +
        "- Debugging build errors in watch processes\n" +
        "- Monitoring the status or viewing logs of background processes\n" +
        "\n" +
        "# PARAMETERS:\n" +
        "- terminalId: (required) The unique identifier of the background process (returned by control_pwsh_process or found in list_processes)\n" +
        "- lines: number of lines to limit output (useful for large outputs)\n" +
        "\n" +
        "# RETURNS:\n" +
        "- output: the terminal output as text\n" +
        "\n" +
        "# NOTES:\n" +
        "- The output includes both stdout and stderr from the terminal.\n" +
        "- Use the terminalId returned by control_pwsh_process or found in list_processes.",
      schema: z.object({
        terminalId: z
          .string()
          .describe(
            "The unique identifier of the background process to read output from",
          ),
        lines: z
          .number()
          .optional()
          .describe(
            "Optional number of lines to limit output (if specified returns the X most recent lines; defaults to 100 lines)",
          ),
      }),
      func: async (input: any) => {
        const r = getBackgroundProcessOutput(input.terminalId);
        if (!r.found) {
          return JSON.stringify({
            found: false,
            message: `No process with id ${input.terminalId}`,
          });
        }
        // Kiro: return the last N lines (default 100). Then cap to 20k chars
        // to protect the context on very long individual lines.
        const lineCount =
          typeof input.lines === "number" && Number.isFinite(input.lines)
            ? Math.max(0, Math.floor(input.lines))
            : 100;
        let out =
          lineCount > 0
            ? r.output.split("\n").slice(-lineCount).join("\n")
            : "";
        if (out.length > 20000) out = out.slice(-20000);
        return JSON.stringify({ running: r.running, output: out });
      },
    }),
    new DynamicStructuredTool({
      name: "list_processes",
      description:
        "List all background processes currently managed by Kiro. This tool shows all background processes that have been started using the control_pwsh_process tool, including their current status, commands and working directories. This is useful for monitoring active development processes and checking which servers are running.\n" +
        "\n" +
        "# RETURNS:\n" +
        "- processes: a list of background processes with terminalId, command, path, status:\n" +
        "  - terminalId: unique identifier for the process\n" +
        "  - command: the command that is being executed\n" +
        "  - path: the working directory path\n" +
        "  - status: current status (running, stopped, unknown)",
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
  async execute(
    command: string,
    options?: {
      cwd?: string | null;
      timeout?: number | null;
      background?: boolean;
    },
  ) {
    const mounts: WorkspaceMount[] = [
      { virtualPath: "/", name: "root", realPath: this.cwd },
    ];
    const cwd = resolveExecuteCwd(options?.cwd, mounts) ?? this.cwd;
    const shellCommand = adaptCommandToShell(
      translateVirtualPathsInCommand(command, mounts, true),
    );

    if (options?.background === true) {
      const r = startBackgroundProcess(shellCommand, cwd);
      if (r.error) {
        return { output: r.error, exitCode: 1, truncated: false };
      }
      return {
        output: JSON.stringify({
          terminalId: r.terminalId,
          isReused: r.isReused,
          message: r.isReused
            ? "Reused an existing background process with the same command and cwd."
            : "Command started in the background. Use get_process_output with this terminalId to read its output.",
        }),
        exitCode: 0,
        truncated: false,
      };
    }

    return runCommand(
      shellCommand,
      cwd,
      { real: [this.cwd], prefixes: ["/"] },
      options?.timeout ?? null,
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
  async execute(
    command: string,
    options?: {
      cwd?: string | null;
      timeout?: number | null;
      background?: boolean;
    },
  ) {
    const singleRoot =
      this.mounts.length === 1 && this.mounts[0].virtualPath === "/";
    const cwd =
      resolveExecuteCwd(options?.cwd, this.mounts) ?? this.mounts[0].realPath;
    const shellCommand = adaptCommandToShell(
      translateVirtualPathsInCommand(command, this.mounts, singleRoot),
    );

    // Kiro-style run_in_background: the flag is threaded from the tool all the
    // way down to the execution layer, which decides sync vs background here
    // (mirrors Kiro's terminal.runCommand(..., background)). Return the
    // terminalId in the output so the model can poll via get_process_output.
    if (options?.background === true) {
      const r = startBackgroundProcess(shellCommand, cwd);
      if (r.error) {
        return { output: r.error, exitCode: 1, truncated: false };
      }
      return {
        output: JSON.stringify({
          terminalId: r.terminalId,
          isReused: r.isReused,
          message: r.isReused
            ? "Reused an existing background process with the same command and cwd."
            : "Command started in the background. Use get_process_output with this terminalId to read its output.",
        }),
        exitCode: 0,
        truncated: false,
      };
    }

    return runCommand(
      shellCommand,
      cwd,
      {
        real: this.mounts.map((m) => m.realPath),
        prefixes: this.mounts.map((m) => m.virtualPath),
      },
      options?.timeout ?? null,
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
    regex: boolean = false,
  ): Promise<GrepResult> {
    const result = await super.grep(pattern, path, glob, maxCount, regex);
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

// Kiro's A4 directory exclusion list (bundle @176926-176955), plus our `tmp`.
const FOLDED_TREE_DIRS = new Set([
  ".git",
  ".svn",
  ".vscode",
  ".idea",
  ".vs",
  "venv",
  ".venv",
  "env",
  ".env",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "bin",
  ".pytest_cache",
  ".vscode-test",
  ".continue",
  "__pycache__",
  "site-packages",
  ".gradle",
  ".mvn",
  ".cache",
  "gems",
  "vendor",
  ".next",
  ".kiro",
  ".micat", // our own config/steering dir (Kiro excludes .kiro the same way)
  "tmp", // scratch/offload logs: noise in the tree and constant watcher churn
]);

// Kiro's k4 file glob list (bundle @176847-176925), applied via fe3's
// endsWith check. Files matching these are not added to the tree at all.
const TREE_IGNORED_FILE_SUFFIXES = [
  ".ds_store",
  "-lock.json",
  ".lock",
  ".log",
  ".ttf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".mp4",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".dmg",
  ".tgz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".obj",
  ".o",
  ".o.d",
  ".a",
  ".lib",
  ".so",
  ".dylib",
  ".ncb",
  ".sdf",
  ".woff",
  ".woff2",
  ".eot",
  ".cur",
  ".avi",
  ".mpg",
  ".mpeg",
  ".mov",
  ".mp3",
  ".mkv",
  ".webm",
  ".jar",
  ".onnx",
  ".parquet",
  ".pqt",
  ".wav",
  ".webp",
  ".db",
  ".sqlite",
  ".wasm",
  ".plist",
  ".profraw",
  ".gcda",
  ".gcno",
  "go.sum",
  ".env",
  ".gitignore",
  ".gitkeep",
  ".continueignore",
  ".kiroignore",
  ".cursorignore",
  "config.json",
  ".csv",
  ".uasset",
  ".pdb",
  ".bin",
  ".chat",
  ".swp",
  ".pag",
  ".jsonl",
  ".eslintcache",
  ".ts.map",
  ".js.map",
  ".d.ts",
];
const treeFileIgnored = (name: string): boolean => {
  const lower = name.toLowerCase();
  return TREE_IGNORED_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

const TREE_MAX_ENTRIES = 500;
// Kiro's FileTreeSerializer constants (bundle @176978-176981, @176511):
const TREE_LARGE_DIR = 50; // >= 50 children -> list only first 30 + <summary>
const TREE_LARGE_SHOW = 30;
const TREE_MAX_CHARS = 8000;

/**
 * Kiro-style: directories containing currently open editor files are always
 * expanded (ve3({ paths: [...expandedPaths, ...openedFiles] })). Returns the
 * set of all ancestor directories of open files, keyed by fsPath.
 */
export function openFileAncestorDirs(rootPath: string): Set<string> {
  const dirs = new Set<string>();
  const root = path.resolve(rootPath);
  const editors = [
    ...vscode.window.visibleTextEditors.map((e) => e.document.uri),
    ...vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .map((t) =>
        t.input instanceof vscode.TabInputText ? t.input.uri : undefined,
      ),
  ].filter((uri): uri is vscode.Uri => !!uri && uri.scheme === "file");
  for (const uri of editors) {
    const filePath = path.resolve(uri.fsPath);
    if (filePath !== root && !filePath.startsWith(root + path.sep)) continue;
    // Walk ancestors from the file's directory up to (but excluding) root.
    // Every level is force-expanded so the file is visible in the tree.
    let dir = path.dirname(filePath);
    while (dir !== root && dir.startsWith(root + path.sep)) {
      dirs.add(dir);
      dir = path.dirname(dir);
    }
  }
  return dirs;
}

interface TreeNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  status: "expanded" | "closed";
  children: TreeNode[];
  summary?: string;
}

/**
 * Kiro-style <session_start_snapshot> tree, following Kiro's FileTreeSerializer
 * (bundle ve3/E5/Ie2/ke3) instead of a fixed-depth DFS:
 *  1. Explicitly expand every directory on the open-file ancestor chain.
 *  2. BFS-discover closed directories (fe3 filter) until `target` entries are
 *     open — shallow dirs get budget first, deep dirs stay closed.
 *  3. Large dirs (>= 50 children) list only the first 30 + a summary.
 *  4. Final hard cap of 8000 chars, telling the model to use list_directory.
 * Names are relative to the parent, so a 60-char Windows prefix isn't repeated
 * on every node.
 */
function buildFileTreeSync(
  rootPath: string,
  forceExpand: Set<string> = new Set(),
): string {
  const root: TreeNode = {
    name: ".",
    fullPath: rootPath,
    isDir: true,
    status: "closed",
    children: [],
  };
  let openCount = 0;

  // Kiro's fe3: skip excluded dirs/hidden names during BFS discovery.
  const expandable = (node: TreeNode): boolean => {
    if (!node.isDir || node.status !== "closed") return false;
    const n = node.name.toLowerCase();
    if (n.startsWith(".")) return false;
    return !FOLDED_TREE_DIRS.has(n);
  };

  // E5: list a directory, build child nodes, mark large ones with a summary.
  const expandNode = (node: TreeNode, force = false): void => {
    if (node.status === "expanded") return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(node.fullPath, { withFileTypes: true });
    } catch {
      node.status = "expanded";
      return;
    }
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    // Kiro's fe3 file-glob exclusion: drop matching files from the tree
    // entirely (they'd only burn the entry budget: locks, images, maps...).
    const filtered = entries.filter(
      (e) => e.isDirectory() || !treeFileIgnored(e.name),
    );
    const summarize = filtered.length >= TREE_LARGE_DIR && !force;
    const shown = summarize ? filtered.slice(0, TREE_LARGE_SHOW) : filtered;
    const hidden = filtered.length - shown.length;
    node.children = shown.map((entry) => ({
      name: entry.name,
      fullPath: path.join(node.fullPath, entry.name),
      isDir: entry.isDirectory(),
      status: "closed",
      children: [],
    }));
    if (hidden > 0) {
      node.summary = `${filtered.length} entries — first ${TREE_LARGE_SHOW} shown, ${hidden} more (use list_directory)`;
    }
    node.status = "expanded";
    openCount += shown.length;
  };

  // O4/E5 for explicitly requested paths: walk each ancestor chain top-down,
  // force-expanding every level so the open file is visible even if deep.
  const expandPath = (dir: string): void => {
    const rel = path.relative(rootPath, dir);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return;
    let node = root;
    if (node.status === "closed") expandNode(node, true);
    for (const part of rel.split(path.sep).filter(Boolean)) {
      const child = node.children.find((c) => c.isDir && c.name === part);
      if (!child) break;
      expandNode(child, true);
      node = child;
    }
  };
  for (const dir of forceExpand) {
    expandPath(path.resolve(dir));
  }

  // The root is named "." - expandable() skips dot-names, so make sure the
  // root skeleton is expanded before BFS (otherwise the tree stays empty).
  expandNode(root, true);

  // Ie2/ke3: BFS over the tree; expand the first eligible closed directory
  // until the open-entry budget is exhausted (shallow dirs first).
  for (let i = 0; i < TREE_MAX_ENTRIES && openCount < TREE_MAX_ENTRIES; i++) {
    const queue: TreeNode[] = [root];
    let target: TreeNode | undefined;
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (expandable(node)) {
        target = node;
        break;
      }
      queue.push(...node.children);
    }
    if (!target) break;
    expandNode(target);
  }

  // be3: serialize the tree with relative names and indentation.
  const lines: string[] = [];
  const serialize = (node: TreeNode, indent: string): void => {
    for (const child of node.children) {
      if (!child.isDir) {
        lines.push(`${indent}<file name='${child.name}' />`);
      } else if (child.status === "expanded") {
        lines.push(`${indent}<folder name='${child.name}'>`);
        if (child.summary) {
          lines.push(`${indent}  <summary>${child.summary}</summary>`);
        }
        serialize(child, indent + "  ");
        lines.push(`${indent}</folder>`);
      } else {
        lines.push(`${indent}<folder name='${child.name}' closed />`);
      }
    }
  };
  lines.push(`<fileTree root='${rootPath}'>`, `<folder name='.'>`);
  serialize(root, "  ");
  lines.push("</folder>", "</fileTree>");
  let tree = lines.join("\n");
  // Kiro's final hard cap: 8000 chars, then tell the model to use tools.
  if (tree.length > TREE_MAX_CHARS) {
    tree =
      tree.substring(0, TREE_MAX_CHARS) +
      "\n... (truncated, use listDirectory to explore)";
  }
  return tree;
}

let cachedTree: { key: string; tree: string; at: number } | undefined;
const treeWatchers = new Map<string, vscode.FileSystemWatcher>();

/**
 * A file created/deleted/renamed anywhere under the root invalidates the
 * snapshot immediately - equivalent to Kiro regenerating the tree on every
 * turn, but with zero cost when nothing changed. Tmp/scratch and .micat
 * (steering/config) files are ignored - they aren't in the tree, so writes
 * there shouldn't invalidate the snapshot.
 */
function ensureTreeWatcher(rootPath: string): void {
  if (treeWatchers.has(rootPath)) return;
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(rootPath, "**/*"),
  );
  const invalidate = (uri: vscode.Uri) => {
    const rel = path.relative(rootPath, uri.fsPath).split(path.sep);
    if (rel.includes("tmp") || rel.includes(".micat")) return;
    if (cachedTree?.key.startsWith(rootPath + "|")) cachedTree = undefined;
  };
  watcher.onDidCreate(invalidate);
  watcher.onDidDelete(invalidate);
  watcher.onDidChange(invalidate);
  treeWatchers.set(rootPath, watcher);
}

/** Cache key includes the open-file expansion signature: switching files
 *  changes the tree, so the cache must be invalidated. */
function treeCacheKey(rootPath: string, forceExpand: Set<string>): string {
  return `${rootPath}|${[...forceExpand].sort().join(",")}`;
}

/** Session-start snapshot: rebuilt on FS changes or editor switches. */
function sessionFileTree(rootPath: string): string {
  ensureTreeWatcher(rootPath);
  const forceExpand = openFileAncestorDirs(rootPath);
  const key = treeCacheKey(rootPath, forceExpand);
  const now = Date.now();
  if (cachedTree?.key === key && now - cachedTree.at < 10 * 60_000) {
    return cachedTree.tree;
  }
  const tree = buildFileTreeSync(rootPath, forceExpand);
  setSessionFileTreeCache(rootPath, tree, forceExpand);
  return tree;
}

/** Shared with the GUI's async micatGetFileTree request path. */
export function getCachedSessionFileTree(rootPath: string): string | undefined {
  const forceExpand = openFileAncestorDirs(rootPath);
  const key = treeCacheKey(rootPath, forceExpand);
  if (cachedTree?.key === key && Date.now() - cachedTree.at < 10 * 60_000) {
    return cachedTree.tree;
  }
  return undefined;
}

export function setSessionFileTreeCache(
  rootPath: string,
  tree: string,
  forceExpand: Set<string> = openFileAncestorDirs(rootPath),
): void {
  ensureTreeWatcher(rootPath);
  cachedTree = {
    key: treeCacheKey(rootPath, forceExpand),
    tree,
    at: Date.now(),
  };
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
    "<workspace_folder>",
    ...mounts.map((m) => `- The workspace root is: ${m.realPath}`),
    "- Create new files inside these folders and resolve relative paths against them.",
    "</workspace_folder>",
    "",
    ...(mounts.length > 0
      ? [
          '<session_start_snapshot captured="session-start">',
          "This file tree was captured when the session started. Folders marked 'closed' can be explored with the directory listing tools.",
          sessionFileTree(mounts[0].realPath),
          "</session_start_snapshot>",
          "",
        ]
      : []),
    "<workspace_context>",
    singleRoot
      ? "Workspace directory (virtual-root-relative path):"
      : "Workspace directories (virtual-root-relative paths):",
    ...mounts.map((m) => m.virtualPath),
    "</workspace_context>",
    "",
    "<filesystem_capabilities>",
    "Absolute paths OUTSIDE the workspace directories listed above are fully",
    "accessible with the filesystem tools (list_directory, read_file, file_search,",
    "grep_search, fs_write, str_replace). When a tool call targets such a path, the user is simply asked",
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
  // Backend methods whose first (or second, for glob/grep) argument is a path.
  const pathArgIndex: Record<string, number> = {
    read: 0,
    ls: 0,
    write: 0,
    edit: 0,
    delete: 0,
    glob: 1,
    grep: 1,
  };
  // The permission engine is keyed by the Kiro tool name; translate the backend
  // method name before calling `decide`.
  const backendMethodToTool: Record<string, string> = {
    read: "read_file",
    ls: "list_directory",
    write: "fs_write",
    append: "fs_append",
    edit: "str_replace",
    delete: "delete_file",
    glob: "file_search",
    grep: "grep_search",
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
            const action = opts.decide(
              backendMethodToTool[prop] ?? prop,
              pathArg,
            );
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
