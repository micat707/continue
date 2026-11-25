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
  sessionId?: string;
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
  sessionId?: string,
): Promise<HitlDecision[]> {
  const requestId = randomUUID();
  const promise = new Promise<HitlDecision[]>((resolve, reject) => {
    pending.set(requestId, { resolve, reject, sessionId });
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
    ?.request("deepAgentInterrupt", {
      requestId,
      sessionId,
      request: payload,
    })
    .catch((e) => {
      const p = pending.get(requestId);
      pending.delete(requestId);
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(
        "[hitlBridge] interrupt send failed |",
        err.message,
        "\nSTACK:",
        err.stack,
      );
      p?.reject(err);
    });
  return promise;
}

/** Resolve the matching pending decision promise (called from VsCodeMessenger). */
export function resolveHitlDecision(
  requestId: string,
  decisions: HitlDecision[],
  sessionId?: string,
): void {
  console.log(
    "[hitlBridge] <<< decision received from GUI | requestId=" + requestId,
    " session=" + (sessionId ?? "n/a"),
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
  // If the GUI echoed a session id, make sure it matches the session that
  // created the request; a mismatched decision is a stale/cross-session reply.
  if (sessionId && p.sessionId && sessionId !== p.sessionId) {
    console.log(
      "[hitlBridge] !! decision session mismatch, ignored |",
      requestId,
      sessionId,
      "!=",
      p.sessionId,
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
export function cancelHitlDecision(reason: string, sessionId?: string): void {
  if (pending.size === 0) return;
  const entries = Array.from(pending.entries()).filter(
    ([, p]) => !sessionId || p.sessionId === sessionId,
  );
  if (entries.length === 0) return;
  console.log(
    "[hitlBridge] decision waits cancelled (" + entries.length + ") |",
    reason,
    "session=" + (sessionId ?? "all"),
  );
  for (const [requestId, p] of entries) {
    pending.delete(requestId);
    p.reject(new Error(reason));
  }
}
