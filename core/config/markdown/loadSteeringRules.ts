import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  ConfigValidationError,
  markdownToRule,
  parseMarkdownRule,
  RuleFrontmatter,
} from "@continuedev/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { localPathToUri, localPathOrUriToPath } from "../../util/pathToUri";

const MICAT_DIR_NAME = ".micat";
const STEERING_DIR_NAME = "steering";
const AGENTS_MD_FILENAME = "AGENTS.md";
const STEERING_SOURCE = "micat-steering";
const MAX_STEERING_WALK_DEPTH = 5;

/** Kiro-style steering frontmatter fields (in addition to Continue-native ones) */
type KiroSteeringFrontmatter = RuleFrontmatter & {
  inclusion?: "always" | "fileMatch" | "manual" | "auto" | null;
  fileMatchPattern?: string | string[] | null;
};

type SteeringScope = "workspace" | "global";

/**
 * Wraps steering file content the same way Kiro does before injecting it into
 * the system prompt (Kiro `He2({ doc })`): a header with the file display name
 * and scope label, guidance text, and the rule body inside a <user-rule> block.
 */
function wrapSteeringContent(
  displayName: string,
  scope: SteeringScope,
  content: string,
): string {
  const scopeLabel = scope === "global" ? " [Global]" : " [Workspace]";
  const precedenceNote =
    scope === "workspace"
      ? "\n  Workspace-level rules take precedence over global-level rules when conflicts exist."
      : "";
  // Wrapper text mirrors the exact variant Kiro sends on the wire
  // (observed in kiro_session.log as the first conversation turn):
  return `## Included Rules (${displayName})${scopeLabel}

  [System-injected rules — apply these constraints to your work, but continue answering the user's request. Do not acknowledge or summarize these rules in your response.]
  Steering outranks stored memories or learnings whenever they conflict.${precedenceNote}

<user-rule id=${displayName}>
\`\`\`
${content.trim()}
\`\`\`
</user-rule>`;
}

/** Recursively find *.md files in a steering directory (bounded depth). */
function findMarkdownFiles(dirPath: string, depth = 0): string[] {
  if (depth > MAX_STEERING_WALK_DEPTH) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMarkdownFiles(fullPath, depth + 1));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Mirrors Kiro: the global steering directory (~/.micat/steering) is
 * auto-created on load so users always have a place to drop global rules.
 */
function ensureGlobalSteeringDir(): string | undefined {
  const dir = path.join(os.homedir(), MICAT_DIR_NAME, STEERING_DIR_NAME);
  try {
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) {
    console.warn(
      `[MicatCode Steering] Failed to create global steering directory ${dir}:`,
      e,
    );
    return undefined;
  }
}

/**
 * Maps a steering file to a RuleWithSource, following Kiro's semantics:
 * - no frontmatter / `inclusion: always` / `inclusion: auto` -> always applied
 * - `inclusion: fileMatch` + `fileMatchPattern` -> applied to matching files
 * - `inclusion: manual` -> not loaded yet (planned, P2)
 * - Continue-native frontmatter fields (alwaysApply / globs / regex) take
 *   precedence over the Kiro-style fields when present.
 * AGENTS.md files ignore frontmatter entirely and are always applied.
 */
function steeringFileToRule(args: {
  content: string;
  displayName: string;
  filePath: string;
  scope: SteeringScope;
  isAgentsMd?: boolean;
}): RuleWithSource | undefined {
  const { content, displayName, filePath, scope, isAgentsMd } = args;
  const { frontmatter, markdown } = parseMarkdownRule(content);
  const fm = frontmatter as KiroSteeringFrontmatter;
  const fileUri = localPathToUri(filePath);
  const wrapped = wrapSteeringContent(displayName, scope, markdown);
  // Workspace and global steering files often share the same file name; give
  // global rules a distinct internal name so Continue's config validation
  // doesn't report "Duplicate rules named ...". The Kiro-style wrapper header
  // still uses the undecorated displayName.
  const ruleName = (base: string) =>
    scope === "global" ? `${base} (global)` : base;

  if (isAgentsMd) {
    // Kiro: AGENTS.md is hard-coded to inclusion "always" and ignores
    // frontmatter entirely.
    return {
      name: ruleName(displayName),
      rule: wrapped,
      alwaysApply: true,
      source: STEERING_SOURCE,
      sourceFile: fileUri,
    };
  }

  // Continue-native fields win when explicitly present
  if (fm.alwaysApply !== undefined || fm.globs !== undefined) {
    const rule = markdownToRule(content, { uriType: "file", fileUri });
    return {
      ...rule,
      name: ruleName(rule.name ?? displayName),
      rule: wrapped,
      source: STEERING_SOURCE,
    };
  }

  switch (fm.inclusion) {
    case undefined:
    case null:
    case "always":
    // "auto" steering rules are treated as "always" until P2
    case "auto":
      return {
        name: ruleName(fm.name ?? displayName),
        rule: wrapped,
        description: fm.description,
        alwaysApply: true,
        source: STEERING_SOURCE,
        sourceFile: fileUri,
      };
    case "fileMatch": {
      const pattern = fm.fileMatchPattern;
      if (pattern === undefined || pattern === null) {
        console.warn(
          `[MicatCode Steering] ${displayName}: "inclusion: fileMatch" has no fileMatchPattern, treating it as always-applied`,
        );
        return {
          name: ruleName(fm.name ?? displayName),
          rule: wrapped,
          description: fm.description,
          alwaysApply: true,
          source: STEERING_SOURCE,
          sourceFile: fileUri,
        };
      }
      return {
        name: ruleName(fm.name ?? displayName),
        rule: wrapped,
        description: fm.description,
        // Deliberately no relativePathForGlobs is passed anywhere: Kiro-style
        // fileMatchPattern is workspace-root-relative and must not be prefixed
        // with the steering file's own directory.
        alwaysApply: false,
        globs: Array.isArray(pattern) ? pattern : [pattern],
        source: STEERING_SOURCE,
        sourceFile: fileUri,
      };
    }
    case "manual":
      // Manual inclusion via # references is planned for P2
      return undefined;
    default:
      console.warn(
        `[MicatCode Steering] ${displayName}: unknown inclusion "${String(
          fm.inclusion,
        )}", treating it as always-applied`,
      );
      return {
        name: ruleName(fm.name ?? displayName),
        rule: wrapped,
        description: fm.description,
        alwaysApply: true,
        source: STEERING_SOURCE,
        sourceFile: fileUri,
      };
  }
}

