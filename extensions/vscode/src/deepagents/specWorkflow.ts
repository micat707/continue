import { z } from "zod";
import { tool } from "langchain";
import { createMiddleware, type AgentMiddleware } from "langchain";
import { SystemMessage } from "@langchain/core/messages";

/**
 * Spec workflow entry point — explicit tool-driven control plane.
 *
 * The DEFAULT chat path never runs any classifier. The model decides via the
 * ordinary tool-calling loop: `start_spec_workflow` enters generation mode,
 * `run_spec_tasks` switches to task-execution (orchestrator) mode. The
 * middleware below just reads the current mode to pick the system prompt and
 * tool whitelist — NO per-turn intent classification (which leaked the
 * classifier's reasoning into chat and cost an extra LLM call every turn).
 */

/** Which phase the session is in. One controller per chat session/runtime. */
export type SpecMode = "off" | "generation" | "execution";

export class SpecWorkflowController {
  private mode: SpecMode = "off";

  getMode(): SpecMode {
    return this.mode;
  }

  /** True once either spec tool has been called. */
  isActive(): boolean {
    return this.mode !== "off";
  }

  /** Enter generation mode (start_spec_workflow). */
  activate(): void {
    this.mode = "generation";
  }

  /** Enter task-execution mode (run_spec_tasks). */
  activateExecution(): void {
    this.mode = "execution";
  }

  reset(): void {
    this.mode = "off";
  }
}

/** Spec-only tools are hidden from the normal chat path (enabled after entry). */
const SPEC_ONLY_TOOLS = new Set(["taskList", "taskGet", "taskUpdate"]);

/**
 * Prompt used once the model has entered the spec workflow and the sub-intent
 * is specGeneration (i.e. not "run existing tasks"). It drives Kiro-style
 * clarify → requirements → design → tasks, asking the user to confirm each
 * ambiguous decision before writing documents.
 */
