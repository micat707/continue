import { z } from "zod";
import { tool } from "langchain";
import {
  loadTasksFile,
  queueAllLeafTasks,
  TaskDAG,
  updateTaskStatus,
  type StoredStatus,
} from "./specTasks";

/**
 * Spec orchestration tools. Descriptions + parameter descriptions are verbatim
 * from Kiro's tool constants (extension.js @8199844 / @8201665 / @8203137).
 */

type ToRealPath = (p: string) => string;

let activeToRealPath: ToRealPath | undefined;
export function setSpecPathResolver(resolver: ToRealPath | undefined): void {
  activeToRealPath = resolver;
}

/**
 * Build the resolver injected into `invoke_sub_agent` for `specTask`.
 * Mirrors Kiro's `woe`/`f1i`: gather the task's own content, children, and the
 * spec's requirements/design/tasks files so the sub-agent starts grounded.
 */
export function createSpecTaskResolver(toRealPath?: ToRealPath) {
  return async (taskId: string, tasksFilePath: string): Promise<string> => {
    const file = await loadTasksFile(
      tasksFilePath,
      toRealPath ?? activeToRealPath,
    );
    const dag = new TaskDAG(file.tasks);
    const t = dag.byId(taskId);
    if (!t) throw new Error(`Task "${taskId}" not found in ${tasksFilePath}`);

    const parts: string[] = [];
    parts.push(
      `Task ID: ${t.id}\nTask: ${t.text}\nStatus: ${t.status}\nOptional: ${t.isOptional}`,
    );
    const contentLines = file.lines
      .slice(t.startLine, t.endLine)
      .join("\n")
      .trim();
    if (contentLines) parts.push(`Task details:\n${contentLines}`);
    if (t.children.length) {
      const childText = t.children
        .map((cid) => {
          const c = dag.byId(cid);
          return c ? `- ${c.id}: ${c.text} (${c.status})` : `- ${cid}`;
        })
        .join("\n");
      parts.push(`Child tasks:\n${childText}`);
    }
    if (t.dependencies.length) {
      parts.push(`Depends on: ${t.dependencies.join(", ")}`);
    }

    // Spec documents live alongside tasks.md (requirements.md / design.md).
    const dir = file.tasksFilePath.replace(/[^\\/]+$/, "");
    const fs = await import("fs/promises");
    for (const name of ["requirements.md", "design.md"]) {
      try {
        const text = await fs.readFile(dir + name, "utf8");
        parts.push(`--- ${name} ---\n${text.slice(0, 20000)}`);
      } catch {
        // optional
      }
    }
    return parts.join("\n\n");
  };
}

const STATUS_VALUES = [
  "notStarted",
  "queued",
  "inProgress",
  "completed",
] as const;

const TASKS_PATH_DESC = "Absolute path to tasks.md.";

export function createSpecTools() {
  const taskListTool = tool(
    async (input: { tasksFilePath: string; status?: string | null }) => {
      try {
        const file = await loadTasksFile(input.tasksFilePath, activeToRealPath);
        const dag = new TaskDAG(file.tasks);
        if (!input.status) {
          const total = file.tasks.length;
          const completed = file.tasks.filter(
            (t) => t.status === "completed",
          ).length;
          const summary = {
            summary: {
              total,
              completed,
              remaining: total - completed,
              ready: dag.getReadyTasks().length,
            },
          };
          return JSON.stringify(summary, null, 2);
        }
        const list =
          input.status === "ready"
            ? dag.getReadyTasks()
            : file.tasks.filter((t) => t.status === input.status);
        return JSON.stringify(
          {
            tasks: list.map((t) => ({
              id: t.id,
              text: t.text,
              status: t.status,
              isOptional: t.isOptional,
              lastError: file.metadata.lastError?.[t.id],
            })),
          },
          null,
          2,
        );
      } catch (e) {
        return `Failed to load tasks: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: "taskList",
      description: `List tasks with optional status filtering.

Reads tasks.md and .meta.json on each call to reflect the latest state.

When called with status='ready', returns the next task whose dependencies are satisfied.
When called with a concrete status, returns all tasks matching that status.
When called with no filters, returns a summary of task counts.`,
      schema: z.object({
        tasksFilePath: z.string().describe(TASKS_PATH_DESC),
        status: z
          .enum([...STATUS_VALUES, "ready"])
          .nullish()
          .describe(
            'Filter tasks by status. Use "ready" to get the next dispatchable task.',
          ),
      }),
    },
  );

  const taskGetTool = tool(
    async (input: { tasksFilePath: string; taskId: string }) => {
      try {
        const file = await loadTasksFile(input.tasksFilePath, activeToRealPath);
        const dag = new TaskDAG(file.tasks);
        const t = dag.byId(input.taskId);
        if (!t) return `Task "${input.taskId}" not found`;
        return JSON.stringify(
          {
            id: t.id,
            text: t.text,
            status: t.status,
            isOptional: t.isOptional,
            children: t.children,
            metadata: {
              executionHistory: file.metadata.executionHistory[t.id] ?? [],
              pbtResult: file.metadata.pbtResults[t.id] ?? null,
              lastError: file.metadata.lastError?.[t.id],
            },
          },
          null,
          2,
        );
      } catch (e) {
        return `Failed to load tasks: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: "taskGet",
      description: `Get detailed information about a specific task including execution history,
PBT results, and dependency chain. Use this to inspect failed tasks
before deciding on recovery actions.`,
      schema: z.object({
        tasksFilePath: z.string().describe(TASKS_PATH_DESC),
        taskId: z.string().describe("The ID of the task to inspect."),
      }),
    },
  );

  const taskUpdateTool = tool(
    async (input: {
      tasksFilePath: string;
      taskId?: string | null;
      status: string;
      error?: string | null;
    }) => {
      if (!input.taskId) {
        if (input.status !== "queued") {
          return 'taskId is required unless status is "queued".';
        }
        try {
          return await queueAllLeafTasks(input.tasksFilePath, activeToRealPath);
        } catch (e) {
          return `Failed to load tasks: ${e instanceof Error ? e.message : String(e)}`;
        }
      }
      try {
        const result = await updateTaskStatus(
          input.tasksFilePath,
          input.taskId,
          input.status as StoredStatus,
          { error: input.error ?? undefined, toRealPath: activeToRealPath },
        );
        return result.ok ? result.message : result.message;
      } catch (e) {
        return `Failed to load tasks: ${e instanceof Error ? e.message : String(e)}`;
      }
    },
    {
      name: "taskUpdate",
      description: `Update a task's status with automatic side effects.

Reads tasks.md, applies the update, and persists the change.
Completing all children of a parent task auto-completes the parent.
Runs pre/post task execution hooks on in_progress/completed transitions.

When status is "queued" and no taskId is provided, queues all not-started non-optional leaf tasks.`,
      schema: z.object({
        tasksFilePath: z.string().describe(TASKS_PATH_DESC),
        taskId: z
          .string()
          .nullish()
          .describe(
            "The ID of the task to update. Omit to queue all eligible tasks.",
          ),
        status: z.enum(STATUS_VALUES).describe("The new status for the task."),
        error: z
          .string()
          .nullish()
          .describe("Error message if the task failed."),
      }),
    },
  );

  return [taskListTool, taskGetTool, taskUpdateTool];
}
