/**
 * Tests the Kiro-style long-running command detector.
 * Run: node scripts/test-command-warning.js
 */
const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT = path.resolve(__dirname, "..");
const SRC = path.resolve(
  EXT,
  "../../../deepagentsjs/libs/deepagents/src/middleware/commandWarning.ts",
);
const OUT = path.join(os.tmpdir(), `cmd-warn-${process.pid}.cjs`);

(async () => {
  await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUT,
    nodePaths: [path.join(EXT, "node_modules")],
    logLevel: "error",
  });
  const {
    detectLongRunningCommand,
    hasQuickFlag,
    generateLongRunningWarning,
  } = require(OUT);

  let pass = 0,
    fail = 0;
  function check(name, cond) {
    if (cond) {
      pass++;
      console.log("  PASS " + name);
    } else {
      fail++;
      console.log("  FAIL " + name);
    }
  }

  check(
    "detects npm run dev",
    detectLongRunningCommand("npm run dev")?.category === "dev-server",
  );
  check(
    "detects yarn start",
    detectLongRunningCommand("yarn start")?.category === "dev-server",
  );
  check(
    "detects webpack --watch",
    detectLongRunningCommand("npx webpack --watch")?.category ===
      "build-watcher",
  );
  check(
    "detects vim (interactive)",
    detectLongRunningCommand("vim foo.txt")?.category === "interactive",
  );
  check(
    "detects python http.server",
    detectLongRunningCommand("python -m http.server")?.category ===
      "dev-server",
  );
  check(
    "plain command not flagged",
    detectLongRunningCommand("echo hello") === null,
  );
  check(
    "npm run build not flagged as dev",
    detectLongRunningCommand("npm run build") === null,
  );

  check("quick flag --once", hasQuickFlag("npm run dev --once"));
  check("quick flag --run", hasQuickFlag("vitest --run"));
  check("no quick flag", !hasQuickFlag("npm run dev"));

  const w = detectLongRunningCommand("npm run dev");
  const msg = generateLongRunningWarning("npm run dev", w);
  check("warning mentions control tool", msg.includes("control_pwsh_process"));
  check("warning mentions ignoreWarning", msg.includes("ignoreWarning: true"));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  fs.unlinkSync(OUT);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
