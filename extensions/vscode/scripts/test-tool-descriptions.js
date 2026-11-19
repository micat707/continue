/**
 * Verifies that the vendored tool descriptions and parameter descriptions
 * are byte-for-byte identical to the specs in `.kiro/compare/kiro.txt`
 * (the EnvironmentContext tool specification document).
 *
 * Source of truth: d:/soft/Kiro_back/.kiro/compare/kiro.txt
 *
 * Run: node scripts/test-tool-descriptions.js
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
const KIRO_TXT = path.resolve(EXT_ROOT, "../../../../.kiro/compare/kiro.txt");
const OUT = path.join(os.tmpdir(), `kiro-desc-test-${process.pid}.cjs`);
const DEEP_DIR = path.resolve(EXT_ROOT, "src/deepagents");

// Our tool name -> kiro.txt tool name. Only shared tools are checked.
const NAME_MAP = {
  list_directory: "list_directory",
  read_file: "read_file",
  fs_write: "fs_write",
  fs_append: "fs_append",
  str_replace: "str_replace",
  delete_file: "delete_file",
  file_search: "file_search",
  grep_search: "grep_search",
  execute_pwsh: "execute_pwsh",
  control_pwsh_process: "control_pwsh_process",
  get_process_output: "get_process_output",
  list_processes: "list_processes",
  web_fetch: "web_fetch",
  web_search: "remote_web_search",
};

// Non-fs tools cannot be required as modules here; read their `description`
// expression straight out of the TS source and evaluate it. This covers both
// `[...].join("\n")` and `"..." + "..."` styles.
const NONFS_SRC_FILE = {
  control_pwsh_process: "workspaceBackend.ts",
  get_process_output: "workspaceBackend.ts",
  list_processes: "workspaceBackend.ts",
  web_fetch: "webFetchTool.ts",
  web_search: "webSearchTool.ts",
};
const srcCache = new Map();
function readSrc(file) {
  if (!srcCache.has(file)) {
    srcCache.set(file, fs.readFileSync(path.join(DEEP_DIR, file), "utf8"));
  }
  return srcCache.get(file);
}
function extractDescriptionFromSource(src, toolName) {
  const ni = src.indexOf(`name: "${toolName}"`);
  if (ni < 0) return null;
  const di = src.indexOf("description:", ni);
  if (di < 0) return null;
  const tail = src.slice(di + "description:".length);
  const next = tail.search(/\n\s{6}(schema|func):/);
  if (next < 0) return null;
  let expr = tail.slice(0, next).trim();
  if (expr.endsWith(",")) expr = expr.slice(0, -1).trim();
  try {
    const v = eval(expr);
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(KIRO_TXT, "utf8"));
  const specTools =
    doc.conversationState.currentMessage.userInputMessage
      .userInputMessageContext.tools;
  const specByName = new Map(
    specTools.map((t) => [t.toolSpecification.name, t.toolSpecification]),
  );

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
    id: "desc-test",
    ls: async () => ({ entries: [] }),
    read: async () => ({ content: "" }),
    write: async () => ({ error: undefined }),
    append: async () => ({ error: undefined }),
    edit: async () => ({ error: undefined }),
    glob: async () => ({ files: [] }),
    grep: async () => ({ matches: [] }),
    execute: async () => ({ output: "", exitCode: 0 }),
  };
  const fsTools = new Map(
    mod.createFilesystemMiddleware({ backend }).tools.map((t) => [t.name, t]),
  );

  let pass = 0;
  let fail = 0;

  for (const [name, specName] of Object.entries(NAME_MAP)) {
    let got = fsTools.get(name)?.description;
    if (got == null) {
      const file = NONFS_SRC_FILE[name];
      if (file) got = extractDescriptionFromSource(readSrc(file), name);
    }
    if (got == null) continue;
    const spec = specByName.get(specName);
    if (!spec) {
      console.log(`  SKIP ${name} (no kiro.txt spec ${specName})`);
      continue;
    }
    const want = (spec.description || "").replace(/\$\{[^}]+\}/g, (m) => {
      if (m === "${b9}") return "50 lines";
      if (m === "${k11}") return "control_pwsh_process";
      return m;
    });
    if (got === want) {
      pass++;
      console.log(`  PASS ${name} description matches kiro.txt verbatim`);
    } else {
      fail++;
      console.log(`  FAIL ${name} description mismatch`);
      const a = got.split("\n");
      const b = want.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`    L${i + 1} O:${JSON.stringify(a[i])}`);
          console.log(`    L${i + 1} K:${JSON.stringify(b[i])}`);
        }
      }
    }
  }

  // Shared-field parameter descriptions must match kiro.txt verbatim.
  const PARAM_FIELDS = {
    list_directory: ["path", "depth"],
    read_file: ["path"],
    fs_write: ["path", "text"],
    fs_append: ["path", "text"],
    str_replace: ["path", "oldStr", "newStr", "replace_all"],
    delete_file: ["targetFile"],
    file_search: ["query"],
    grep_search: ["query", "caseSensitive", "excludePattern", "includePattern"],
    execute_pwsh: ["command", "cwd", "timeout"],
  };
  for (const [name, fields] of Object.entries(PARAM_FIELDS)) {
    const tool = fsTools.get(name);
    if (!tool) continue;
    const spec = specByName.get(NAME_MAP[name]);
    if (!spec) continue;
    const specProps = spec.inputSchema.json.properties || {};
    let shape = tool.schema;
    while (shape && !shape.shape && shape._def) {
      shape = shape._def.schema || shape._def.innerType;
    }
    const shapeFields = shape?.shape || {};
    for (const key of fields) {
      const want = specProps[key]?.description;
      if (want == null) continue;
      const field = shapeFields[key];
      const got = field?.description ?? field?._def?.description;
      if (got === want) {
        pass++;
        console.log(`  PASS ${name}.${key} param description matches kiro.txt`);
      } else {
        fail++;
        console.log(`  FAIL ${name}.${key} param description mismatch`);
        console.log(`    O:${JSON.stringify(got)}`);
        console.log(`    K:${JSON.stringify(want)}`);
      }
    }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
  fs.rmSync(OUT, { force: true });
})();
