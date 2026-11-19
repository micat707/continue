/**
 * Tests FilesystemBackend.append: atomic O_APPEND + per-path lock + newline
 * handling. Mirrors Kiro's fs_append semantics.
 * Run: node scripts/test-file-append.js
 */
const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT_ROOT = path.resolve(__dirname, "..");
const EXT_NM = path.join(EXT_ROOT, "node_modules");
const SRC = path.resolve(
  EXT_ROOT,
  "../../../deepagentsjs/libs/deepagents/src/backends/filesystem.ts",
);
const OUT = path.join(os.tmpdir(), `kiro-append-bundle-${process.pid}.cjs`);

(async () => {
  await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUT,
    nodePaths: [EXT_NM],
    logLevel: "error",
  });
  const { FilesystemBackend } = require(OUT);

  let pass = 0;
  let fail = 0;
  function check(name, cond, detail) {
    if (cond) {
      pass++;
      console.log("  PASS " + name);
    } else {
      fail++;
      console.log("  FAIL " + name + (detail ? " — " + detail : ""));
    }
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-append-"));
  const backend = new FilesystemBackend({ rootDir: tmp, virtualMode: true });
  const p = (name) => "/" + name;

  // 1) append to a non-existent file creates it
  let r = await backend.append(p("a.txt"), "first");
  check(
    "append creates file",
    !r.error && fs.readFileSync(path.join(tmp, "a.txt"), "utf8") === "first",
    JSON.stringify(r),
  );

  // 2) second append does NOT overwrite (the key difference from write)
  r = await backend.append(p("a.txt"), "second");
  check(
    "append does not overwrite",
    fs.readFileSync(path.join(tmp, "a.txt"), "utf8") === "first\nsecond",
  );

  // 3) newline handling: file already ends with newline -> no extra blank line
  fs.writeFileSync(path.join(tmp, "b.txt"), "line1\n");
  await backend.append(p("b.txt"), "line2");
  check(
    "no double newline when trailing \\n",
    fs.readFileSync(path.join(tmp, "b.txt"), "utf8") === "line1\nline2",
  );

  // 4) concurrent appends never lose each other (the race Kiro's lock prevents)
  fs.writeFileSync(path.join(tmp, "c.txt"), "");
  await Promise.all(
    Array.from({ length: 30 }, (_, i) => backend.append(p("c.txt"), `L${i}`)),
  );
  const cContent = fs.readFileSync(path.join(tmp, "c.txt"), "utf8");
  const cLines = cContent.split("\n");
  check(
    "concurrent appends: all 30 present",
    cLines.length === 30,
    `lines=${cLines.length}`,
  );
  // Concurrent appends serialize via the lock, but arrival ORDER is
  // nondeterministic. What matters: every append is present exactly once
  // (no lost writes, no overwrite) — that is the race Kiro's lock prevents.
  const expected = new Set(Array.from({ length: 30 }, (_, i) => `L${i}`));
  check(
    "concurrent appends: all present exactly once, no lost writes",
    cLines.length === 30 &&
      cLines.every((l) => expected.has(l)) &&
      new Set(cLines).size === 30,
    cContent.slice(0, 120),
  );

  // 5) path containment: cannot escape root
  r = await backend.append("/../escape.txt", "x");
  check("append rejects path outside root", !!r.error, JSON.stringify(r));

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  fs.rmSync(tmp, { recursive: true, force: true });
  try {
    fs.unlinkSync(OUT);
  } catch {}
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
