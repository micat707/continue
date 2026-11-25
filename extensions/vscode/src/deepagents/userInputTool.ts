/**
 * `user_input` tool — Kiro-aligned interactive user input.
 *
 * Model-facing name / description / schema are verbatim from Kiro's
 * `extension.js` (jFr definition, ~line 14557). The executor does NOT answer
 * the question itself: it asks the GUI (via the shared HITL protocol bridge) to
 * render the question inline in the chat and suspends until the user replies.
 *
 * Flow:
 *   1. Model calls `user_input` with { question, options?, reason?, metadata? }.
 *   2. `requestUserInput()` posts a `userInputRequested` message carrying a
 *      requestId + parsed options, and registers a pending promise.
 *   3. GUI renders an inline QuestionCard in the tool-call row; the user picks
 *      an option (and optional sub-options), types a free-form answer, or skips.
 *   4. GUI posts `userInputResponse` with the same requestId; the bridge
 *      resolves the promise; the tool returns Kiro's answer format.
 */

import { z } from "zod";
import { randomUUID } from "crypto";
import type { VsCodeWebviewProtocol } from "../webviewProtocol";

// ---- Model-facing schema (verbatim field names/descriptions from Kiro) ----

const subOptionSchema = z
  .object({
    title: z.string().describe("The display title for this sub-option"),
    description: z
      .string()
      .describe("Optional description of this sub-option")
      .optional(),
  })
  .describe("Nested toggle options shown when this option is selected");

const optionObjectSchema = z.object({
  title: z.string().describe("The display title for this option"),
  description: z
    .string()
    .describe("Optional detailed description of this option")
    .optional(),
  recommended: z
    .boolean()
    .describe("Whether this option is recommended")
    .optional(),
  subOptions: z
    .array(subOptionSchema)
    .describe("Nested toggle options shown when this option is selected")
    .optional(),
  subOptionsLabel: z
    .string()
    .describe("Label for the sub-options section")
    .optional(),
});

export const USER_INPUT_DESCRIPTION = [
  "This tool allows you to get input from the user. You should use this tool if you are stuck and need user input to move forward, or if you want to get more details in addition to the user's request.",
  "  The user has a free text box that they are able to reply to your questions in.",
  "",
  "    * Tool Behavior:*",
  "- This tool enables interactive user input collection during execution",
  "- Use this tool when additional information is needed to proceed with a task",
  "- The user will be forced to answer or skip the question to proceed",
  "- If the user is ready to move on to the next phase, consider them to have answered your previous question in the affirmative and proceed",
  "    ",
  "    * Question Formatting:*",
  "- Format your questions using markdown bold syntax (**question text**) to make them stand out to the user",
  "- This helps users quickly identify what you're asking them",
  "    ",
  "    * Options Support:*",
  "- You can optionally provide predefined choices using the 'options' parameter",
  "- Users will see these as selectable options but can also provide free text responses",
  "- Use options when you want to guide the user toward specific choices while still allowing flexibility",
  "    ",
  "    * Sub-Options Support:*",
  "- Options can have nested 'subOptions' that appear as toggles when the parent option is selected",
  "- Use subOptions to collect additional preferences when a specific option is chosen",
  '- The response will include selected sub-options in brackets, e.g., "Option [SubOption1, SubOption2]"',
].join("\n");

export const userInputSchema = z.object({
  question: z
    .string()
    .describe(
      "Describe the question you would like to ask the user. This question will be presented to the user when you use this tool. Format questions in bold using markdown syntax (**question text**) to make them stand out.",
    ),
  options: z
    .array(z.union([z.string(), optionObjectSchema]))
    .min(1, "At least one option is required — the UI needs choices to render")
    .describe(
      "REQUIRED: 2-5 predefined choices for the user to select from. Can be simple strings or objects with title, description, recommended, and subOptions fields. You MUST provide options for every question — including a sensible default plus 'Other (type below)' or 'Skip questions' for open-ended ones. A call without options cannot be rendered as an interactive card.",
    ),
  reason: z
    .enum(["general-question"])
    .describe("The reason the user is being asked for input")
    .optional(),
  metadata: z
    .object({
      featureName: z
        .string()
        .nullish()
        .describe(
          'The feature name in kebab-case format (e.g., "user-authentication")',
        ),
    })
    .describe("Optional metadata for specific question types")
    .optional(),
});

export type UserInputAnswer = {
  /** Selected option title (or free-form text). */
  answer: string;
  /** Sub-option titles selected under the chosen option. */
  subOptions?: string[];
  /** True when the user clicked Skip instead of answering. */
  skipped?: boolean;
};

// ---- Bridge: pending requests keyed by requestId ----

type Pending = {
  resolve: (a: UserInputAnswer) => void;
  reject: (e: Error) => void;
};
const pending = new Map<string, Pending>();
let protocol: VsCodeWebviewProtocol | null = null;

/**
 * Mirrors Kiro's "next-phase" fallback: if the question can never reach the
 * user (no webview or send failure), advance the agent instead of leaving the
 * run stalled forever. formatUserInputResult maps `skipped` to Kiro's exact
 * "User is ready to move on to the next phase" text.
 */
