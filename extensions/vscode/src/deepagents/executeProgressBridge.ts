/**
 * executeProgressBridge
 * ---------------------
 * A tiny module-level bridge that lets the DeepAgent `execute` backend push live
 * output updates to the GUI's "Run Command" card without importing the webview
 * protocol directly (mirrors hitlBridge).
 *
 * Flow:
 *   1. `runCommandViaTerminal` streams INCREMENTAL output chunks to the GUI via
 *      `postExecuteProgress(runId, chunk)`, and a final `postExecuteProgressDone`
 *      when the command finishes.
 *   2. `VsCodeMessenger` injects the live `VsCodeWebviewProtocol` at startup via
 *      `setExecuteProgressProtocol`.
 *   3. The GUI listens for `deepagentExecuteProgress` and feeds a per-run store
 *      keyed by `runId`; the running card appends the chunks and flips in place
 *      on `done` — no chat-text re-emission, no dedup needed.
 *
 * The bridge holds only a reference to the protocol (injected at startup).
 */
import type { VsCodeWebviewProtocol } from "../webviewProtocol";

let protocol: VsCodeWebviewProtocol | null = null;

/** Called once at startup by VsCodeMessenger with the live protocol instance. */
export function setExecuteProgressProtocol(p: VsCodeWebviewProtocol): void {
  protocol = p;
}

/** Append an incremental slice of output for `runId` (fire-and-forget). */
export function postExecuteProgress(runId: string, chunk: string): void {
  void protocol
    ?.request("deepagentExecuteProgress", { runId, chunk })
    .catch((e) =>
      console.log("[executeProgressBridge] send failed |", String(e)),
    );
}

/** Signal that `runId` finished; the card flips to its final (green/red) state. */
export function postExecuteProgressDone(
  runId: string,
  exitCode: number | null,
): void {
  void protocol
    ?.request("deepagentExecuteProgress", { runId, done: true, exitCode })
    .catch((e) =>
      console.log("[executeProgressBridge] send failed |", String(e)),
    );
}
