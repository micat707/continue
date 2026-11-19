import { IIdeMessenger } from "../../context/IdeMessenger";

/**
 * Kiro-style system-level context blocks (mirrors kiro_session.log's
 * history[0] system prompt): <system_information>,
 * <platform_specific_command_guidelines>, <workspace_folder>,
 * <current_date_and_time> and <session_start_snapshot>.
 *
 * The shell-aware blocks (<system_information>, command guidelines with the
 * per-shell command equivalents, date) are BUILT BY THE EXTENSION HOST
 * (shared with the DeepAgent flow's workspaceBackend - it detects
 * PowerShell 5.1/7/cmd/posix and its quirks like the missing `&&`).
 * The GUI only adds the workspace folder and the file tree snapshot,
 * and caches everything per session so the snapshot is captured once,
 * like Kiro does at session start.
 */

interface MicatEnvironment {
  platform: string;
  shell: string;
  homeDirUri: string;
  globalSteeringDirUri: string;
  workspaceRoot?: string;
  fileTree: string;
  systemInformationBlock: string;
  platformCommandGuidelinesBlock: string;
  currentDateTimeBlock: string;
}

let envCache: { key: string; value: MicatEnvironment } | null = null;

export function clearMicatEnvironmentCache(): void {
  envCache = null;
}

// The environment context must NEVER delay the first token: every RPC is
// time-boxed and degrades gracefully (blocks are simply omitted).
// PATHS needs headroom: the first call may synchronously spawn powershell.exe
// (shell version detection, up to ~5s); it is cached for 10 minutes after.
const PATHS_TIMEOUT_MS = 8000;
const FILE_TREE_TIMEOUT_MS = 5000;

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) =>
      setTimeout(() => {
        console.warn(
          `[MicatCode] ${label} timed out after ${timeoutMs}ms - skipping`,
        );
        resolve(undefined);
      }, timeoutMs),
    ),
  ]);
}

async function fetchEnvironment(
  ideMessenger: IIdeMessenger,
): Promise<MicatEnvironment> {
  const response = await withTimeout(
    ideMessenger.request("micatGetPaths", undefined),
    PATHS_TIMEOUT_MS,
    "micatGetPaths",
  );
  if (!response || response.status !== "success" || !response.content) {
    throw new Error("micatGetPaths failed or timed out");
  }
  const tree = await withTimeout(
    ideMessenger.request("micatGetFileTree", undefined),
    FILE_TREE_TIMEOUT_MS,
    "micatGetFileTree",
  );
  const fileTree =
    tree && tree.status === "success" ? (tree.content ?? "") : "";
  return { ...response.content, fileTree };
}

function buildEnvironmentSystemBlocks(env: MicatEnvironment): string {
  const blocks: string[] = [];

  blocks.push(env.systemInformationBlock);
  blocks.push(env.platformCommandGuidelinesBlock);

  if (env.workspaceRoot) {
    blocks.push(
      `<workspace_folder>
- The workspace root is: ${env.workspaceRoot}
- This is the current project directory. Create new files and directories inside this folder, and resolve relative paths against it.
- When the user asks you to create a project, app, or files without naming a location, place them inside this workspace root — not in the home directory or anywhere else outside it.
</workspace_folder>`,
    );
  }

  blocks.push(env.currentDateTimeBlock);

  if (env.fileTree) {
    blocks.push(
      `<session_start_snapshot captured="session-start">
This file tree was captured when the session started. Treat it as accurate unless a later action suggests it may have changed; only then re-read with the appropriate tools. Folders marked "closed" can be explored with directory listing tools.
${env.fileTree}
</session_start_snapshot>`,
    );
  }

  return blocks.join("\n\n");
}

/**
 * Returns the Kiro-style environment blocks to append to the system prompt.
 * Cached per session (cacheKey = session id) - the file tree snapshot is
 * captured on the first request of a session, like Kiro.
 */
export async function getMicatEnvironmentContext(
  ideMessenger: IIdeMessenger,
  cacheKey: string,
): Promise<string | undefined> {
  try {
    const started = Date.now();
    if (envCache?.key !== cacheKey) {
      envCache = {
        key: cacheKey,
        value: await fetchEnvironment(ideMessenger),
      };
      console.debug(
        `[MicatCode] Environment context captured in ${Date.now() - started}ms (session ${cacheKey})`,
      );
    }
    return buildEnvironmentSystemBlocks(envCache.value);
  } catch (e) {
    console.warn("[MicatCode] Failed to build environment context:", e);
    return undefined;
  }
}
