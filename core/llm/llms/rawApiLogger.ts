// Pluggable sink for raw wire-level API request/response logging.
//
// The actual on-disk writer lives in the VS Code extension (it needs `vscode`
// + fs), so core stays UI-agnostic: the extension registers a callback that
// routes these entries into the same llm.log file used by the adapter-level
// REQUEST-TO-MODEL / RESPONSE-FROM-MODEL dumps. When nothing is registered
// (e.g. the GUI, which has no on-disk log) this is a no-op — calling it never
// throws, so it is always safe to invoke from the hot request/response path.
export type RawApiLogger = (section: string, body: string) => void;

let sink: RawApiLogger | null = null;

export function registerRawApiLogger(fn: RawApiLogger | null): void {
  sink = fn;
}

export function logRawApi(section: string, body: string): void {
  try {
    sink?.(section, body);
  } catch {
    /* logging must never break a model call */
  }
}
