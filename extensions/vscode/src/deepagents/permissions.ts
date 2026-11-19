/**
 * DeepAgent tool-permission model (pure logic, no VS Code dependency).
 *
 * Three layers of rules are merged at runtime:
 *   global  → workspace  → session   (first explicit match wins)
 *
 * Each layer holds, per tool and per *scope* (inside / outside the trusted
 * area), one of three actions:
 *   - "allow": run with no prompt
 *   - "ask":   pause and show the approval card (human-in-the-loop)
 *   - "deny":  hard-block (throw, no card)
 *
 * A HARD RED LINE: an OUTSIDE-scope FILE tool can never be "allow" — only
 * "ask"/"deny". This stops a user (or a misconfigured policy) from silently
 * green-lighting writes/deletes to paths outside the workspace.
 */

export type PermissionAction = "allow" | "ask" | "deny";

export interface ToolPermRule {
  tool: string;
  action: PermissionAction;
}

export interface PermissionConfig {
  /** Extra trusted directories (absolute). Inside these = "trusted" scope. */
  trustedDirs: string[];
  /** Rules applied when the path is inside the trusted scope. */
  trustRules: ToolPermRule[];
  /** Rules applied when the path is outside the trusted scope. */
  untrustRules: ToolPermRule[];
  /**
   * Programs (or command patterns) whose `execute` calls auto-run WITHOUT the
   * approval card. Intentionally a USER-authored safelist (sudoers-style) — it
   * is NOT decided by the model. Combined with the shell-injection guard below,
   * this lets routine checks ("mvn compile", "tsc", "npm test"…) run hands-free
   * while anything not listed — or any command containing shell metacharacters —
   * still pauses for the human.
   */
  executeAllowlist: string[];
}

export const DEFAULT_PERMISSION_CONFIG: PermissionConfig = {
  trustedDirs: [],
  trustRules: [
    { tool: "read_file", action: "allow" },
    { tool: "read_files", action: "allow" },
    { tool: "fs_write", action: "allow" },
    { tool: "fs_append", action: "allow" },
    { tool: "str_replace", action: "allow" },
    { tool: "delete_file", action: "ask" },
    { tool: "list_directory", action: "allow" },
    { tool: "file_search", action: "allow" },
    { tool: "grep_search", action: "allow" },
  ],
  untrustRules: [
    { tool: "read_file", action: "ask" },
    { tool: "read_files", action: "ask" },
    { tool: "fs_write", action: "ask" },
    { tool: "fs_append", action: "ask" },
    { tool: "str_replace", action: "ask" },
    { tool: "delete_file", action: "deny" },
    { tool: "list_directory", action: "ask" },
    { tool: "file_search", action: "ask" },
    { tool: "grep_search", action: "ask" },
  ],
  executeAllowlist: [],
};

const FILE_TOOLS = new Set([
  "read_file",
  "read_files",
  "fs_write",
  "fs_append",
  "str_replace",
  "delete_file",
]);

/**
 * Read-only tools — a session approval of one of these grants READ access to
 * the approved subtree only. Write-style tools must re-prompt regardless of
 * any prior read approval (the red line below enforces that at policy level;
 * the session memory gating in DeepAgentLLM enforces it at approval level).
 * Both naming conventions are listed: LangGraph interrupt tool names
 * (read_file…) and backend method names used by the withApprovedPaths proxy
 * (read, write…).
 */
const READ_TOOLS = new Set([
  "read_file",
  "list_directory",
  "file_search",
  "grep_search",
  // backend method names used by withApprovedPaths proxy
  "read",
  "ls",
  "glob",
  "grep",
]);

export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool);
}

export function isFileTool(tool: string): boolean {
  return FILE_TOOLS.has(tool);
}

/** Normalize a path for prefix comparisons (lowercase, forward slashes, no trailing slash). */
export function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function isInsideDir(path: string, dir: string): boolean {
  const n = normalizePath(path);
  const d = normalizePath(dir);
  return n === d || n.startsWith(d + "/");
}

/** Which policy layer a rule came from (for the UI "source" column). */
export type LayerKey = "global" | "workspace" | "session";

export interface MergedRules {
  trustRules: Map<string, PermissionAction>;
  untrustRules: Map<string, PermissionAction>;
  /** Layer that provided each trust-rule's effective action. */
  trustSources: Map<string, LayerKey>;
  /** Layer that provided each untrust-rule's effective action. */
  untrustSources: Map<string, LayerKey>;
  trustedDirs: string[];
  /** Union of all layers' `executeAllowlist` entries (deduped). */
  executeAllowlist: string[];
}

/**
 * Merge three layers (global → workspace → session). Later layers override
 * earlier ones for the same (tool) key in each scope, and the winning layer is
 * recorded in the `trustSources` / `untrustSources` maps so the UI can show the
 * "来源" column and disable inherited rows. `session` may be null/partial.
 */
