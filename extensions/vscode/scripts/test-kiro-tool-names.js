/**
 * Verifies two things:
 *  1. Vendored filesystem tool names/schemas match Kiro's (internal ids).
 *  2. Kiro's dual-name mapping is wired at the two model boundaries:
 *       - internal id  -> displayName (what the model sees in the tools array)
 *       - displayName  -> internal id (what langgraph/GUI dispatch on)
 *
 * Run: node scripts/test-kiro-tool-names.js
 */
const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs");
const os = require("os");

const EXT_ROOT = path.resolve(__dirname, "..");
const EXT_NM = path.join(EXT_ROOT, "node_modules");
const SRC = path.resolve(
  EXT_ROOT,
  "../../../deepagentsjs/libs/deepagents/src/middleware/fs.ts",
);
const OUT = path.join(os.tmpdir(), `kiro-names-test-${process.pid}.cjs`);

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) {
    pass++;
    console.log("  PASS " + name);
  } else {
    fail++;
    console.log("  FAIL " + name);
  }
}

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
  const mod = require(OUT);
  const backend = {
    id: "names-test",
    ls: async () => ({ entries: [] }),
    read: async () => ({ content: "" }),
    write: async () => ({ error: undefined }),
    append: async () => ({ error: undefined }),
    edit: async () => ({ error: undefined }),
    glob: async () => ({ files: [] }),
    grep: async () => ({ matches: [] }),
    execute: async () => ({ output: "", exitCode: 0 }),
  };
  const tools = new Map(
    mod.createFilesystemMiddleware({ backend }).tools.map((t) => [t.name, t]),
  );

  const EXPECTED_NAMES = [
    "list_directory",
    "read_file",
    "read_files",
    "fs_write",
    "fs_append",
    "str_replace",
    "delete_file",
    "file_search",
    "grep_search",
    "execute_pwsh",
  ];
  for (const name of EXPECTED_NAMES) {
    check(`tool present: ${name}`, tools.has(name));
  }

  // Schema spot-checks mirroring Kiro's parameter contracts.
  const shapeOf = (name) => {
    let shape = tools.get(name)?.schema;
    while (shape && !shape.shape && shape._def) {
      shape = shape._def.schema || shape._def.innerType;
    }
    return shape?.shape || {};
  };
  check("str_replace has replace_all", !!shapeOf("str_replace").replace_all);
  check("delete_file uses targetFile", !!shapeOf("delete_file").targetFile);
  check(
    "read_file has start_line/end_line",
    !!shapeOf("read_file").start_line && !!shapeOf("read_file").end_line,
  );
  check("execute_pwsh has command", !!shapeOf("execute_pwsh").command);
  check("file_search has query", !!shapeOf("file_search").query);
  check(
    "grep_search has query+caseSensitive",
    !!shapeOf("grep_search").query && !!shapeOf("grep_search").caseSensitive,
  );

  // Dual-name mapping in the adapter source.
  const ADAPTER = path.resolve(
    EXT_ROOT,
    "src/deepagents/ContinueLLMAdapter.ts",
  );
  const src = fs.readFileSync(ADAPTER, "utf8");
  check(
    "TOOL_ID_TO_DISPLAY table declared",
    /const TOOL_ID_TO_DISPLAY[^\n]*=\s*\{/.test(src),
  );
  check(
    "TOOL_DISPLAY_TO_ID inverse declared",
    /const TOOL_DISPLAY_TO_ID[^\n]*=\s*Object\.fromEntries/.test(src),
  );
  const EXPECTED_MAP = {
    file_search: "glob",
    grep_search: "grep",
    read_file: "read",
    fs_write: "write",
    str_replace: "edit",
    execute_pwsh: "bash",
  };
  for (const [id, display] of Object.entries(EXPECTED_MAP)) {
    check(
      `dual-name map ${id} -> ${display}`,
      src.includes(`${id}: "${display}"`),
    );
  }
  check("outbound maps id->display", /name:\s*TOOL_ID_TO_DISPLAY\[/.test(src));
  check(
    "inbound maps display->id",
    /fn\.name\s*=\s*TOOL_DISPLAY_TO_ID\[fn\.name\]/.test(src),
  );

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
  fs.rmSync(OUT, { force: true });
})();