export const SPEC_GENERATION_PROMPT = `# Specification Workflow (generation phase)

You are in SPEC WORKFLOW. The user asked for a complex change that should be
specified before implementation.

## Implicit rules (always in force during this phase)
- Focus on creating a new spec file, or identifying an existing spec to update.
- If starting a NEW spec, FIRST present the entry-point choice to the user with
  \`user_input\`, then delegate the spec documents to the requirements-first
  sub-agent. Do NOT create any spec file before the user has chosen the entry
  point.
- Keep ALL clarifying questions together in ONE place — see §1. A scattered
  series of "one question per turn" cards is explicitly discouraged.

Follow this process strictly:

## 1. Clarify first — ONE \`user_input\` card, NON-CONFLICTING questions together
Before delegating, identify everything ambiguous or needing a user decision.
Put them in ONE \`user_input\` call using the \`questions\` array — the GUI
renders one scrollable card, each question with its own options and answer box;
the user answers in one go.

CRITICAL — mutually exclusive questions:
If some questions only make sense for CERTAIN answers of an earlier question
(e.g. "core features / target platforms" only for a new feature, but "what is
the bug" only for a bugfix), they are MUTUALLY EXCLUSIVE — do NOT put them in
the SAME card as independent questions. Instead:
  - Batch 1: ask ONLY the branching question (e.g. "Where should this spec
    start?"). One question in this card is fine when it is a branch point.
  - After the answer arrives, Batch 2: ask the 2-4 follow-up questions that
    apply to the chosen branch, all together in ONE card.
This is the ONLY case where two user_input cards are acceptable. Never split
compatible questions across turns, and never mix mutually-exclusive branches
into one card.

Call shape — ALWAYS use the \`questions\` array below, even if you think only
one thing is ambiguous; put every decision you can think of in it. NEVER use
the old single-question form (\`question\` + \`options\` only) — it causes
"ask one, answer, then ask another" which is forbidden:
\`\`\`json
{
  "question": "**Confirm the spec setup**",
  "questions": [
    {
      "question": "**Where should this spec start?**",
      "options": [
        { "title": "Start with Requirements", "description": "Business needs drive the design (recommended for a new feature)", "recommended": true },
        { "title": "Start with Design", "description": "Technical design is already decided" },
        { "title": "Fix a Bug", "description": "Bugfix spec workflow" }
      ]
    },
    {
      "question": "**Which core features?** (multi-select)",
      "multiple": true,
      "options": [
        { "title": "Screen sharing", "description": "Share desktop or a window" },
        { "title": "Remote desktop control", "description": "Control another participant's machine" },
        { "title": "Meeting recording", "description": "Record sessions to disk" }
      ]
    },
    {
      "question": "**Target platforms?**",
      "options": [
        { "title": "Windows + macOS + Linux", "recommended": true },
        { "title": "Windows only" },
        { "title": "macOS only" }
      ]
    }
  ]
}
\`\`\`
Put 2-4 MUTUALLY COMPATIBLE questions in the array — only decisions that are
genuinely ambiguous and can all be answered together. Do NOT force unrelated
or mutually-exclusive questions into the batch (see the CRITICAL rule above).
Even if the user already stated a preference, include it as a question with
that option marked \`recommended\` so the user can confirm. Every item MUST
have a \`question\` and 2-5 \`options\`. Set \`multiple: true\` for multi-select.
Use concise option titles with detail in \`description\`, mark a \`recommended\`
option. Options are shown with A/B/C labels. The old single-question form
(\`question\` + \`options\` only) is acceptable ONLY for a pure branch point as
described above.

- NEVER write clarifying questions as plain chat text, markdown \`- [ ]\`
  checkboxes, emoji checkmarks (✅), or Markdown tables — those are NOT
  interactive and the user cannot tick them.
- NEVER ask trivia one question per turn. One card with \`questions\` is the
  rule for all compatible questions. A SECOND card is allowed ONLY for
  follow-ups that cannot be predicted until the branching answer arrives.

Only after the single card is answered, summarise the decisions in one brief
sentence and continue. You may skip the card ONLY if the user EXPLICITLY said
"don't ask, just start / go ahead without questions"; otherwise you MUST ask
the batched card — deciding "only one thing is unclear" or "nothing is
unclear" is NOT a valid reason to split or skip.

## 2. Delegate document generation to the requirements-first sub-agent
Do NOT write the three documents yourself. Make ONE native tool call to
\`invoke_sub_agent\` with \`name='feature-requirements-first-workflow'\` and pass
the user's answers from §1 in the \`prompt\`. CRITICAL: issue the call through
the native tool-call channel — NEVER write tool calls as text/XML tags such as
\`<tool_call>\`, \`<variable_name>...\`, \`<function=NAME>\` or numbered variants
like \`invoke_sub_agent2\`; those are not executable and render as garbage.
Do NOT try to dispatch several sub-agents in parallel here — a SINGLE
\`invoke_sub_agent\` call generates all needed spec documents.
Set \`preset\` to the chosen phase: "requirements" for Start with Requirements,
"design" for Start with Design, or omit it to let the sub-agent continue with
the next missing document.

The sub-agent creates, under \`.kiro/specs/<feature-name>/\`:
- \`requirements.md\` — EARS-style acceptance criteria, one requirement per
  \`### Requirement\` with \`#### Acceptance Criteria\` (WHEN/THEN/SHALL).
- \`design.md\` — architecture and key decisions, with concrete file paths and
  rationale. Note any assumptions and alternatives considered.
- \`tasks.md\` — a numbered, dependency-aware task list. Each task is a
  checkbox \`- [ ] 1. ...\`; nest sub-tasks under their parent task. Tasks must
  be small, independently verifiable, and cover requirements + design.

You may use \`read_file\` / \`grep_search\` / \`file_search\` / \`list_directory\`
to gather context for the prompt. To validate a document the sub-agent wrote,
use \`validate_spec_format\`; do not hand-edit the documents.

## 3. Confirm before executing
After the sub-agent reports the documents, summarise them and ask the user to
confirm before any implementation begins. To start implementation, the user
will ask to run the tasks (e.g. "run all tasks") — you will then be switched to
the task execution orchestrator.

## Rules
- Do NOT write production code or run builds/tests in this phase. Your job is
  only to clarify (one card), delegate to the sub-agent, and report results.
- ALL spec document writing is done by the \`feature-requirements-first-workflow\`
  sub-agent via \`invoke_sub_agent\`. Do NOT write the .md files yourself.
- The \`taskList\` / \`taskGet\` / \`taskUpdate\` tools are available for reading
  and maintaining the task list.`;

export interface SpecWorkflowOptions {
  /** Prompt + tool whitelist used for "run existing tasks" (orchestrator). */
  orchestratorPrompt: string;
  orchestratorToolNames: string[];
}

