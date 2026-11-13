/**
 * hitlBridge
 * ----------
 * A tiny module-level bridge between the DeepAgent HITL loop (which runs inside
 * `DeepAgentLLM.streamChat`) and the GUI's ReviewChangesCard.
 *
 * Flow:
 *   1. The agent pauses on an interrupt → `DeepAgentLLM` calls
 *      `requestHitlDecision(payload)`, which stashes a resolver and asks the GUI
 *      to show the approval card (via the IDE→GUI `deepAgentInterrupt` message).
 *   2. The user clicks Approve/Deny in the GUI → the GUI posts
 *      `deepAgentInterruptResponse` → `VsCodeMessenger` routes it to
 *      `resolveHitlDecision`, which resolves the pending promise.
 *   3. `DeepAgentLLM` resumes the agent with `Command({ resume: { decisions } })`.
 *
 * The bridge holds a reference to the webview protocol (injected by
 * `VsCodeMessenger` at startup) so `DeepAgentLLM` does not need to import it
 * directly.
 */

import type { VsCodeWebviewProtocol } from "../webviewProtocol";

export type HitlDecision = { id: string; type: "approve" | "reject" };

let protocol: VsCodeWebviewProtocol | null = null;
let resolver: ((decisions: HitlDecision[]) => void) | null = null;
let rejecter: ((e: Error) => void) | null = null;

/** Called once at startup by VsCodeMessenger with the live protocol instance. */
export function setHitlProtocol(p: VsCodeWebviewProtocol): void {
  protocol = p;
}

/**
 * Ask the GUI to render an approval card for `payload` and wait for the user's
 * decision. Resolves with the decisions array (parallel to actionRequests).
 */
export function requestHitlDecision(payload: unknown): Promise<HitlDecision[]> {
  const promise = new Promise<HitlDecision[]>((resolve, rej) => {
    resolver = resolve;
    rejecter = rej;
  });
  console.log(
    "[hitlBridge] >>> interrupt sent to GUI |",
    JSON.stringify(payload)?.slice(0, 500),
  );
  // Fire-and-forget: the GUI replies on a separate message channel
  // (deepAgentInterruptResponse). Any send failure just leaves the resolver
  // pending — the abort path (cancelHitlDecision) clears it.
  void protocol
    ?.request("deepAgentInterrupt", { request: payload })
    .catch((e) =>
      console.log("[hitlBridge] interrupt send failed |", String(e)),
    );
  return promise;
}

/** Resolve the pending decision promise (called from VsCodeMessenger). */
export function resolveHitlDecision(decisions: HitlDecision[]): void {
  console.log(
    "[hitlBridge] <<< decision received from GUI |",
    JSON.stringify(decisions),
  );
  const r = resolver;
  resolver = null;
  rejecter = null;
  r?.(decisions);
}

/**
 * Abort the pending wait (e.g. the user pressed Stop mid-approval). Rejects the
 * awaiting streamChat so the turn can wind down instead of hanging forever.
 */
export function cancelHitlDecision(reason: string): void {
  if (!resolver && !rejecter) return;
  console.log("[hitlBridge] decision wait cancelled |", reason);
  const rej = rejecter;
  resolver = null;
  rejecter = null;
  rej?.(new Error(reason));
}
