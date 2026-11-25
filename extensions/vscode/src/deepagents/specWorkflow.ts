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
specified before implementation. Follow this process strictly:

## 1. Clarify first — ALWAYS call the \`user_input\` tool
Before writing any document, identify requirements that are ambiguous or
require a user decision (scope, tech choices, UI behaviour, edge cases).

You MUST ask EVERY clarifying question by CALLING the \`user_input\` tool.
The GUI renders that tool as an interactive card with selectable options,
sub-options and a free-text box. It is the ONLY way the user can answer you
during this phase: the user will be forced to answer or skip the question to
proceed, and the answer comes back INSIDE the tool result.

DO NOT proceed to the next topic or write any document until the user's answer
comes back. NEVER write clarifying questions as plain chat text, markdown
\`- [ ]\` checkboxes, emoji checkmarks (✅), or Markdown tables — those are NOT
interactive and the user cannot tick them.

Call \`user_input\` ONCE PER TOPIC (e.g. one call for core features, one for the
desktop framework, one for the media SDK, one for target platforms). For each
call:
- Format \`question\` in markdown bold (**...**) so it stands out.
- You MUST always pass 2-5 choices in the \`options\` array for every clarifying
  question. NEVER omit \`options\`: a call without options renders an empty card
  with no selectable choices and the user cannot answer efficiently. Even for
  open questions, offer options such as sensible defaults plus "Other".
- Use **concise options only** — put longer explanations in the option's
  \`description\` field, not the title.
- Mark one option as \`recommended\` based on your analysis.
- Use \`subOptions\` when several toggles can be picked under one choice.

Example of a correct call:

\`\`\`json
{
  "question": "**Which desktop framework should we use?**",
  "options": [
    { "title": "Electron", "description": "JS/TS, fast to build, larger bundle", "recommended": true },
    { "title": "Tauri", "description": "Rust backend, small bundle, better performance" }
  ]
}
\`\`\`

Only after the tool answers have resolved all ambiguities, summarise them
briefly and move on to generating the documents. If nothing is ambiguous,
state that briefly and continue without calling the tool.

## 2. Generate the spec documents
Write three documents under the spec's directory (the user will tell you the
feature name; default to \`.kiro/specs/<feature-name>/\`):

- \`requirements.md\` — EARS-style acceptance criteria, one requirement per
  \`### Requirement\` with \`#### Acceptance Criteria\` (WHEN/THEN/SHALL).
- \`design.md\` — architecture and key decisions, with concrete file paths and
  rationale. Note any assumptions and alternatives considered.
- \`tasks.md\` — a numbered, dependency-aware task list. Each task is a
  checkbox \`- [ ] 1. ...\`; nest sub-tasks under their parent task. Tasks must
  be small, independently verifiable, and cover requirements + design.

## 3. Confirm before executing
After writing the documents, summarise them and ask the user to confirm before
any implementation begins. To start implementation, the user will ask to run
the tasks (e.g. "run all tasks") — you will then be switched to the task
execution orchestrator.

## Rules
- Do NOT write production code or run builds/tests in this phase. Your job is
  only to clarify and to produce the three spec documents.
- Use the filesystem tools to create the documents. Use \`read_file\` /
  \`grep_search\` / \`file_search\` / \`list_directory\` to ground the spec in the
  real codebase.
- The \`taskList\` / \`taskGet\` / \`taskUpdate\` tools are available for reading
  and maintaining the task list you generated.`;

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