/**
 * Steering files (`.micat/steering/**\/*.md`) are MicatCode's equivalent of
 * Kiro's steering docs, loaded with Kiro semantics:
 *
 * - Two scopes: workspace `<root>/.micat/steering/` and global
 *   `~/.micat/steering/` (auto-created). Workspace rules come first.
 * - AGENTS.md at each workspace root is loaded as an always-applied,
 *   workspace-scoped steering rule and takes precedence over everything else.
 * - Whether/how a steering file is loaded is decided by its frontmatter
 *   (inclusion: always | fileMatch | manual | auto), not by its file name.
 * - File name is irrelevant apart from display purposes.
 *
 * The resulting rules are injected into the system prompt via
 * core/llm/rules/getSystemMessageWithRules (also used by the GUI's
 * constructMessages), where fileMatch rules are resolved against the files
 * referenced by the current message/context.
 */
export async function loadSteeringRules(ide: IDE): Promise<{
  rules: RuleWithSource[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];
  const rules: RuleWithSource[] = [];

  const loadFile = (
    filePath: string,
    displayName: string,
    scope: SteeringScope,
    isAgentsMd?: boolean,
  ) => {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const rule = steeringFileToRule({
        content,
        displayName,
        filePath,
        scope,
        isAgentsMd,
      });
      if (rule) {
        rules.push(rule);
      }
    } catch (e) {
      errors.push({
        fatal: false,
        message: `Failed to load steering file ${filePath}: ${
          e instanceof Error ? e.message : e
        }`,
      });
      console.warn(`[MicatCode Steering] Failed to load ${filePath}:`, e);
    }
  };

  // 1. AGENTS.md at each workspace root (always, workspace scope, first)
  const workspaceDirs = await ide.getWorkspaceDirs();
  for (const workspaceDir of workspaceDirs) {
    try {
      const wsPath = localPathOrUriToPath(workspaceDir);
      const agentsMdPath = path.join(wsPath, AGENTS_MD_FILENAME);
      if (fs.existsSync(agentsMdPath)) {
        loadFile(agentsMdPath, AGENTS_MD_FILENAME, "workspace", true);
      }
    } catch (e) {
      console.warn(
        `[MicatCode Steering] Failed to resolve workspace dir ${workspaceDir}:`,
        e,
      );
    }
  }

  // 2. Workspace-level steering: <root>/.micat/steering/**/*.md
  for (const workspaceDir of workspaceDirs) {
    try {
      const wsPath = localPathOrUriToPath(workspaceDir);
      const steeringDir = path.join(wsPath, MICAT_DIR_NAME, STEERING_DIR_NAME);
      const files = findMarkdownFiles(steeringDir);
      for (const filePath of files) {
        const displayName = path
          .relative(steeringDir, filePath)
          .replace(/\.md$/i, "");
        loadFile(
          filePath,
          path.basename(filePath) === AGENTS_MD_FILENAME
            ? AGENTS_MD_FILENAME
            : displayName,
          "workspace",
          path.basename(filePath) === AGENTS_MD_FILENAME,
        );
      }
    } catch (e) {
      console.warn(
        `[MicatCode Steering] Failed to load workspace steering from ${workspaceDir}:`,
        e,
      );
    }
  }

  // 3. Global-level steering: ~/.micat/steering/**/*.md (dir auto-created)
  const globalDir = ensureGlobalSteeringDir();
  if (globalDir) {
    const files = findMarkdownFiles(globalDir);
    for (const filePath of files) {
      const displayName = path
        .relative(globalDir, filePath)
        .replace(/\.md$/i, "");
      loadFile(
        filePath,
        path.basename(filePath) === AGENTS_MD_FILENAME
          ? AGENTS_MD_FILENAME
          : displayName,
        "global",
        path.basename(filePath) === AGENTS_MD_FILENAME,
      );
    }
  }

  if (rules.length > 0) {
    console.debug(
      `[MicatCode Steering] Loaded ${rules.length} steering rule(s): ${rules
        .map((r) => `${r.name}${r.alwaysApply === false ? " (fileMatch)" : ""}`)
        .join(", ")}`,
    );
  }

  return { rules, errors };
}
