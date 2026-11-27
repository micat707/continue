/**
 * GUI-side marker for sessions that are paused waiting for a DeepAgent HITL
 * decision. The stream watchdog must not treat that pause as a dead model
 * stream: the model is not generating, it is waiting for the human.
 *
 * Keyed by session id so a background chat waiting for approval cannot suppress
 * the watchdog in another chat.
 */
const pendingSessions = new Set<string>();

export function markHitlPending(sessionId?: string): void {
  if (sessionId) pendingSessions.add(sessionId);
}

export function clearHitlPending(sessionId?: string): void {
  if (sessionId) pendingSessions.delete(sessionId);
}

export function isHitlPending(sessionId?: string): boolean {
  return Boolean(sessionId && pendingSessions.has(sessionId));
}
