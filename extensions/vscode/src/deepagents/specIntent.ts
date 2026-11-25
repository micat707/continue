import { createMiddleware, type AgentMiddleware } from "langchain";
import {
  AIMessage,
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from "@langchain/core/messages";

/**
 * Spec sub-intent detection, ported from Kiro's `tFr` / `eFr`
 * (extension.js @5935372 / @5951412). Decides whether the last human message
 * asks to EXECUTE existing spec tasks (taskExecution → orchestrator mode) or
 * is spec generation / anything else (specGeneration → normal action).
 */

export type SpecSubIntent = "taskExecution" | "specGeneration";

export interface IntentWeights {
  specGeneration: number;
  taskExecution: number;
}

/** Kiro's T$u (extension.js @5948449) — regexes that mean "run existing tasks". */
const TASK_EXECUTION_PATTERNS: RegExp[] = [
  /\brun\s+all\s+tasks?\b/i,
  /\bexecute\s+(?:all\s+)?tasks?\b/i,
  /\bexecute\s+task\s+\d/i,
  /\bexecute\s+the\s+following\s+task\b/i,
  /\brun\s+task\s+\d/i,
  /\bstart\s+task\s+\d/i,
  /\bnext\s+task\b/i,
  /\bcontinue\s+(?:running\s+)?tasks?\b/i,
  /\bresume\s+tasks?\b/i,
  /\bstart\s+the\s+next\s+task\b/i,
];

/** Kiro's XMi confidence threshold (extension.js @5951412). */
const CONFIDENCE_THRESHOLD = 0.7;

/** Kiro's x$u LLM classifier system prompt (extension.js @5948740). */
const CLASSIFIER_SYSTEM_PROMPT = `You are a sub-intent classifier for a specification agent.

Your job is to classify the user's message into one of two categories:

1. **specGeneration** — The user wants to create, edit, or discuss specifications, requirements, or design documents, OR reports a bug / asks to fix something (a bug report begins a bugfix spec).
2. **taskExecution** — The user wants to execute, run, or continue ALREADY EXISTING implementation tasks from a spec's tasks.md.

Return ONLY a JSON object with 2 properties (specGeneration, taskExecution) representing your confidence in each category. The values must sum to 1.

### Category Definitions

#### specGeneration (DEFAULT)
- Creating, generating, or editing spec documents (requirements, design, or task lists)
- Discussing features, architecture, or planning
- Asking to "create tasks", "generate the tasks", or "write the task list" for a feature — this means generating the tasks.md spec document, NOT executing tasks
- Any request that is NOT about running/executing implementation tasks
- Examples:
  - "Add a login page to the spec"
  - "Update the requirements for the API"
  - "Let's design the database schema"
  - "What should the user flow look like?"
  - "Create the tasks for user-authentication"
  - "Generate the task list for my-feature"
  - "Write the tasks for task-management-api"
  - "There's a bug: the login page crashes when the password is empty. Help me fix it."
  - "The export button produces an empty CSV. Fix it."
  - "Pagination returns duplicate rows. This is broken."

#### taskExecution
- Explicitly asking to run, execute, start, or continue ALREADY EXISTING tasks
- Referencing specific task numbers or asking for the next task
- Resuming previously started task execution
- Examples:
  - "Run all tasks"
  - "Execute task 3"
  - "Start the next task"
  - "Continue running the tasks"
  - "Resume task execution"

IMPORTANT: When in doubt, classify as specGeneration. Only classify as taskExecution when the user is explicitly requesting to run or execute implementation tasks. "Create/generate tasks" means generating a task list document and is specGeneration.

Ensure you look at the historical conversation between you and the user in addition to the latest user message when making your decision.
Previous messages may have context that is important to consider when combined with the user's latest reply.

IMPORTANT: Respond ONLY with a raw JSON object. No explanation, no commentary, no markdown formatting, no code fences.

Example response:
{"specGeneration": 0.1, "taskExecution": 0.9}

Classify the FINAL user message in the conversation.`;

/** Kiro eFr.localClassification: regex hit → taskExecution .9, else specGeneration .9. */
export function detectLocalIntent(text: string): IntentWeights {
  for (const re of TASK_EXECUTION_PATTERNS) {
    if (re.test(text)) return { specGeneration: 0.1, taskExecution: 0.9 };
  }
  return { specGeneration: 0.9, taskExecution: 0.1 };
}

export function classifyFromWeights(w: IntentWeights): SpecSubIntent {
  return w.taskExecution > w.specGeneration
    ? "taskExecution"
    : "specGeneration";
}

function normalize(w: IntentWeights): IntentWeights {
  const total = w.specGeneration + w.taskExecution;
  if (total === 0) return { specGeneration: 0.5, taskExecution: 0.5 };
  return {
    specGeneration: Number((w.specGeneration / total).toPrecision(2)),
    taskExecution: Number((w.taskExecution / total).toPrecision(2)),
  };
}

/**
 * Kiro eFr.finalizeIntent (extension.js @5953584):
 * - if LLM confidence >= 0.7 for either class → trust LLM;
 * - otherwise average local + LLM weights.
 */
export function finalizeIntent(
  local: IntentWeights,
  llm: IntentWeights | undefined,
): { weights: IntentWeights; classification: SpecSubIntent; source: string } {
  if (!llm) {
    return {
      weights: local,
      classification: classifyFromWeights(local),
      source: "localFallback",
    };
  }
  if (
    llm.taskExecution >= CONFIDENCE_THRESHOLD ||
    llm.specGeneration >= CONFIDENCE_THRESHOLD
  ) {
    return {
      weights: llm,
      classification: classifyFromWeights(llm),
      source: "llmConfident",
    };
  }
  const combined = normalize({
    specGeneration: (local.specGeneration + llm.specGeneration) / 2,
    taskExecution: (local.taskExecution + llm.taskExecution) / 2,
  });
  return {
    weights: combined,
    classification: classifyFromWeights(combined),
    source: "combined",
  };
}

/** Extract text of the last human message (Kiro tFr). */
export function lastHumanText(messages: BaseMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.getType() === "human" || m instanceof HumanMessage) {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) {
        return c
          .filter(
            (p): p is { type: string; text?: string } =>
              typeof p === "object" && p !== null && (p as any).type === "text",
          )
          .map((p) => p.text ?? "")
          .join(" ");
      }
    }
  }
  return "";
}

