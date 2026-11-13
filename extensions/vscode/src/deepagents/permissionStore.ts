/**
 * Loading of the DeepAgent permission policy from VS Code settings.
 *
 * The policy lives under the `continue.deepAgent.permissions` setting. Because
 * VS Code merges global + workspace + (folder) scopes automatically, we use
 * `inspect()` to read the GLOBAL and WORKSPACE contributions separately, so the
 * two layers can be merged with the in-memory SESSION layer using the same
 * first-match-wins semantics as the rest of the policy.
 *
 * The SESSION layer is intentionally NOT persisted here — it lives in the
 * DeepAgent wrapper closure (one per chat) so it is lost on restart, matching
 * the product decision that session overrides are ephemeral.
 */
import * as vscode from "vscode";
import { DEFAULT_PERMISSION_CONFIG, PermissionConfig } from "./permissions";

const SETTING_KEY = "deepAgent.permissions";

function clone(cfg: PermissionConfig): PermissionConfig {
  return JSON.parse(JSON.stringify(cfg));
}

/** Global-scope policy (user/remote settings). */
export function loadGlobalConfig(): PermissionConfig {
  const insp = vscode.workspace
    .getConfiguration("continue")
    .inspect<PermissionConfig>(SETTING_KEY);
  return insp?.globalValue ?? clone(DEFAULT_PERMISSION_CONFIG);
}

/**
 * Workspace-scope policy. Reads BOTH:
 *  - `workspaceValue`    → the `.code-workspace` file (or single-root `.vscode/settings.json`)
 *  - `workspaceFolderValue` → each folder's own `.vscode/settings.json`
 * Folder rules are appended AFTER workspace rules, and `mergeRules` lets later
 * entries win per tool key — so a folder's `.vscode/settings.json` overrides
 * the `.code-workspace` file. Null when neither is set.
 */
export function loadWorkspaceConfig(): PermissionConfig | null {
  const insp = vscode.workspace
    .getConfiguration("continue")
    .inspect<PermissionConfig>(SETTING_KEY);
  const ws = insp?.workspaceValue;
  const folder = insp?.workspaceFolderValue;
  if (!ws && !folder) return null;
  return {
    trustedDirs: [...(ws?.trustedDirs ?? []), ...(folder?.trustedDirs ?? [])],
    trustRules: [...(ws?.trustRules ?? []), ...(folder?.trustRules ?? [])],
    untrustRules: [
      ...(ws?.untrustRules ?? []),
      ...(folder?.untrustRules ?? []),
    ],
    executeAllowlist: [
      ...(ws?.executeAllowlist ?? []),
      ...(folder?.executeAllowlist ?? []),
    ],
  };
}
