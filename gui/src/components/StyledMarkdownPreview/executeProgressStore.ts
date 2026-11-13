/**
 * Per-run live-output store for DeepAgent `execute` cards.
 *
 * The extension streams the running command's output as INCREMENTAL chunks via
 * the `deepagentExecuteProgress` webview event, keyed by a unique runId (not the
 * command string). This store accumulates the full text per run, and lets each
 * running card subscribe to its OWN run — so a historical/completed card (or a
 * later run of the same command) can never be overwritten by a newer command's
 * output. On `done`, it records the exit code so the card can flip in place.
 *
 * The buffer is capped (MAX_LIVE_BYTES) so a huge build can't grow memory
 * unbounded; older history beyond the cap is dropped from the card (the full
 * text still lives in the terminal / offload file).
 */

const MAX_LIVE_BYTES = 500 * 1024; // keep the most recent ~500KB in the live card

interface RunState {
  buffer: string;
  done: boolean;
  exitCode: number | null;
  listeners: Set<() => void>;
}

const runs = new Map<string, RunState>();

function getRun(runId: string): RunState {
  let r = runs.get(runId);
  if (!r) {
    r = { buffer: "", done: false, exitCode: null, listeners: new Set() };
    runs.set(runId, r);
  }
  return r;
}

/** Append an incremental output slice for `runId` and notify subscribers. */
export function appendExecuteProgress(runId: string, chunk: string): void {
  const r = getRun(runId);
  r.buffer += chunk;
  if (r.buffer.length > MAX_LIVE_BYTES) {
    r.buffer = r.buffer.slice(r.buffer.length - MAX_LIVE_BYTES);
  }
  for (const l of r.listeners) l();
}

/** Mark `runId` finished with its exit code; subscribers flip the card. */
export function finishExecuteProgress(
  runId: string,
  exitCode: number | null,
): void {
  const r = getRun(runId);
  r.done = true;
  r.exitCode = exitCode;
  for (const l of r.listeners) l();
}

/** The accumulated (capped) live output for `runId`. */
export function getExecuteBuffer(runId: string): string {
  return runs.get(runId)?.buffer ?? "";
}

/** Completion state for `runId`. */
export function getExecuteDone(runId: string): {
  done: boolean;
  exitCode: number | null;
} {
  const r = runs.get(runId);
  return { done: r?.done ?? false, exitCode: r?.exitCode ?? null };
}

/** Subscribe to changes for `runId`; returns an unsubscribe function. */
export function subscribeExecuteProgress(
  runId: string,
  listener: () => void,
): () => void {
  const r = getRun(runId);
  r.listeners.add(listener);
  return () => {
    const s = runs.get(runId);
    if (!s) return;
    s.listeners.delete(listener);
    if (s.listeners.size === 0 && s.done) runs.delete(runId);
  };
}

/** Drop all stored state for a run (call once the card is no longer live). */
export function clearExecuteProgress(runId: string): void {
  runs.delete(runId);
}
