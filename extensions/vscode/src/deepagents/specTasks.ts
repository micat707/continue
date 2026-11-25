import * as fs from "fs/promises";
import * as path from "path";

/**
 * Spec task orchestration library, mirroring Kiro's tasks.md parsing, TaskDAG,
 * and .meta.json persistence (verified from kiro.kiro-agent/dist/extension.js).
 */

export type SpecStatus =
  | "notStarted"
  | "queued"
  | "inProgress"
  | "completed"
  | "ready";

export type StoredStatus = Exclude<SpecStatus, "ready">;

export interface ParsedTask {
  id: string;
  text: string;
  status: StoredStatus;
  isOptional: boolean;
  indent: number;
  numericId: string | null;
  parentId: string | null;
  children: string[];
  startLine: number;
  endLine: number;
  dependencies: string[];
}

export interface TaskMetadata {
  pbtResults: Record<
    string,
    { status: string; failingExample?: string; lastRunTimestamp?: string }
  >;
  executionHistory: Record<
    string,
    Array<{ executionId: string; chatSessionId?: string; timestamp: string }>
  >;
  lastError?: Record<string, string>;
}

export interface SpecTaskFile {
  tasksFilePath: string;
  metaPath: string;
  content: string;
  lines: string[];
  tasks: ParsedTask[];
  metadata: TaskMetadata;
}

const CHECKBOX: Record<string, StoredStatus> = {
  " ": "notStarted",
  "~": "queued",
  "-": "inProgress",
  x: "completed",
  X: "completed",
};

const STATUS_CHAR: Record<StoredStatus, string> = {
  notStarted: " ",
  queued: "~",
  inProgress: "-",
  completed: "x",
};

export function metaPathFor(tasksFilePath: string): string {
  return tasksFilePath.replace(/\.md$/i, ".meta.json");
}

const NUMERIC_RE = /^\s*(\d+(?:\.\d+)*)\.\s+/;

/** Resolve a real or virtual path to a local file (shared with contextFiles). */
export function resolveSpecPath(
  input: string,
  toRealPath?: (p: string) => string,
): string {
  if (toRealPath) return toRealPath(input);
  const raw = input.trim().replace(/\\/g, "/");
  if (path.isAbsolute(raw)) return path.normalize(raw);
  return path.resolve(raw);
}

export async function loadTasksFile(
  tasksFilePath: string,
  toRealPath?: (p: string) => string,
): Promise<SpecTaskFile> {
  const real = resolveSpecPath(tasksFilePath, toRealPath);
  const content = await fs.readFile(real, "utf8");
  const lines = content.split(/\r?\n/);
  const tasks: ParsedTask[] = [];
  const numericStack: Array<{ depth: number; id: string }> = [];

  const LINE_RE = /^(\s*)([-*+])\s+\[([ xX~-])\](\\?\*?)\s+(.+)$/;
  for (let i = 0; i < lines.length; i++) {
    const m = LINE_RE.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].replace(/\t/g, "  ").length;
    const status = CHECKBOX[m[3]] ?? "notStarted";
    const isOptional = m[4].includes("*");
    const text = m[5].trim();
    const numeric = NUMERIC_RE.exec(text);
    const numericId = numeric ? numeric[1] : null;
    const id = numericId ?? text;

    while (
      numericStack.length &&
      numericStack[numericStack.length - 1].depth >= indent
    ) {
      numericStack.pop();
    }
    const parent = numericStack.length
      ? numericStack[numericStack.length - 1].id
      : null;
    if (numericId) numericStack.push({ depth: indent, id });

    tasks.push({
      id,
      text,
      status,
      isOptional,
      indent,
      numericId,
      parentId: parent,
      children: [],
      startLine: i,
      endLine: i,
      dependencies: [],
    });
  }

  for (const t of tasks) {
    if (t.parentId) {
      const p = tasks.find((x) => x.id === t.parentId);
      if (p) p.children.push(t.id);
    }
  }

  // Section boundaries: a task's content extends until the next task heading.
  const headingIdx = tasks.map((t) => t.startLine);
  for (let k = 0; k < tasks.length; k++) {
    const next = k + 1 < tasks.length ? headingIdx[k + 1] : lines.length;
    tasks[k].endLine = next;
  }

  parseDependencyGraph(lines, tasks);

  let metadata: TaskMetadata = { pbtResults: {}, executionHistory: {} };
  try {
    const raw = await fs.readFile(metaPathFor(real), "utf8");
    const parsed = JSON.parse(raw);
    metadata = {
      pbtResults: parsed.pbtResults ?? {},
      executionHistory: parsed.executionHistory ?? {},
      lastError: parsed.lastError,
    };
  } catch {
    // missing meta is normal
  }

  return {
    tasksFilePath: real,
    metaPath: metaPathFor(real),
    content,
    lines,
    tasks,
    metadata,
  };
}

/** Parse "## Task Dependency Graph" wave lines like `- [1.1, 1.2] -> [2.0]`. */
function parseDependencyGraph(lines: string[], tasks: ParsedTask[]): void {
  const heading = lines.findIndex((l) =>
    /^##\s+Task Dependency Graph/i.test(l),
  );
  if (heading < 0) return;
  for (let i = heading + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^##\s+/.test(l)) break;
    const arrow = l.indexOf("->");
    if (arrow < 0) continue;
    const left = l.slice(0, arrow);
    const right = l.slice(arrow + 2);
    const ids = (s: string) => s.match(/\d+(?:\.\d+)*/g) ?? [];
    // Format: "[task] -> [its dependencies]" (left task depends on right ids).
    const targets = ids(left);
    const deps = ids(right);
    for (const t of targets) {
      const task = tasks.find((x) => x.id === t || x.numericId === t);
      if (task) task.dependencies.push(...deps);
    }
  }
}

