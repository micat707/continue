/**
 * Regression test for Kiro-style regex grep in the vendored deepagents backend.
 *
 * The extension's vitest cannot import deepagents source directly (its CJS
 * deps are not resolvable under vitest's ESM externalization), so this script
 * uses esbuild's JS API to bundle the real `filesystem.ts` source with the
 * extension's node_modules, then exercises FilesystemBackend.grep with regex.
 *
 * Run: node scripts/test-grep-regex.js
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
const OUT = path.join(os.tmpdir(), `kiro-grep-bundle-${process.pid}.cjs`);

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

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kiro-regex-"));
  fs.writeFileSync(
    path.join(tmp, "sample.ts"),
    [
      "function alpha() {}",
      "const beta = 42;",
      "function gamma() { return 3.14; }",
      "password = 'secret'",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(tmp, "other.md"), "just prose here\n");

  let pass = 0;
  let fail = 0;
  function check(name, cond) {
    if (cond) {
      pass++;
      console.log("  PASS " + name);
    } else {
      fail++;
      console.log("  FAIL " + name);
    }
  }

  const mk = (virtual = false, fallback = false) => {
    const b = new FilesystemBackend({ rootDir: tmp, virtualMode: virtual });
    if (fallback) b.ripgrepSearch = async () => null;
    return b;
  };

  let r = await mk().grep("\\bfunction\\b", tmp, null, null, true);
  check(
    "regex word-boundary matches 2 lines (rg)",
    (r.matches || []).filter((m) => m.path.endsWith("sample.ts")).length === 2,
  );

  r = await mk().grep("\\bfunction\\b", tmp, null, null, false);
  check(
    "literal mode: \\bfunction\\b matches 0",
    (r.matches || []).length === 0,
  );

  r = await mk().grep("\\d+\\.\\d+", tmp, null, null, true);
  check(
    "digit-class regex finds 3.14",
    (r.matches || []).length === 1 && r.matches[0].text.includes("3.14"),
  );

  r = await mk().grep("^function", tmp, null, null, true);
  check("anchored regex matches 2", (r.matches || []).length === 2);

  r = await mk(false, true).grep("FUNCTION", tmp, null, null, true);
  check(
    "regexSearch fallback case-insensitive",
    (r.matches || []).length === 2,
  );

  r = await mk(false, true).grep("prose", tmp, "*.md", null, true);
  check(
    "regexSearch fallback honors includePattern",
    (r.matches || []).length === 1 && r.matches[0].path.endsWith("other.md"),
  );

  r = await mk(false, true).grep("[unclosed", tmp, null, null, true);
  check(
    "invalid regex returns empty, no throw",
    !r.error && (r.matches || []).length === 0,
  );

  r = await mk(true, true).grep("\\bbeta\\b", "/", null, null, true);
  check(
    "regex in virtual mode returns /sample.ts",
    (r.matches || []).length === 1 && r.matches[0].path === "/sample.ts",
  );

  r = await mk().grep("function", tmp);
  check(
    "omitted regex arg stays literal (back-compat)",
    (r.matches || []).length === 2,
  );

  // --- caseSensitive / excludePattern (Kiro parity) ---
  // default is case-insensitive (Kiro): "FUNCTION" matches "function"
  r = await mk().grep("FUNCTION", tmp, null, null, true);
  check("default grep is case-insensitive (rg)", (r.matches || []).length >= 2);
  r = await mk().grep("FUNCTION", tmp, null, null, true, true);
  check(
    "caseSensitive=true matches nothing for FUNCTION",
    (r.matches || []).length === 0,
  );
  r = await mk().grep("function", tmp, null, null, true, true);
  check(
    "caseSensitive=true matches lowercase function",
    (r.matches || []).length === 2,
  );
  // fallback path honors caseSensitive too
  r = await mk(false, true).grep("FUNCTION", tmp, null, null, true, true);
  check(
    "regex fallback caseSensitive=true matches nothing",
    (r.matches || []).length === 0,
  );
  r = await mk(false, true).grep("function", tmp, null, null, false, true);
  check(
    "literal fallback caseSensitive=true matches",
    (r.matches || []).length === 2,
  );
  // excludePattern via ripgrep
  r = await mk().grep("function", tmp, null, null, true, false, "*.ts");
  check(
    "excludePattern *.ts excludes sample.ts",
    (r.matches || []).length === 0,
  );
  // excludePattern via fallback
  r = await mk(false, true).grep("prose", tmp, null, null, true, false, "*.md");
  check(
    "excludePattern *.md excludes other.md (fallback)",
    (r.matches || []).length === 0,
  );

  // --- ls depth (Kiro parity) ---
  fs.mkdirSync(path.join(tmp, "sub", "deep"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "sub", "level2.ts"), "x");
  fs.writeFileSync(path.join(tmp, "sub", "deep", "level3.ts"), "x");
  const lb = mk();
  let ls = await lb.ls(tmp, 1);
  check(
    "ls depth=1 non-recursive",
    !(ls.files || []).some((f) => f.path.includes("level2")),
  );
  ls = await lb.ls(tmp, 2);
  check(
    "ls depth=2 includes level2",
    (ls.files || []).some((f) => f.path.includes("level2")),
  );
  check(
    "ls depth=2 excludes level3",
    !(ls.files || []).some((f) => f.path.includes("level3")),
  );
  ls = await lb.ls(tmp, 3);
  check(
    "ls depth=3 includes level3",
    (ls.files || []).some((f) => f.path.includes("level3")),
  );

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
