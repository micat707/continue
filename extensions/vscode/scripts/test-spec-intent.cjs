const esbuild = require("esbuild");
const path = require("path");
const os = require("os");
const fs = require("fs");

const EXT_ROOT = path.resolve(__dirname, "..");
const NM = path.join(EXT_ROOT, "node_modules");
const SRC = path.resolve(EXT_ROOT, "src/deepagents/specIntent.ts");
const OUT = path.join(os.tmpdir(), `spec-intent-test-${process.pid}.cjs`);

let pass = 0, fail = 0;
const ok = (c, label) => { if (c) { pass++; console.log("  PASS " + label); } else { fail++; console.log("  FAIL " + label); } };

(async () => {
  await esbuild.build({
    entryPoints: [SRC], bundle: true, platform: "node", format: "cjs",
    outfile: OUT, nodePaths: [NM], logLevel: "error",
  });
  const m = require(OUT);

  // Kiro T$u local regex — taskExecution patterns
  for (const text of [
    "Run all tasks",
    "execute all tasks",
    "Execute task 3",
    "run task 2",
    "start task 1",
    "What is the next task?",
    "continue running tasks",
    "resume tasks",
  ]) {
    const w = m.detectLocalIntent(text);
    ok(w.taskExecution > w.specGeneration, `local taskExecution: "${text}"`);
  }
  // specGeneration (default) patterns
  for (const text of [
    "Create the tasks for user-authentication",
    "Generate the task list for my-feature",
    "Let's design the database schema",
    "There's a bug: the login page crashes. Fix it.",
    "What should the user flow look like?",
  ]) {
    const w = m.detectLocalIntent(text);
    ok(w.specGeneration > w.taskExecution, `local specGeneration: "${text}"`);
  }

  // finalizeIntent: LLM confident >= .7 wins
  let r = m.finalizeIntent(
    { specGeneration: 0.9, taskExecution: 0.1 },
    { specGeneration: 0.05, taskExecution: 0.95 },
  );
  ok(r.classification === "taskExecution" && r.source === "llmConfident", "finalize: LLM confident overrides local");
  r = m.finalizeIntent(
    { specGeneration: 0.1, taskExecution: 0.9 },
    { specGeneration: 0.95, taskExecution: 0.05 },
  );
  ok(r.classification === "specGeneration" && r.source === "llmConfident", "finalize: LLM specGeneration confident");
  // LLM uncertain (< .7) → average; local .9 do vs llm .55/.45 → combined do still > spec
  r = m.finalizeIntent(
    { specGeneration: 0.1, taskExecution: 0.9 },
    { specGeneration: 0.55, taskExecution: 0.45 },
  );
  ok(r.source === "combined" && r.classification === "taskExecution", "finalize: uncertain LLM averages with local");
  // no LLM → local fallback
  r = m.finalizeIntent({ specGeneration: 0.1, taskExecution: 0.9 }, undefined);
  ok(r.source === "localFallback" && r.classification === "taskExecution", "finalize: no LLM → localFallback");

  // classifyFromWeights tie → specGeneration (Kiro: taskExecution > specGeneration)
  ok(m.classifyFromWeights({ specGeneration: 0.5, taskExecution: 0.5 }) === "specGeneration", "tie → specGeneration (default)");

  // classifySpecIntent with fake model returning confident LLM JSON
  const { HumanMessage, AIMessage } = require(path.join(NM, "@langchain/core/messages"));
  const fakeModel = {
    async invoke(msgs) {
      return new AIMessage({ content: '{"specGeneration": 0.05, "taskExecution": 0.95}' });
    },
  };
  const messages = [new HumanMessage({ content: "create the tasks for login" })];
  const c = await m.classifySpecIntent(fakeModel, messages);
  ok(c.classification === "taskExecution" && c.source === "llmConfident", "classifySpecIntent: LLM JSON parsed & confident wins over local");
  const forced = await m.classifySpecIntent(fakeModel, messages, "taskExecution");
  ok(forced.classification === "taskExecution" && forced.source === "forced", "classifySpecIntent: forceIntent short-circuit");

  // lastHumanText
  ok(m.lastHumanText(messages) === "create the tasks for login", "lastHumanText extracts final human text");
  ok(m.lastHumanText([new AIMessage({ content: "x" })]) === "", "lastHumanText empty without human");

  fs.rmSync(OUT, { force: true });
  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
})();
