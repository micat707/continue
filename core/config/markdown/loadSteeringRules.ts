import {
  ConfigValidationError,
  markdownToRule,
} from "@continuedev/config-yaml";
import { IDE, RuleWithSource } from "../..";
import { walkDirs } from "../../indexing/walkDir";
import { findUriInDirs } from "../../util/uri";

const STEERING_DIR_SEGMENT = "/.micat/steering/";

/**
 * Steering files (`.micat/steering/**\/*.md`) are MicatCode's equivalent of
 * Kiro's steering docs. They are loaded as *always-apply* rules so they are
 * automatically injected into the system prompt for every chat
 * (see core/llm/rules/getSystemMessageWithRules + gui constructMessages.ts).
 */
export async function loadSteeringRules(ide: IDE): Promise<{
  rules: RuleWithSource[];
  errors: ConfigValidationError[];
}> {
  const errors: ConfigValidationError[] = [];
  const rules: RuleWithSource[] = [];

  try {
    const workspaceDirs = await ide.getWorkspaceDirs();
    if (workspaceDirs.length === 0) {
      return { rules, errors };
    }

    const allFiles = await walkDirs(ide);
    const steeringFiles = allFiles.filter(
      (file) =>
        file.toLowerCase().includes(STEERING_DIR_SEGMENT) &&
        file.toLowerCase().endsWith(".md"),
    );

    for (const filePath of steeringFiles) {
      try {
        const content = await ide.readFile(filePath);
        const { relativePathOrBasename, foundInDir, uri } = findUriInDirs(
          filePath,
          workspaceDirs,
        );
        if (!foundInDir) {
          continue;
        }
        const rule = markdownToRule(
          content,
          { uriType: "file", fileUri: uri },
          relativePathOrBasename,
        );
        rules.push({
          ...rule,
          source: "micat-steering",
          sourceFile: filePath,
          alwaysApply: true,
        });
      } catch (e) {
        errors.push({
          fatal: false,
          message: `Failed to load steering file ${filePath}: ${
            e instanceof Error ? e.message : e
          }`,
        });
      }
    }
  } catch {
    // Workspace not open / walk failed — steering is optional, ignore.
  }

  return { rules, errors };
}