export function mergeRules(
  global: PermissionConfig,
  workspace: PermissionConfig | null,
  session: PermissionConfig | null,
): MergedRules {
  const trust = new Map<string, PermissionAction>();
  const untrust = new Map<string, PermissionAction>();
  const trustSources = new Map<string, LayerKey>();
  const untrustSources = new Map<string, LayerKey>();
  const trustedDirs = new Set<string>(global.trustedDirs);

  const apply = (cfg: PermissionConfig | null | undefined, layer: LayerKey) => {
    if (!cfg) return;
    cfg.trustRules.forEach((r) => {
      trust.set(r.tool, r.action);
      trustSources.set(r.tool, layer);
    });
    cfg.untrustRules.forEach((r) => {
      untrust.set(r.tool, r.action);
      untrustSources.set(r.tool, layer);
    });
    cfg.trustedDirs.forEach((d) => trustedDirs.add(d));
    (cfg.executeAllowlist ?? []).forEach((a) => allowlist.add(a));
  };

  const allowlist = new Set<string>();
  apply(global, "global");
  apply(workspace, "workspace");
  apply(session, "session");

  return {
    trustRules: trust,
    untrustRules: untrust,
    trustSources,
    untrustSources,
    trustedDirs: [...trustedDirs],
    executeAllowlist: [...allowlist],
  };
}

/**
 * Effective action for a tool + scope given merged rules, applying:
 *  - default: inside → allow, outside → ask
 *  - HARD RED LINE: an outside-scope FILE tool can never be "allow".
 */
export function resolveAction(args: {
  tool: string;
  scope: "inside" | "outside";
  merged: MergedRules;
}): PermissionAction {
  const { tool, scope, merged } = args;
  const rules = scope === "inside" ? merged.trustRules : merged.untrustRules;
  const configured = rules.get(tool);
  let result: PermissionAction =
    configured ?? (scope === "inside" ? "allow" : "ask");

  if (scope === "outside" && isFileTool(tool) && result === "allow") {
    result = "ask"; // red line: untrusted file ops cannot be allowlisted
  }
  return result;
}

/**
 * Shell metacharacters that let a benign-looking prefix (`mvn`) be abused into
 * a second command (`mvn ; rm -rf /`). Such a command is NEVER auto-approved
 * even if its program is allowlisted — it falls back to the approval card.
 */