/**
 * The control tool added to the NORMAL tool set. Calling it is the only way
 * into the spec workflow — no implicit classification on the default path.
 */
export function createStartSpecWorkflowTool(
  controller: SpecWorkflowController,
) {
  return tool(
    async (input: { reason: string }) => {
      controller.activate();
      return (
        "Spec workflow activated. " +
        (input.reason ? `Reason: ${input.reason}. ` : "") +
        "Ask any clarifying questions now, then write requirements.md, design.md and tasks.md, and wait for the user to confirm before implementation."
      );
    },
    {
      name: "start_spec_workflow",
      description:
        "Enter the specification workflow for a complex development request. " +
        "Call this ONLY when the task is substantial and would benefit from written requirements, design and a task breakdown, or when the steps are ambiguous and need user confirmation. " +
        "Do NOT call it for simple questions, small edits, or straightforward code changes — handle those directly with the normal tools. " +
        "After calling, ask clarifying questions, then produce requirements.md, design.md and tasks.md, and wait for the user to confirm before implementing.",
      schema: z.object({
        reason: z
          .string()
          .describe("One sentence on why this request needs a spec workflow."),
      }),
    },
  );
}

/**
 * The control tool that switches an already-active spec session into
 * task-execution (orchestrator) mode. Call it when the user asks to run the
 * tasks from an existing tasks.md (e.g. "run all tasks", "execute task 3").
 */
export function createRunSpecTasksTool(controller: SpecWorkflowController) {
  return tool(
    async () =>
      "Task execution mode activated. Read the spec's tasks.md and dispatch " +
      "tasks to subagents via the DAG task tools; do not implement code yourself.",
    {
      name: "run_spec_tasks",
      description:
        "Switch to task-execution (orchestrator) mode to RUN the implementation " +
        "tasks already listed in an existing spec's tasks.md. Call this ONLY when " +
        "the user explicitly asks to run/execute/continue existing tasks (e.g. " +
        "'run all tasks', 'execute task 3', 'start the next task'). Do NOT call it " +
        "to CREATE or generate a task list — that is spec generation, handled by " +
        "start_spec_workflow / the generation phase.",
      schema: z.object({}),
    },
  );
}

/**
 * Gate middleware. Reads the explicit mode set by the two control tools and
 * picks the matching system prompt / tool whitelist. NO per-turn classifier:
 * the tool call itself is the signal, so no extra LLM call or reasoning leak.
 */
export function createSpecWorkflowMiddleware(
  controller: SpecWorkflowController,
  options: SpecWorkflowOptions,
): AgentMiddleware {
  const orchestratorAllowed = new Set(options.orchestratorToolNames);

  const wrapModelCallInner = async (request: any, handler: any) => {
    const mode = controller.getMode();

    // Normal chat path: hide spec-only tools so the model sees plain chat tools.
    if (mode === "off") {
      if (!Array.isArray(request?.tools)) return handler(request);
      const next: any = {
        ...request,
        tools: request.tools.filter(
          (t: any) =>
            typeof t?.name !== "string" || !SPEC_ONLY_TOOLS.has(t.name),
        ),
      };
      return handler(next);
    }

    // Explicit task-execution mode → orchestrator prompt + narrowed tool set.
    if (mode === "execution") {
      const next: any = {
        ...request,
        systemMessage: new SystemMessage({
          content: options.orchestratorPrompt,
        }),
      };
      if (Array.isArray(request?.tools)) {
        next.tools = request.tools.filter(
          (t: any) =>
            typeof t?.name === "string" && orchestratorAllowed.has(t.name),
        );
      }
      return handler(next);
    }

    // Generation mode: full tool set (including task tools) + spec prompt.
    const next: any = {
      ...request,
      systemMessage: new SystemMessage({ content: SPEC_GENERATION_PROMPT }),
    };
    return handler(next);
  };

  return createMiddleware({
    name: "SpecWorkflowMiddleware",
    async wrapModelCall(request: any, handler: any) {
      try {
        return await wrapModelCallInner(request, handler);
      } catch (e: any) {
        console.error(
          "[SpecWorkflow] wrapModelCall ERROR:",
          e?.message,
          "\nSTACK:",
          e?.stack,
          "\ntools:",
          Array.isArray(request?.tools)
            ? `array(${request.tools.length})`
            : typeof request?.tools,
        );
        throw e;
      }
    },
  });
}
