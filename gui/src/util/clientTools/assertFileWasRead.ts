import { BuiltInToolNames } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";
import { getUriPathBasename } from "core/util/uri";
import type { ClientToolExtras } from "./callClientTool";
import { selectActiveSession } from "../../redux/slices/sessionSlice";

const READ_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.ReadFile,
  BuiltInToolNames.ReadFileRange,
]);

const EDIT_TOOL_NAMES = new Set<string>([
  BuiltInToolNames.EditExistingFile,
  BuiltInToolNames.SingleFindAndReplace,
  BuiltInToolNames.MultiEdit,
]);

// Kiro-style guard: an edit tool may only touch a file that was READ earlier
// in the session (a successful read_file / read_file_range on the same file).
// Enforcing this makes the "Read File" phase a real, visible step in the chat
// before any edit card appears, and guarantees the model edits from fresh
// content instead of a guess. Edit impls throw a ContinueError so the error
// text is fed back to the model, which then calls read_file and retries.
//
// Relaxation: a successful edit on the same file earlier in the session counts
// as "already knows the content", so we don't force a redundant pre-read of a
// file the model just edited (avoids re-pulling large files into context).
export function assertFileWasRead(
  fileUri: string,
  extras: ClientToolExtras,
): void {
  const history = extras.getState()
    ? selectActiveSession(extras.getState()).history
    : [];
  const targetBasename = getUriPathBasename(fileUri).toLowerCase();
  const matchesFile = (call: { parsedArgs?: { filepath?: unknown } }) =>
    typeof call.parsedArgs?.filepath === "string" &&
    getUriPathBasename(call.parsedArgs.filepath).toLowerCase() ===
      targetBasename;

  const knownContent = history.some((item) =>
    item.toolCallStates?.some((call) => {
      const name = call.toolCall.function?.name ?? "";
      if (call.status !== "done") return false;
      const isRead = READ_TOOL_NAMES.has(name);
      const isEdit = EDIT_TOOL_NAMES.has(name);
      return (isRead || isEdit) && matchesFile(call);
    }),
  );
  if (!knownContent) {
    throw new ContinueError(
      ContinueErrorReason.Unspecified,
      `File not read: you must view a file before editing it. Call the read_file tool on ${fileUri} first, then retry this edit using the exact current content.`,
    );
  }
}