const SHELL_METACHAR_RE = /[;|&<>$`()\n\r]/;

/**
 * True when `command` may auto-run without the approval card. Matches if any
 * allowlist entry matches the command's first token (the executable) or, for
 * entries with a space, a plain leading-substring; `/regex/` entries are
 * treated as a full regular expression. A command containing shell
 * metacharacters is always rejected (see SHELL_METACHAR_RE) so a trusted
 * executable prefix cannot be turned into a chained/redirected command.
 */
export function isSafeAllowlistedCommand(
  command: string,
  allowlist: string[],
): boolean {
  const cmd = command.trim();
  if (!cmd || allowlist.length === 0) return false;
  if (SHELL_METACHAR_RE.test(cmd)) return false;
  const lower = cmd.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim();
    if (!e) return false;
    if (e.startsWith("/") && e.endsWith("/")) {
      try {
        return new RegExp(e.slice(1, -1)).test(cmd);
      } catch {
        return false;
      }
    }
    const firstToken = lower.split(/\s+/)[0];
    if (firstToken === e.toLowerCase()) return true;
    return lower.startsWith(e.toLowerCase());
  });
}

/**
 * Top-level OS directories whose recursive deletion is catastrophic. Matched as
 * a full path or a path prefix (e.g. `/home`, `/home/user`).
 */
const TOP_LEVEL_OS_DIRS = [
  "/etc",
  "/usr",
  "/bin",
  "/sbin",
  "/lib",
  "/lib64",
  "/home",
  "/var",
  "/opt",
  "/boot",
  "/root",
  "/tmp",
  "/srv",
  "/mnt",
  "/media",
  "/sys",
  "/proc",
  "/dev",
  "/Applications",
  "/Users",
  "/System",
  "/private",
];

/**
 * True for commands that recursively delete — or otherwise catastrophically
 * destroy — a ROOT scope: the OS root (`/`, `/*`), a drive root (`C:\`),
 * the user's home (`~`), a top-level OS directory, or an ENTIRE workspace
 * (via its real path or its virtual mount prefix). Also blocks `format`,
 * `mkfs`, raw `dd of=/dev/...`, and power/fork-bomb commands.
 *
 * These are NEVER permitted to run: neither the approval card nor the
 * allowlist can grant them, because they can wipe the system or the user's
 * whole project. The check is path-scope aware — a sub-directory deletion
 * (e.g. `rm -rf node_modules`, `rm -rf ./dist`) is NOT caught.
 *
 * @param workspaceRealPaths real on-disk workspace roots.
 * @param protectedPrefixes  virtual mount paths (e.g. `/hello_world/`) — so a
 *                           multi-root `rm -rf /hello_world` is blocked too,
 *                           before the path is translated to its real path.
 */
export function isDestructiveRootCommand(
  command: string,
  workspaceRealPaths: string[] = [],
  protectedPrefixes: string[] = [],
): boolean {
  if (!command) return false;
  // Split on shell chaining operators so each simple command is judged on its
  // own (catches `cd / && rm -rf .`, `x && rm -rf /`, …).
  for (const seg of command.split(/[|\n\r&;]+/)) {
    const s = seg.trim();
    if (!s) continue;
    // A recursive / forced delete: rm -rf, del /s /q, rd /s /q, sudo rm -r,
    // PowerShell Remove-Item -Recurse, deltree… The leading boundary (no word
    // char) stops `model`/`folder` from matching `rm`/`del` mid-word.
    if (
      !/(?:^|\s)(?:sudo\s+)?(?:rm|del|rd|rmdir|deltree|remove-item)(?:\.exe)?\b/i.test(
        s,
      )
    ) {
      continue;
    }
    if (!/(?:--recursive|\s-[rR]\w*|\s-\w*r|\s\/[sq])/i.test(s)) continue;
    // Capture candidate targets: /path, ~/path, ./path, ../path, ".", "..",
    // and X:\path. (A bare "." / ".." is the CWD / parent — i.e. the whole
    // workspace when the shell runs there.)
    const targetRe =
      /(\~|\/|\.{1,2}(?:\/[^\s"']*)?|\b[A-Za-z]:\\?|\b[A-Za-z]:)[^\s"']*/g;
    let m: RegExpExecArray | null;
    while ((m = targetRe.exec(s))) {
      const t = m[0];
      const tl = t.toLowerCase();
      const hit =
        // OS / drive root, home
        t === "/" ||
        t === "/*" ||
        t === "~" ||
        t === "~/" ||
        t === "~/*" ||
        /^[a-z]:\\?$/.test(tl) ||
        /^[a-z]:\\\*$/.test(tl) ||
        // current / parent dir (the workspace cwd) — recursive wipe of it
        t === "." ||
        t === "./" ||
        t === "./*" ||
        t === ".." ||
        t === "../" ||
        t === "../*" ||
        // well-known Unix top-level dirs
        TOP_LEVEL_OS_DIRS.some(
          (d) => tl === d || tl.startsWith(d + "/") || tl.startsWith(d + "\\"),
        ) ||
        // critical Windows directories on ANY drive (C:\Windows, C:\Users, …)
        /^[a-z]:\\(windows|users|program files|programdata|system volume information|documents and settings)(?:$|\\|\/)/i.test(
          tl,
        ) ||
        // an entire workspace (real path or virtual mount prefix)
        workspaceRealPaths.some((p) => {
          const rp = p.replace(/[\\/]+$/, "").toLowerCase();
          return (
            tl === rp || tl.startsWith(rp + "\\") || tl.startsWith(rp + "/")
          );
        }) ||
        protectedPrefixes.some((p) => {
          const pp = p.replace(/\/+$/, "").toLowerCase();
          return (
            pp !== "/" &&
            (tl === pp || tl.startsWith(pp + "/") || tl.startsWith(pp + "\\"))
          );
        });
      if (hit) return true;
    }
  }
  // Other catastrophic commands — strict boundary (NO plain space) so words like
  // `shutdown` inside an echoed string are NOT mistaken for the command.
  if (
    /(?:^|&|;|\||\r|\n)(?:format\s+[a-z]:|mkfs|shutdown|halt|reboot|:\(\)\{:\|:&\};:)/i.test(
      command,
    )
  ) {
    return true;
  }
  // Raw disk overwrite: dd if=… of=/dev/…
  return /(?:^|[\s&;|])dd\b\s+if=[\s\S]*?of=\/dev\//i.test(command);
}

/**
 * Action for the path-less `execute` tool (arbitrary shell commands). A command
 * is NOT confined to any path scope — it can read/write any file the user can,
 * reach the network, spawn processes — so the inside/outside path rules do not
 * apply to it. The resolution is:
 *   - "deny":  a CATASTROPHIC command (recursive root/whole-workspace delete,
 *              format/mkfs/…) OR the policy is "deny" — hard-blocked, no card,
 *              and the allowlist CANNOT override it
 *   - "allow": the command matched the user's `executeAllowlist` AND contains
 *              no shell metacharacters → runs with NO card
 *   - "ask":   everything else → the HITL approval card shows the full command
 * HARD RED LINE: `execute` can never resolve to "allow" via the tool policy
 * alone — only an explicit, user-authored allowlist entry can grant that.
 */
export function resolveExecuteAction(
  merged: MergedRules,
  command?: string,
  workspaceRealPaths: string[] = [],
  protectedPrefixes: string[] = [],
): PermissionAction {
  const configured =
    merged.untrustRules.get("execute_pwsh") ??
    merged.trustRules.get("execute_pwsh");
  if (configured === "deny") return "deny";
  if (
    command &&
    isDestructiveRootCommand(command, workspaceRealPaths, protectedPrefixes)
  ) {
    return "deny"; // catastrophic — never allow, even via the allowlist
  }
  if (command && isSafeAllowlistedCommand(command, merged.executeAllowlist)) {
    return "allow";
  }
  return "ask";
}
