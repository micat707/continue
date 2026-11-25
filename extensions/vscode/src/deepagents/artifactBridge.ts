/**
 * Module-level bridge between the DeepAgent create_artifact tool (which runs
 * inside the wrapped-model singleton and has no webview reference) and the
 * Continue GUI webviewProtocol (owned by commands.ts / sidebar).
 */
import type { ArtifactPayload } from "./kiroExtraTools";

type Pusher = (payload: ArtifactPayload) => void | Promise<void>;

let pusher: Pusher | undefined;
const pending: ArtifactPayload[] = [];

export function setArtifactPusher(fn: Pusher | undefined): void {
  pusher = fn;
  if (pusher) {
    while (pending.length) {
      void pusher(pending.shift()!);
    }
  }
}

export function pushArtifactToGui(payload: ArtifactPayload): void {
  if (pusher) {
    void pusher(payload);
  } else {
    pending.push(payload);
  }
}
