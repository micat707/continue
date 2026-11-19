/**
 * hitlBridge
 * ----------
 * A tiny module-level bridge between the DeepAgent HITL loop (which runs inside
 * `DeepAgentLLM.streamChat`) and the GUI's ReviewChangesCard.
 *
 * Flow:
 *   1. The agent pauses on an interrupt → `DeepAgentLLM` calls
 *      `requestHitlDecision(payload, signal)`, which registers a request under a
 *      unique requestId and asks the GUI to show the approval card (IDE→GUI
 *      `deepAgentInterrupt`, carrying the requestId).
 *   2. The user clicks Approve/Deny in the GUI → the GUI posts
 *      `deepAgentInterruptResponse` with the same requestId → `VsCodeMessenger`
 *      routes it to `resolveHitlDecision`, which resolves only that request.
 *      Pending requests are keyed by requestId so concurrent chat sessions can
 *      never resolve or cancel each other's approvals.
 *   3. `DeepAgentLLM` resumes the agent with `Command({ resume: { decisions } })`.
 *
 * The bridge holds a reference to the webview protocol (injected by
 * `VsCodeMessenger` at startup) so `DeepAgentLLM` does not need to import it
 * directly.
 */

import { randomUUID } from "crypto";
import type { VsCodeWebviewProtocol } from "../webviewProtocol";

export type HitlDecision = { id: string; type: "approve" | "reject" };

let protocol: VsCodeWebviewProtocol | null = null;

// Keyed by requestId instead of a single module-level resolver: two chat
// sessions can each pause on an interrupt at the same time, and a decision from
// one must never resolve the other's promise. A stale/duplicate response is a
// no-op if its id is not pending.
interface PendingHitl {
  resolve: (decisions: HitlDecision[]) => void;
  reject: (e: Error) => void;
}
const pending = new Map<string, PendingHitl>();

/** Called once at startup by VsCodeMessenger with the live protocol instance. */
export function setHitlProtocol(p: VsCodeWebviewProtocol): void {
  protocol = p;
}

/**
 * Ask the GUI to render an approval card for `payload` and wait for the user's
 * decision. Resolves with the decisions array (parallel to actionRequests).
 */
export function requestHitlDecision(
  payload: unknown,
  signal?: AbortSignal,
): Promise<HitlDecision[]> {
  const requestId = randomUUID();
  const promise = new Promise<HitlDecision[]>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    // Abort only THIS request, so pressing Stop in one chat session does not
    // cancel an approval pending in another session.
    if (signal) {
      const onAbort = () => {
        const p = pending.get(requestId);
        if (!p) return;
        pending.delete(requestId);
        p.reject(new Error("chat turn aborted by user during HITL wait"));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  console.log(
    "[hitlBridge] >>> interrupt sent to GUI | requestId=" + requestId,
    JSON.stringify(payload)?.slice(0, 500),
  );
  // Fire-and-forget: the GUI replies on a separate message channel
  // (deepAgentInterruptResponse). A send failure rejects this request; its
  // AbortSignal (if provided) also clears it on Stop.
  void protocol
    ?.request("deepAgentInterrupt", { requestId, request: payload })
    .catch((e) => {
      const p = pending.get(requestId);
      pending.delete(requestId);
      console.log("[hitlBridge] interrupt send failed |", String(e));
      p?.reject(e instanceof Error ? e : new Error(String(e)));
    });
  return promise;
}

/** Resolve the matching pending decision promise (called from VsCodeMessenger). */
export function resolveHitlDecision(
  requestId: string,
  decisions: HitlDecision[],
): void {
  console.log(
    "[hitlBridge] <<< decision received from GUI | requestId=" + requestId,
    JSON.stringify(decisions),
  );
  const p = pending.get(requestId);
  if (!p) {
    console.log(
      "[hitlBridge] !! decision for unknown/stale requestId, ignored |",
      requestId,
    );
    return;
  }
  pending.delete(requestId);
  p.resolve(decisions);
}

/**
 * Abort every pending wait (e.g. the user pressed Stop mid-approval). Rejects
 * the awaiting streamChat instances so their turns wind down instead of hanging.
 */
export function cancelHitlDecision(reason: string): void {
  if (pending.size === 0) return;
  console.log(
    "[hitlBridge] decision waits cancelled (" + pending.size + ") |",
    reason,
  );
  const all = Array.from(pending.values());
  pending.clear();
  for (const p of all) p.reject(new Error(reason));
}