export class TaskDAG {
  constructor(public tasks: ParsedTask[]) {}

  byId(id: string): ParsedTask | undefined {
    return this.tasks.find((t) => t.id === id || t.numericId === id);
  }

  isLeaf(t: ParsedTask): boolean {
    return t.children.length === 0;
  }

  /** Kiro: notStarted/queued non-optional leaves whose deps are all completed. */
  getReadyTasks(): ParsedTask[] {
    const statusOf = (id: string): StoredStatus | undefined =>
      this.byId(id)?.status;
    return this.tasks.filter((t) => {
      if (t.isOptional) return false;
      if (t.status !== "notStarted" && t.status !== "queued") return false;
      if (!this.isLeaf(t)) return false;
      // Dependencies come only from the explicit "Task Dependency Graph"
      // section (Kiro's TaskDAG), never inferred from numeric parent ids —
      // a child task can be ready while its parent is still notStarted.
      return t.dependencies.every((d) => statusOf(d) === "completed");
    });
  }

  getNextReady(): ParsedTask | undefined {
    return this.getReadyTasks()[0];
  }

  /** Apply a status to a node and auto-complete parents when all children done. */
  updateNodeStatus(id: string, status: StoredStatus): void {
    const t = this.byId(id);
    if (!t) return;
    t.status = status;
    if (status === "completed") this.propagateParentCompletion(t);
  }

  private propagateParentCompletion(task: ParsedTask): void {
    let parentId = task.parentId;
    while (parentId) {
      const parent = this.byId(parentId);
      if (!parent) break;
      const allDone = parent.children.every((cid) => {
        const c = this.byId(cid);
        return !c || c.isOptional || c.status === "completed";
      });
      if (!allDone) break;
      parent.status = "completed";
      parentId = parent.parentId;
    }
  }
}

export interface TaskUpdateResult {
  ok: boolean;
  message: string;
  autoCompleted: string[];
}

/** Read tasks.md fresh, apply checkbox update under a simple lock, persist .meta.json. */
export async function updateTaskStatus(
  tasksFilePath: string,
  taskId: string,
  status: StoredStatus,
  options: { error?: string; toRealPath?: (p: string) => string } = {},
): Promise<TaskUpdateResult> {
  const file = await loadTasksFile(tasksFilePath, options.toRealPath);
  const dag = new TaskDAG(file.tasks);
  const task = dag.byId(taskId);
  if (!task) {
    return {
      ok: false,
      message: `Task "${taskId}" not found.`,
      autoCompleted: [],
    };
  }

  const beforeStatuses = new Map(file.tasks.map((t) => [t.id, t.status]));
  dag.updateNodeStatus(taskId, status);

  const changed = file.tasks.filter(
    (t) => beforeStatuses.get(t.id) !== t.status,
  );
  const lines = [...file.lines];
  for (const t of changed) {
    const line = lines[t.startLine];
    const m = /^(\s*[-*+]\s+\[)([ xX~-])(\])/.exec(line);
    if (m) {
      lines[t.startLine] = line.replace(
        /^(\s*[-*+]\s+\[)([ xX~-])(\])/,
        `$1${STATUS_CHAR[t.status]}$3`,
      );
    }
  }

  if (options.error) {
    file.metadata.lastError = file.metadata.lastError ?? {};
    file.metadata.lastError[taskId] = options.error;
  }
  if (status === "inProgress") {
    const hist = (file.metadata.executionHistory[taskId] ??= []);
    hist.push({
      executionId: `exec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    });
    if (hist.length > 10) hist.splice(0, hist.length - 10);
  }

  await fs.writeFile(file.tasksFilePath, lines.join("\n"), "utf8");
  await fs.writeFile(
    file.metaPath,
    JSON.stringify(file.metadata, null, 2),
    "utf8",
  );

  const autoCompleted = changed
    .filter(
      (t) =>
        beforeStatuses.get(t.id) !== "completed" && t.status === "completed",
    )
    .filter((t) => t.id !== taskId)
    .map((t) => t.id);

  return {
    ok: true,
    message:
      `Task "${taskId}" status updated to ${status}.` +
      (autoCompleted.length
        ? ` Auto-completed parents: ${autoCompleted.join(", ")}.`
        : ""),
    autoCompleted,
  };
}

/** Queue all not-started non-optional leaf tasks (status='queued', no taskId). */
export async function queueAllLeafTasks(
  tasksFilePath: string,
  toRealPath?: (p: string) => string,
): Promise<TaskUpdateResult> {
  const file = await loadTasksFile(tasksFilePath, toRealPath);
  const dag = new TaskDAG(file.tasks);
  const ready = dag.getReadyTasks().filter((t) => t.status === "notStarted");
  const lines = [...file.lines];
  for (const t of ready) {
    lines[t.startLine] = lines[t.startLine].replace(
      /^(\s*[-*+]\s+\[)([ xX~-])(\])/,
      "$1~$3",
    );
  }
  await fs.writeFile(file.tasksFilePath, lines.join("\n"), "utf8");
  return {
    ok: true,
    message: `Queued ${ready.length} task(s): ${ready.map((t) => t.id).join(", ") || "none"}.`,
    autoCompleted: [],
  };
}
