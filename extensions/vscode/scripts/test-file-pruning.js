/**
 * Unit tests for the Kiro-style read_file pruning module.
 * Run: node scripts/test-file-pruning.js
 */
const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");
const os = require("os");

const SRC = path.resolve(__dirname, "../src/deepagents/filePruning.ts");
const OUT = path.join(os.tmpdir(), `kiro-pruning-bundle-${process.pid}.cjs`);

(async () => {
  await esbuild.build({
    entryPoints: [SRC],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: OUT,
    logLevel: "error",
  });
  const {
    buildPruningPrompt,
    parseLineRanges,
    extractLineRanges,
    createPruneFileContent,
    estimateTokens,
  } = require(OUT);

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

  check(
    "estimateTokens counts chars + lines + fences",
    estimateTokens("a\nb") === Math.ceil(2 / 4) + Math.ceil(2 * 0.5) + 0,
  );
  check(
    "estimateTokens adds 2 per code fence",
    estimateTokens("```\na\n```") ===
      Math.ceil(9 / 4) + Math.ceil(3 * 0.5) + 2 * 2,
  );
  check("estimateTokens of empty string is 0", estimateTokens("") === 0);

  const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`);
  const content = lines.join("\n");
  const prompt = buildPruningPrompt(content, "/a.ts", "find foo", "code");
  check(
    "prompt has right-aligned line numbers",
    prompt.includes("    1 | line 1"),
  );
  check(
    "prompt has reasoning",
    prompt.includes("PRUNING REASONING:\nfind foo"),
  );
  check("prompt has context path", prompt.includes("CONTEXT: /a.ts"));
  check("prompt has total lines", prompt.includes("Total lines: 60"));
  check("prompt has JSON range format", prompt.includes('"start": 1'));
  check("prompt has code guidelines", prompt.includes("class definitions"));
  check("full read has no partial notice", !prompt.includes("PARTIAL EXCERPT"));

  // Partial excerpt: the model must be told the slice's position and total size.
  const partialPrompt = buildPruningPrompt(
    content,
    "/a.ts",
    "find foo",
    "code",
    {
      startLine: 101,
      endLine: 160,
      totalLines: 5000,
      isPartial: true,
    },
  );
  check(
    "partial prompt has excerpt notice",
    partialPrompt.includes("PARTIAL EXCERPT"),
  );
  check(
    "partial prompt states source range",
    partialPrompt.includes("source lines 101-160 of 5000"),
  );
  check(
    "partial prompt states excerpt-relative numbering",
    partialPrompt.includes("relative to THIS EXCERPT"),
  );
  check(
    "partial prompt keeps excerpt-relative Total lines",
    partialPrompt.includes("Total lines: 60"),
  );

  // isPartial=false with totalLines must not add the notice (full file read).
  const fullWithTotal = buildPruningPrompt(
    content,
    "/a.ts",
    "find foo",
    "code",
    {
      startLine: 1,
      endLine: 60,
      totalLines: 60,
      isPartial: false,
    },
  );
  check(
    "non-partial context adds no notice",
    !fullWithTotal.includes("PARTIAL EXCERPT"),
  );

  check(
    "parseLineRanges keeps valid integer ranges",
    JSON.stringify(parseLineRanges('[{"start":2,"end":5,"reason":"x"}]')) ===
      '[{"start":2,"end":5,"reason":"x"}]',
  );
  check(
    "parseLineRanges extracts array from prose",
    parseLineRanges('Sure: [{"start":1,"end":3}] done').length === 1,
  );
  check(
    "parseLineRanges rejects non-integer / out-of-range",
    parseLineRanges('[{"start":0,"end":3},{"start":2.5,"end":4}]').length === 0,
  );
  check(
    "parseLineRanges sorts by start",
    JSON.stringify(
      parseLineRanges('[{"start":9,"end":10},{"start":1,"end":2}]'),
    ) === '[{"start":1,"end":2},{"start":9,"end":10}]',
  );

  const extracted = extractLineRanges("a\nb\nc\nd\ne", [
    { start: 2, end: 3 },
    { start: 5, end: 5 },
  ]);
  check(
    "extract keeps requested lines",
    extracted.includes("b\nc") && extracted.includes("e"),
  );
  check(
    "extract uses omission marker",
    extracted.includes("[content omitted by pruning]"),
  );

  const big = Array.from(
    { length: 6000 },
    (_, i) => `x${"a".repeat(10)} ${i}`,
  ).join("\n");
  let seenPrompt = "";
  const prune = createPruneFileContent(async (p) => {
    seenPrompt = p;
    return '[{"start":1,"end":10}]';
  });
  const pruned = await prune(big, "/a.ts", "need foo", false);
  check("large file is pruned", pruned.length < big.length);
  check("explanation reaches prune prompt", seenPrompt.includes("need foo"));

  check(
    "skipPruning returns full content",
    (await prune(big, "/a.ts", "", true)) === big,
  );
  check(
    "small file bypasses pruning",
    (await prune("tiny", "/a.ts", "", false)) === "tiny",
  );

  const failing = createPruneFileContent(async () => {
    throw new Error("model down");
  });
  check(
    "LLM error falls back to full content",
    (await failing(big, "/a.ts", "", false)) === big,
  );

  const noRanges = createPruneFileContent(async () => "no json here");
  check(
    "no valid ranges falls back",
    (await noRanges(big, "/a.ts", "", false)) === big,
  );

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  fs.unlinkSync(OUT);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