function parseWeights(content: unknown): IntentWeights | undefined {
  if (typeof content !== "string") return undefined;
  let raw = content
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, "")
    .replace(/\n?```\s*$/i, "")
    .trim();
  try {
    const obj = JSON.parse(raw);
    if (
      typeof obj?.specGeneration === "number" &&
      typeof obj?.taskExecution === "number"
    ) {
      return normalize({
        specGeneration: obj.specGeneration,
        taskExecution: obj.taskExecution,
      });
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function detectLLMIntent(
  model: any,
  messages: BaseMessage[],
  signal?: AbortSignal,
): Promise<IntentWeights | undefined> {
  try {
    // Kiro builds: [classifier system, "I will follow", ...history, <final user msg>]
    // We keep the final message out of history duplication by using all but the
    // last, then appending the final as its own human message (tFr behaviour).
    const history = messages.slice(0, -1);
    const last = messages[messages.length - 1];
    const convo: BaseMessage[] = [
      new SystemMessage({ content: CLASSIFIER_SYSTEM_PROMPT }),
      new AIMessage({ content: "I will follow these instructions." }),
      ...history,
    ];
    if (last) convo.push(last);
    const response = await model.invoke(convo, signal ? { signal } : undefined);
    return parseWeights(response?.content);
  } catch {
    return undefined;
  }
}

export interface SpecIntentOptions {
  /** Orchestrator prompt injected when taskExecution is detected. */
  orchestratorPrompt: string;
  /** Tool names allowed in orchestrator mode (others are hidden that turn). */
  orchestratorToolNames?: string[];
  /** Force a classification (e.g. specTask param short-circuit → taskExecution). */
  forceIntent?: SpecSubIntent;
}

/**
 * Middleware mirroring Kiro's IntentDetectionNode → conditional edge:
 * classify once per invocation, then in wrapModelCall switch the system prompt
 * and narrow tools when the intent is taskExecution.
 */
export function createSpecIntentMiddleware(
  options: SpecIntentOptions,
): AgentMiddleware {
  const allowed = options.orchestratorToolNames
    ? new Set(options.orchestratorToolNames)
    : undefined;

  return createMiddleware({
    name: "SpecIntentMiddleware",
    async wrapModelCall(request: any, handler: any) {
      // Classify here (not beforeAgent) because Kiro's classifier needs the
      // fast model client; wrapModelCall is the only hook that exposes model.
      let intent: SpecSubIntent;
      if (options.forceIntent) {
        intent = options.forceIntent;
      } else {
        const messages: BaseMessage[] =
          request?.messages ?? request?.state?.messages ?? [];
        const local = detectLocalIntent(lastHumanText(messages));
        let llm: IntentWeights | undefined;
        try {
          llm = await detectLLMIntent(request.model, messages, request.signal);
        } catch {
          llm = undefined;
        }
        intent = finalizeIntent(local, llm).classification;
      }

      if (intent !== "taskExecution") return handler(request);

      const orchestratorSystemMessage = new SystemMessage({
        content: options.orchestratorPrompt,
      });
      const next: any = {
        ...request,
        systemMessage: orchestratorSystemMessage,
      };
      if (allowed) {
        next.tools = request.tools?.filter(
          (t: any) => typeof t?.name === "string" && allowed.has(t.name),
        );
      }
      return handler(next);
    },
  });
}

/**
 * Classify using the current model (Kiro uses a separate fast model via
 * getFastModelClient("intent-classification"); we reuse request.model since
 * no separate fast-model API exists in this editor). Exposed for tests.
 */
export async function classifySpecIntent(
  model: any,
  messages: BaseMessage[],
  forceIntent?: SpecSubIntent,
): Promise<{ classification: SpecSubIntent; source: string }> {
  if (forceIntent) return { classification: forceIntent, source: "forced" };
  const text = lastHumanText(messages);
  const local = detectLocalIntent(text);
  let llm: IntentWeights | undefined;
  try {
    llm = await detectLLMIntent(model, messages);
  } catch {
    llm = undefined;
  }
  const result = finalizeIntent(local, llm);
  return { classification: result.classification, source: result.source };
}
