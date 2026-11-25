const esbuild = require("esbuild");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EXT_ROOT = path.resolve(__dirname, "..");
const SRC = path.resolve(EXT_ROOT, "src/deepagents/specTasks.ts");
const OUT = path.join(os.tmpdir(), `spec-tasks-test-${process.pid}.cjs`);

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; console.log("  PASS " + label); }
  else { fail++; console.log("  FAIL " + label); }
};

(async () => {
  await esbuild.build({
    entryPoints: [SRC], bundle: true, platform: "node", format: "cjs",
    outfile: OUT, logLevel: "error",
  });
  const m = require(OUT);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spec-fixture-"));
  const tasksPath = path.join(dir, "tasks.md");
  const fixture = [
    "# Implementation Plan",
    "",
    "## 1. Setup",
    "",
    "- [ ] 1.0. Initialize project",
    "  - [ ] 1.1. Create files",
    "  - [x] 1.2. Setup config",
    "- [ ] 2.0. Implement feature",
    "- [ ]* 3.0. Optional polish",
    "",
    "## Task Dependency Graph",
    "",
    "- [2.0] -> [1.0]",
    "",
  ].join("\n");
  fs.writeFileSync(tasksPath, fixture, "utf8");

  const file = await m.loadTasksFile(tasksPath);
  ok(file.tasks.length === 5, `parsed 5 tasks (got ${file.tasks.length})`);
  const t11 = file.tasks.find((t) => t.id === "1.1");
  ok(t11 && t11.status === "notStarted" && t11.indent > 0, "1.1 parsed notStarted with indent");
  const t12 = file.tasks.find((t) => t.id === "1.2");
  ok(t12 && t12.status === "completed", "1.2 parsed completed");
  const t3 = file.tasks.find((t) => t.id === "3.0" || t.text.includes("Optional polish"));
  ok(t3 && t3.isOptional === true, "optional task marked");

  const dag = new m.TaskDAG(file.tasks);
  const t1 = dag.byId("1.0");
  ok(t1 && t1.children.length === 2, "parent 1.0 has two children");
  ok(t1 && dag.isLeaf(t1) === false, "parent 1.0 is not leaf");
  ok(dag.byId("1.1") && dag.isLeaf(dag.byId("1.1")) === true, "1.1 is leaf");

  const ready0 = dag.getReadyTasks().map((t) => t.id);
  ok(ready0.includes("1.1"), `ready includes 1.1 (got ${ready0})`);
  ok(!ready0.some((id) => id === "2.0" || id === "3.0"), "2.0 blocked by dep, 3.0 optional excluded");

  const r1 = await m.updateTaskStatus(tasksPath, "1.1", "completed");
  ok(r1.ok && r1.autoCompleted.includes("1.0"), "completing 1.1 auto-completes parent 1.0");
  const file2 = await m.loadTasksFile(tasksPath);
  const line11 = file2.lines.find((l) => l.includes("Create files"));
  ok(/\[x\]/.test(line11), "checkbox [ ] -> [x] persisted in tasks.md");
  ok(file2.metadata.executionHistory === undefined || Object.keys(file2.metadata.executionHistory).length === 0,
    "no executionHistory added on completed (only inProgress)");

  const r2 = await m.updateTaskStatus(tasksPath, "2.0", "inProgress");
  ok(r2.ok, "update 2.0 to inProgress ok");
  const file3 = await m.loadTasksFile(tasksPath);
  ok(Array.isArray(file3.metadata.executionHistory["2.0"]) && file3.metadata.executionHistory["2.0"].length === 1,
    "executionHistory appended for inProgress");
  const line2 = file3.lines.find((l) => l.includes("Implement feature"));
  ok(/\[-\]/.test(line2), "checkbox [ ] -> [-] persisted for inProgress");

  const r3 = await m.updateTaskStatus(tasksPath, "nonexistent", "completed");
  ok(!r3.ok && /not found/.test(r3.message), "unknown task returns not found");

  const r4 = await m.queueAllLeafTasks(tasksPath);
  ok(r4.ok, "queueAllLeafTasks ok");

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(OUT, { force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