const NEXT_PHASE_ANSWER: UserInputAnswer = {
  answer: "",
  subOptions: [],
  skipped: true,
};

/** Settle a pending question exactly once. */
function settlePending(
  requestId: string,
  outcome: { resolve: UserInputAnswer } | { reject: Error },
): void {
  const p = pending.get(requestId);
  if (!p) return;
  pending.delete(requestId);
  if ("resolve" in outcome) p.resolve(outcome.resolve);
  else p.reject(outcome.reject);
}

export function setUserInputProtocol(p: VsCodeWebviewProtocol): void {
  protocol = p;
}

/** Ask the GUI to render the question inline and wait for the user's answer. */
export function requestUserInput(
  input: z.infer<typeof userInputSchema>,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<UserInputAnswer> {
  // Reject option-less calls BEFORE creating the pending promise (which would
  // otherwise hang forever). The thrown error flows back to the agent as a
  // ToolMessage, so the model can retry with concrete options — far better
  // than shipping generic "Other/Skip" choices that don't match the question.
  if (!input.options?.length) {
    throw new Error(
      "user_input was called WITHOUT the required 'options' array. " +
        "Call user_input AGAIN and pass 2-5 concrete options that fit the " +
        "question (e.g. the actual feature/framework choices), each with a " +
        "short title and a description. The interactive card cannot render " +
        "choices otherwise.",
    );
  }

  const requestId = randomUUID();
  const promise = new Promise<UserInputAnswer>((resolve, reject) => {
    pending.set(requestId, { resolve, reject });
    if (signal) {
      const onAbort = () => {
        if (!pending.has(requestId)) return;
        settlePending(requestId, {
          reject: new Error("chat turn aborted while waiting for user input"),
        });
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });

  const normalizedOptions = input.options.map((o) =>
    typeof o === "string"
      ? { title: o }
      : {
          title: o.title,
          description: o.description,
          recommended: o.recommended,
          subOptions: o.subOptions,
          subOptionsLabel: o.subOptionsLabel,
        },
  );

  if (!protocol) {
    console.warn(
      "[userInputTool] !! no webview protocol — auto-advancing | requestId=" +
        requestId,
    );
    settlePending(requestId, { resolve: NEXT_PHASE_ANSWER });
    return promise;
  }

  console.log(
    "[userInputTool] >>> question sent to GUI | requestId=" + requestId,
    input.question.slice(0, 200),
  );
  void protocol
    .request("userInputRequested", {
      requestId,
      sessionId,
      question: input.question,
      options: normalizedOptions,
      reason: input.reason,
    })
    .catch((e) => {
      const err = e instanceof Error ? e : new Error(String(e));
      // Do NOT settle pending here. The inline card registers its
      // `userInputRequested` listener in useEffect — one frame AFTER the
      // streamed toolCall chunk mounts it — so `respond` can legitimately be
      // absent even though the card is rendered and the user will answer via
      // `userInputResponse`. Settling here would clear the real pending
      // request and make that answer look "unknown/stale".
      console.warn(
        "[userInputTool] userInputRequested had no responder |",
        err.message,
      );
    });
  return promise;
}

/** Resolve a pending question (called from VsCodeMessenger on GUI response). */
export function resolveUserInput(
  requestId: string,
  answer: UserInputAnswer,
  _sessionId?: string,
): void {
  let id = requestId;
  if (!pending.has(id)) {
    // When the event/useEffect race is lost, the inline card falls back to the
    // synthetic "pending" requestId. A user_input tool is awaited one at a
    // time, so the sole pending question is unambiguous — settle it rather
    // than leaving the agent blocked forever.
    if (pending.size === 1) {
      id = [...pending.keys()][0];
      console.warn(
        `[userInputTool] requestId '${requestId}' unknown; using sole pending '${id}'`,
      );
    } else {
      console.warn(
        "[userInputTool] !! answer for unknown/stale requestId",
        requestId,
      );
      return;
    }
  }
  console.log("[userInputTool] <<< answer from GUI |", JSON.stringify(answer));
  settlePending(id, { resolve: answer });
}

/** Abort all pending questions (e.g. user pressed Stop). */
export function cancelUserInput(reason: string, sessionId?: string): void {
  // When sessionId is provided callers pass it only for filtering at a higher
  // level; here cancel all pending to avoid dangling tool calls.
  for (const requestId of [...pending.keys()]) {
    settlePending(requestId, { reject: new Error(reason) });
  }
}

/** Format Kiro's tool result text from the user's answer. */
export function formatUserInputResult(
  input: z.infer<typeof userInputSchema>,
  answer: UserInputAnswer,
): string {
  if (answer.skipped) {
    return "Question ID: 0\nResponse: User is ready to move on to the next phase";
  }
  let response = answer.answer;
  if (answer.subOptions && answer.subOptions.length > 0) {
    response += ` [${answer.subOptions.join(", ")}]`;
  }
  return `Question ID: 0\nResponse: ${response}`;
}
