/**
 * Verifies that the vendored tool descriptions and parameter descriptions
 * are byte-for-byte identical to the NEW Kiro version's tool specs in
 * `.kiro/compare/kiro_tools.txt` (the in-use version at D:/soft/Kiro).
 *
 * Source of truth: d:/soft/Kiro_back/.kiro/compare/kiro_tools.txt
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
const KIRO_TXT = path.resolve(
  EXT_ROOT,
  "../../../../.kiro/compare/kiro_tools.txt",
);
const OUT = path.join(os.tmpdir(), `kiro-desc-test-${process.pid}.cjs`);
const DEEP_DIR = path.resolve(EXT_ROOT, "src/deepagents");
const z = require(require.resolve("zod", { paths: [EXT_NM] }));

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
  remote_web_search: "remote_web_search",
};

// Non-fs tools cannot be required as modules here; read their `description`
// expression straight out of the TS source and evaluate it. This covers both
// `[...].join("\n")` and `"..." + "..."` styles.
const NONFS_SRC_FILE = {
  control_pwsh_process: "workspaceBackend.ts",
  get_process_output: "workspaceBackend.ts",
  list_processes: "workspaceBackend.ts",
  web_fetch: "webFetchTool.ts",
  remote_web_search: "webSearchTool.ts",
};
const srcCache = new Map();
function readSrc(file) {
  if (!srcCache.has(file)) {
    srcCache.set(file, fs.readFileSync(path.join(DEEP_DIR, file), "utf8"));
  }
  return srcCache.get(file);
}

// Tools migrated to the ACP bridge expose a `*_DEFINITION` object (name /
// description / zod schema) instead of an inline `name: "..."` tool literal, so
// the source-text extractors below cannot see them. Load the real definition
// at runtime instead — this validates exactly what the model receives.
let webFetchDefinitionPromise;
async function loadWebFetchDefinition() {
  if (!webFetchDefinitionPromise) {
    webFetchDefinitionPromise = (async () => {
      // jsdom loads a sibling worker via a relative require(), so it must stay
      // external and the bundle must live where node_modules is resolvable.
      const out = path.join(EXT_ROOT, `out/_web-fetch-def-${process.pid}.cjs`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await esbuild.build({
        entryPoints: [path.join(DEEP_DIR, "webFetchTool.ts")],
        bundle: true,
        platform: "node",
        format: "cjs",
        outfile: out,
        nodePaths: [EXT_NM],
        logLevel: "error",
        external: ["jsdom"],
      });
      try {
        const mod = require(out);
        return mod.WEB_FETCH_DEFINITION;
      } finally {
        fs.rmSync(out, { force: true });
      }
    })();
  }
  return webFetchDefinitionPromise;
}
function zodFieldDescription(schema, key) {
  let sh = schema;
  while (sh && !sh.shape && sh._def) sh = sh._def.schema || sh._def.innerType;
  let field = sh && sh.shape && sh.shape[key];
  while (field && field._def && !field.description) {
    field = field._def.innerType || field._def.schema || field._def.type;
  }
  return field && field.description;
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

// Extract a zod `.describe("...")` string that follows a `key:` field inside a
// tool's schema. Used for NON-fs tools whose schema can't be required at test
// time; we read the literal straight from source. `key` may be a quoted key.
function extractParamDescFromSource(src, toolName, key) {
  const ni = src.indexOf(`name: "${toolName}"`);
  if (ni < 0) return null;
  // Restrict to the schema block so description prose mentioning `command:`
  // (or code like `input.url`) can't be mistaken for a schema field.
  const so = src.indexOf("schema:", ni);
  if (so < 0) return null;
  const next = src
    .slice(so + "schema:".length)
    .search(/\n\s{4,6}(func|schema):/);
  const schemaSrc =
    next < 0 ? src.slice(so) : src.slice(so, so + "schema:".length + next);
  // Field key must sit at line start (optionally quoted) followed by ':'.
  const keyRe = new RegExp(`^[ \\t]+['"]?${key}['"]?:`, "m");
  const keyMatch = keyRe.exec(schemaSrc);
  if (!keyMatch) return null;
  // From this field's start, find the FIRST `.describe(` before the next field.
  const fieldStart = keyMatch.index;
  const rest = schemaSrc.slice(fieldStart);
  const descIdx = rest.indexOf(".describe(");
  if (descIdx < 0) return null;
  const argStart = fieldStart + descIdx + ".describe(".length;
  // Scan forward with quote + parenthesis balance to find the matching ')'.
  let i = argStart,
    depth = 1,
    quote = null,
    esc = false;
  for (; i < schemaSrc.length && depth > 0; i++) {
    const ch = schemaSrc[i];
    if (esc) {
      esc = false;
      continue;
    }
    if (ch === "\\") {
      esc = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
  }
  if (depth !== 0) return null;
  let expr = schemaSrc.slice(argStart, i - 1).trim();
  if (expr.endsWith(",")) expr = expr.slice(0, -1).trim();
  try {
    const v = eval(expr);
    return typeof v === "string" ? v : null;
  } catch {
    const lits = [...expr.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) =>
      x[1].replace(/\\"/g, '"').replace(/\\n/g, "\n"),
    );
    return lits.length ? lits.join("") : null;
  }
}

(async () => {
  const doc = JSON.parse(fs.readFileSync(KIRO_TXT, "utf8"));
  // New kiro_tools.txt is a flat array of { toolSpecification } entries.
  // (Old kiro.txt nested them under conversationState... — no longer used.)
  const specTools = Array.isArray(doc)
    ? doc
    : doc.conversationState.currentMessage.userInputMessage
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
    if (name === "web_fetch") {
      const def = await loadWebFetchDefinition();
      if (def) got = def.description;
    }
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
    list_directory: ["path", "depth", "explanation"],
    read_file: ["path", "offset", "limit"],
    fs_write: ["path", "text"],
    fs_append: ["path", "text"],
    str_replace: ["path", "oldStr", "newStr", "replace_all"],
    delete_file: ["targetFile", "explanation"],
    file_search: [
      "query",
      "explanation",
      "excludePattern",
      "includeIgnoredFiles",
    ],
    grep_search: [
      "query",
      "caseSensitive",
      "excludePattern",
      "includePattern",
      "explanation",
    ],
    execute_pwsh: [
      "command",
      "cwd",
      "timeout",
      "description",
      "run_in_background",
    ],
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

  // fs tools' required array must match Kiro's spec: zod .default() silently
  // promotes a field into `required`, defeating the model-facing default.
  // Restricted to tools already aligned; other historical mismatches (e.g.
  // list_directory.path) are tracked separately and out of scope here.
  for (const name of ["execute_pwsh"]) {
    const tool = fsTools.get(name);
    const spec = specByName.get(NAME_MAP[name]);
    if (!tool || !spec) continue;
    let shape = tool.schema;
    while (shape && !shape.shape && shape._def) {
      shape = shape._def.schema || shape._def.innerType;
    }
    const gotFields = Object.keys((shape && shape.shape) || {});
    const gotRequired = gotFields.filter(
      (f) => shape.shape[f] && !shape.shape[f].isOptional(),
    );
    const wantRequired = spec.inputSchema.json.required || [];
    if (JSON.stringify(gotRequired) === JSON.stringify(wantRequired)) {
      pass++;
      console.log(`  PASS ${name} schema required matches kiro.txt`);
    } else {
      fail++;
      console.log(
        `  FAIL ${name} schema required O:${JSON.stringify(gotRequired)} K:${JSON.stringify(wantRequired)}`,
      );
    }
  }

  // Non-fs tools' parameter descriptions (new Kiro version). Read from source.
  const NONFS_PARAM_FIELDS = {
    control_pwsh_process: ["action", "command", "cwd", "terminalId"],
    get_process_output: ["terminalId", "lines"],
    web_fetch: ["url", "mode", "searchPhrase"],
    remote_web_search: ["query"],
  };
  for (const [name, fields] of Object.entries(NONFS_PARAM_FIELDS)) {
    const file = NONFS_SRC_FILE[name];
    if (!file) continue;
    const src = readSrc(file);
    const acpDef = name === "web_fetch" ? await loadWebFetchDefinition() : null;
    const specName = name;
    const spec = specByName.get(specName);
    if (!spec) {
      console.log(`  SKIP ${name} params (no kiro_tools.txt spec ${specName})`);
      continue;
    }
    const specProps = spec.inputSchema.json.properties || {};
    for (const key of fields) {
      const want = specProps[key]?.description;
      if (want == null) continue;
      const got = acpDef
        ? zodFieldDescription(acpDef.schema, key)
        : extractParamDescFromSource(src, name, key);
      if (got === want) {
        pass++;
        console.log(
          `  PASS ${name}.${key} param description matches kiro_tools.txt`,
        );
      } else {
        fail++;
        console.log(`  FAIL ${name}.${key} param description mismatch`);
        console.log(`    O:${JSON.stringify(got)}`);
        console.log(`    K:${JSON.stringify(want)}`);
      }
    }
  }

  // The generated JSON schema of a tool must match Kiro's spec exactly in
  // field set + order + required array. Without this, extra model-facing
  // parameters (e.g. retrieval tuning knobs) can silently creep back in.
  const SCHEMA_SHAPE_CHECKS = {
    remote_web_search: "webSearchTool.ts",
    web_fetch: "webFetchTool.ts",
  };
  for (const [name, file] of Object.entries(SCHEMA_SHAPE_CHECKS)) {
    const spec = specByName.get(name);
    if (!spec) {
      fail++;
      console.log(`  FAIL ${name} schema shape (no kiro_tools.txt spec)`);
      continue;
    }
    let shape;
    if (name === "web_fetch") {
      const def = await loadWebFetchDefinition();
      if (!def) {
        fail++;
        console.log(
          `  FAIL ${name} schema shape (cannot load runtime definition)`,
        );
        continue;
      }
      shape = def.schema;
    } else {
      const src = readSrc(file);
      const ni = src.indexOf(`name: "${name}"`);
      if (ni < 0) {
        fail++;
        console.log(`  FAIL ${name} schema shape (tool not found in ${file})`);
        continue;
      }
      const so = src.indexOf("schema:", ni);
      const tail = src.slice(so + "schema:".length);
      const end = tail.search(/\n\s{4,6}(func|schema):/);
      try {
        // eslint-disable-next-line no-new-func
        shape = new Function(
          "z",
          `return ${tail.slice(0, end).trim().replace(/,$/, "")}`,
        )(z);
      } catch (e) {
        fail++;
        console.log(
          `  FAIL ${name} schema shape (cannot evaluate: ${e && e.message})`,
        );
        continue;
      }
    }
    let sh = shape;
    while (sh && !sh.shape && sh._def) sh = sh._def.schema || sh._def.innerType;
    const gotFields = Object.keys((sh && sh.shape) || {});
    const wantFields = Object.keys(spec.inputSchema.json.properties || {});
    if (JSON.stringify(gotFields) === JSON.stringify(wantFields)) {
      pass++;
      console.log(`  PASS ${name} schema fields + order match kiro.txt`);
    } else {
      fail++;
      console.log(
        `  FAIL ${name} schema fields O:${JSON.stringify(gotFields)} K:${JSON.stringify(wantFields)}`,
      );
    }
    const gotRequired = gotFields.filter(
      (f) => sh.shape[f] && !sh.shape[f].isOptional(),
    );
    const wantRequired = spec.inputSchema.json.required || [];
    if (JSON.stringify(gotRequired) === JSON.stringify(wantRequired)) {
      pass++;
      console.log(`  PASS ${name} schema required matches kiro.txt`);
    } else {
      fail++;
      console.log(
        `  FAIL ${name} schema required O:${JSON.stringify(gotRequired)} K:${JSON.stringify(wantRequired)}`,
      );
    }
  }

  // kiroExtraTools: bundle the new Kiro-aligned tools and compare their
  // description + schema fields against kiro_tools.txt verbatim.
  const EXTRA_SRC = path.resolve(EXT_ROOT, "src/deepagents/kiroExtraTools.ts");
  const EXTRA_OUT = path.join(
    os.tmpdir(),
    `kiro-extra-test-${process.pid}.cjs`,
  );
  try {
    await esbuild.build({
      entryPoints: [EXTRA_SRC],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: EXTRA_OUT,
      nodePaths: [EXT_NM],
      logLevel: "error",
    });
    const extraMod = require(EXTRA_OUT);
    const extraTools = new Map(
      extraMod.createKiroExtraTools().map((t) => [t.name, t]),
    );
    const extraNames = [
      "read_code",
      "createHook",
      "update_session_information",
      "create_artifact",
    ];
    for (const name of extraNames) {
      const tool = extraTools.get(name);
      const spec = specByName.get(name);
      if (!tool || !spec) {
        fail++;
        console.log(`  FAIL ${name} tool or kiro spec missing`);
        continue;
      }
      if (tool.description === spec.description) {
        pass++;
        console.log(`  PASS ${name} description matches kiro.txt verbatim`);
      } else {
        fail++;
        console.log(`  FAIL ${name} description mismatch`);
        const a = tool.description.split("\n"),
          b = spec.description.split("\n");
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            console.log(`    L${i + 1} O:${JSON.stringify(a[i])}`);
            console.log(`    L${i + 1} K:${JSON.stringify(b[i])}`);
          }
        }
      }
      // field names + order + per-field description + required array
      let sh = tool.schema;
      while (sh && !sh.shape && sh._def)
        sh = sh._def.schema || sh._def.innerType;
      const gotFields = Object.keys((sh && sh.shape) || {});
      const wantFields = Object.keys(spec.inputSchema.json.properties || {});
      if (JSON.stringify(gotFields) === JSON.stringify(wantFields)) {
        pass++;
        console.log(`  PASS ${name} schema fields + order match kiro.txt`);
      } else {
        fail++;
        console.log(
          `  FAIL ${name} schema fields O:${gotFields} K:${wantFields}`,
        );
      }
      const gotRequired = gotFields.filter(
        (f) => sh.shape[f] && !sh.shape[f].isOptional(),
      );
      const wantRequired = spec.inputSchema.json.required || [];
      if (JSON.stringify(gotRequired) === JSON.stringify(wantRequired)) {
        pass++;
        console.log(`  PASS ${name} schema required matches kiro.txt`);
      } else {
        fail++;
        console.log(
          `  FAIL ${name} schema required O:${gotRequired} K:${wantRequired}`,
        );
      }
      for (const key of gotFields) {
        const f = sh.shape[key];
        const got = f && f.description;
        const want =
          spec.inputSchema.json.properties[key] &&
          spec.inputSchema.json.properties[key].description;
        if (got === want) {
          pass++;
        } else {
          fail++;
          console.log(
            `  FAIL ${name}.${key} param description mismatch O:${JSON.stringify(got)} K:${JSON.stringify(want)}`,
          );
        }
      }
      console.log(
        `       ${name}: ${gotFields.length} param descriptions checked`,
      );
    }
  } catch (e) {
    fail++;
    console.log("  FAIL kiroExtraTools bundle/test error: " + (e && e.message));
  } finally {
    fs.rmSync(EXTRA_OUT, { force: true });
  }

  // invoke_sub_agent: bundle subagents.ts, build the middleware with the exact
  // 5 presets parsed from Kiro's own description, then compare the generated
  // tool name / description / schema against kiro_tools.txt verbatim.
  const SUB_SRC = path.resolve(
    EXT_ROOT,
    "../../../deepagentsjs/libs/deepagents/src/middleware/subagents.ts",
  );
  const SUB_OUT = path.join(
    os.tmpdir(),
    `kiro-subagent-test-${process.pid}.cjs`,
  );
  try {
    await esbuild.build({
      entryPoints: [SUB_SRC],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: SUB_OUT,
      nodePaths: [EXT_NM],
      logLevel: "error",
    });
    const subMod = require(SUB_OUT);
    const subSpec = specByName.get("invoke_sub_agent");
    const wantSubDesc = subSpec.description;
    const body = wantSubDesc
      .split("Available agents:\n")[1]
      .split("\n\nThe agent will execute autonomously")[0];
    const agents = body.split("\n- ").map((chunk, i) => {
      const clean = i === 0 ? chunk.slice(2) : chunk;
      const colon = clean.indexOf(": ");
      return {
        name: clean.slice(0, colon),
        description: clean.slice(colon + 2),
      };
    });
    // Directly verify the 5 presets defined in kiroSubagents.ts match Kiro's
    // agent list verbatim (name + description), not just the generation logic.
    const KIRO_SUB_SRC = path.resolve(
      EXT_ROOT,
      "src/deepagents/kiroSubagents.ts",
    );
    const subSrcText = fs.readFileSync(KIRO_SUB_SRC, "utf8");
    const presetRe =
      /\{\s*name: "([^"]+)",\s*description:\s*"((?:[^"\\]|\\.)*)"[\s\S]*?\n  \}/g;
    const presets = [];
    let pm;
    while ((pm = presetRe.exec(subSrcText)) !== null) {
      // `specOnly: true` agents (e.g. spec-task-execution) are hidden from the
      // normal description by Kiro too (filter `!a.specOnly`), so exclude them.
      if (/specOnly:\s*true/.test(pm[0])) continue;
      presets.push({ name: pm[1], description: JSON.parse(`"${pm[2]}"`) });
    }
    const presetsMatch =
      presets.length === agents.length &&
      presets.every(
        (p, i) =>
          p.name === agents[i].name && p.description === agents[i].description,
      );
    if (presetsMatch) {
      pass++;
      console.log(
        "  PASS kiroSubagents.ts 5 presets match kiro.txt agent list verbatim",
      );
    } else {
      fail++;
      console.log(
        `  FAIL kiroSubagents.ts presets differ from kiro.txt (got ${presets.length}, want ${agents.length})`,
      );
      for (let i = 0; i < Math.max(presets.length, agents.length); i++) {
        const o = presets[i];
        const k = agents[i];
        if (!o || !k || o.name !== k.name || o.description !== k.description) {
          console.log(
            `    [${i}] name O:${JSON.stringify(o && o.name)} K:${JSON.stringify(k && k.name)}`,
          );
          if (o && k && o.description !== k.description) {
            const a = o.description.split("\n");
            const b = k.description.split("\n");
            for (let j = 0; j < Math.max(a.length, b.length); j++) {
              if (a[j] !== b[j]) {
                console.log(`      L${j + 1} O:${JSON.stringify(a[j])}`);
                console.log(`      L${j + 1} K:${JSON.stringify(b[j])}`);
              }
            }
          }
        }
      }
    }

    const fakeModel = {
      bindTools() {
        return this;
      },
      invoke: async () => ({}),
    };
    const subMw = subMod.createSubAgentMiddleware({
      defaultModel: fakeModel,
      defaultTools: [],
      subagents: agents,
      generalPurposeAgent: false,
    });
    const subTool = subMw.tools[0];
    if (subTool.name === "invoke_sub_agent") {
      pass++;
      console.log("  PASS invoke_sub_agent tool name matches kiro.txt");
    } else {
      fail++;
      console.log(`  FAIL invoke_sub_agent tool name (got ${subTool.name})`);
    }
    if (subTool.description === wantSubDesc) {
      pass++;
      console.log(
        "  PASS invoke_sub_agent description matches kiro.txt verbatim",
      );
    } else {
      fail++;
      console.log("  FAIL invoke_sub_agent description mismatch");
      const a = subTool.description.split("\n");
      const b = wantSubDesc.split("\n");
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
          console.log(`    L${i + 1} O:${JSON.stringify(a[i])}`);
          console.log(`    L${i + 1} K:${JSON.stringify(b[i])}`);
        }
      }
    }
    const wantSubProps = subSpec.inputSchema.json.properties || {};
    const wantSubRequired = subSpec.inputSchema.json.required || [];
    let subShape = subTool.schema;
    while (subShape && !subShape.shape && subShape._def) {
      subShape = subShape._def.schema || subShape._def.innerType;
    }
    const gotFields = Object.keys((subShape && subShape.shape) || {});
    const wantFields = [
      "name",
      "prompt",
      "explanation",
      "preset",
      "contextFiles",
      "specTask",
    ];
    if (JSON.stringify(gotFields) === JSON.stringify(wantFields)) {
      pass++;
      console.log(
        "  PASS invoke_sub_agent schema fields + order match kiro.txt",
      );
    } else {
      fail++;
      console.log(
        `  FAIL invoke_sub_agent schema fields O:${gotFields} K:${wantFields}`,
      );
    }
    const gotRequired = gotFields.filter((f) => {
      const field = subShape.shape[f];
      return !field.isOptional();
    });
    if (JSON.stringify(gotRequired) === JSON.stringify(wantSubRequired)) {
      pass++;
      console.log("  PASS invoke_sub_agent schema required matches kiro.txt");
    } else {
      fail++;
      console.log(
        `  FAIL invoke_sub_agent schema required O:${gotRequired} K:${wantSubRequired}`,
      );
    }
    const unwrapZod = (z) => {
      if (!z || typeof z !== "object") return null;
      if (z.shape) return z;
      const d = z._def;
      if (!d) return null;
      for (const k of ["innerType", "schema", "type", "element"]) {
        const found = unwrapZod(d[k]);
        if (found) return found;
      }
      return null;
    };
    for (const key of wantFields) {
      const field = subShape.shape[key];
      const got = field && field.description;
      const want = wantSubProps[key] && wantSubProps[key].description;
      if (got === want) {
        pass++;
        console.log(
          `  PASS invoke_sub_agent.${key} param description matches kiro.txt`,
        );
      } else {
        fail++;
        console.log(
          `  FAIL invoke_sub_agent.${key} param description mismatch`,
        );
        console.log(`    O:${JSON.stringify(got)}`);
        console.log(`    K:${JSON.stringify(want)}`);
      }
    }
    // Nested contextFiles / specTask field descriptions.
    const ctxItems = wantSubProps.contextFiles.items.properties;
    const ctxObj = unwrapZod(subShape.shape.contextFiles);
    const ctxShape = (ctxObj && ctxObj.shape) || {};
    for (const key of ["path", "startLine", "endLine"]) {
      const got = ctxShape[key] && ctxShape[key].description;
      const want = ctxItems[key].description;
      if (got === want) {
        pass++;
        console.log(
          `  PASS invoke_sub_agent.contextFiles.${key} description matches kiro.txt`,
        );
      } else {
        fail++;
        console.log(
          `  FAIL invoke_sub_agent.contextFiles.${key} description mismatch O:${JSON.stringify(got)} K:${JSON.stringify(want)}`,
        );
      }
    }
    const specItemProps = wantSubProps.specTask.anyOf[0].properties;
    const specObj = unwrapZod(subShape.shape.specTask);
    const specObjShape = (specObj && specObj.shape) || {};
    for (const key of ["taskId", "tasksFilePath"]) {
      const got = specObjShape[key] && specObjShape[key].description;
      const want = specItemProps[key].description;
      if (got === want) {
        pass++;
        console.log(
          `  PASS invoke_sub_agent.specTask.${key} description matches kiro.txt`,
        );
      } else {
        fail++;
        console.log(
          `  FAIL invoke_sub_agent.specTask.${key} description mismatch O:${JSON.stringify(got)} K:${JSON.stringify(want)}`,
        );
      }
    }
  } finally {
    fs.rmSync(SUB_OUT, { force: true });
  }

  // Model-facing tool names must be Kiro's raw ids. Display names are only an
  // inbound compatibility layer, mirroring Kiro's id-or-displayName dispatch.
  const adapterSrc = fs.readFileSync(
    path.resolve(DEEP_DIR, "ContinueLLMAdapter.ts"),
    "utf8",
  );
  const webSrc = fs.readFileSync(
    path.resolve(DEEP_DIR, "webSearchTool.ts"),
    "utf8",
  );
  const nameWiringChecks = [
    [
      !adapterSrc.includes("TOOL_ID_TO_DISPLAY"),
      "adapter has no outbound display-name mapping",
    ],
    [
      adapterSrc.includes("name: c.function.name"),
      "OpenAI-format tools keep their raw id",
    ],
    [adapterSrc.includes("name: c.name"), "LangChain tools keep their raw id"],
    [
      adapterSrc.includes(
        "if (fn?.name) fn.name = TOOL_DISPLAY_TO_ID[fn.name] ?? fn.name;",
      ),
      "adapter keeps inbound display-name compatibility",
    ],
    [
      adapterSrc.includes('web_search: "remote_web_search"'),
      "web_search display name maps to remote_web_search",
    ],
    [
      webSrc.includes('name: "remote_web_search"'),
      "web search tool uses Kiro id remote_web_search",
    ],
  ];
  for (const [ok, label] of nameWiringChecks) {
    if (ok) {
      pass++;
      console.log(`  PASS ${label}`);
    } else {
      fail++;
      console.log(`  FAIL ${label}`);
    }
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  process.exitCode = fail === 0 ? 0 : 1;
  fs.rmSync(OUT, { force: true });
})();
