/**
 * Bridge between the GUI Tools-page policies (`uiSlice.toolSettings`) and the
 * DeepAgent permission engine.
 *
 * The GUI is the single source of truth for per-tool decisions. It pushes its
 * `toolSettings` here via the `deepAgent/syncToolSettings` message; this module
 * translates them into a PermissionConfig layer that DeepAgent's
 * `recomputePolicy()` merges each turn. This way, changing a tool's dropdown
 * on the Tools page immediately governs DeepAgent's HITL behaviour, without
 * touching DeepAgent's own three-layer permission settings UI.
 */

import type { ToolPolicy } from "@continuedev/terminal-security";
import type { PermissionConfig, PermissionAction } from "./permissions";

/**
 * GUI tool name → DeepAgent tool name.
 *
 * After consolidation the GUI tool list IS generated from DeepAgent, so most
 * of these are now identity mappings. The legacy Continue names are kept as
 * aliases for users with old `toolSettings` in localStorage — without them a
 * previously-configured policy would be silently lost on upgrade.
 */
const GUI_TO_DEEPAGENT_TOOL: Record<string, string> = {
  read_file: "read_file",
  read_file_range: "read_file",
  create_new_file: "fs_write",
  edit_existing_file: "str_replace",
  single_find_and_replace: "str_replace",
  multi_edit: "str_replace",
  run_terminal_command: "execute_pwsh",
  grep_search: "grep_search",
  file_glob_search: "file_search",
  ls: "list_directory",
  search_web: "web_search",
  fetch_url_content: "web_fetch",
  // New (post-consolidation) names — identity mappings.
  fs_write: "fs_write",
  fs_append: "fs_append",
  append_lines: "append_lines",
  str_replace: "str_replace",
  execute_pwsh: "execute_pwsh",
  web_search: "web_search",
  web_fetch: "web_fetch",
  user_input: "user_input",
  list_directory: "list_directory",
  file_search: "file_search",
};

/** ToolPolicy (GUI) → PermissionAction (DeepAgent). */
function policyToAction(policy: ToolPolicy): PermissionAction {
  switch (policy) {
    case "allowedWithoutPermission":
      return "allow";
    case "disabled":
      return "deny";
    case "allowedWithPermission":
    default:
      return "ask";
  }
}

let syncedToolSettings: Record<string, ToolPolicy> = {};

/** Called by VsCodeMessenger on `deepAgent/syncToolSettings`. */
export function setSyncedToolSettings(
  settings: Record<string, ToolPolicy>,
): void {
  syncedToolSettings = settings ?? {};
}

/**
 * Build a PermissionConfig layer from the GUI policies, for `mergeRules` to
 * consume. Only GUI names with a known DeepAgent counterpart are emitted;
 * MCP tools and DeepAgent-only tools keep their own rules.
 *
 * `inside` policies go to trustRules, `outside` to untrustRules with a
 * conservative action for write/execute tools (the engine's own red lines in
 * resolveAction()/resolveExecuteAction() still apply on top).
 */
export function getGuiPolicyLayer(): PermissionConfig {
  const trustRules: Array<{ tool: string; action: PermissionAction }> = [];
  const untrustRules: Array<{ tool: string; action: PermissionAction }> = [];
  for (const [guiName, policy] of Object.entries(syncedToolSettings)) {
    const deepAgentName = GUI_TO_DEEPAGENT_TOOL[guiName];
    if (!deepAgentName) continue;
    const action = policyToAction(policy);
    trustRules.push({ tool: deepAgentName, action });
    // Outside a trusted dir, never auto-allow a GUI "allow": downgrade to ask.
    // (The engine already enforces this red line; we mirror it here so the
    // layer itself is safe even before mergeRules applies its guards.)
    untrustRules.push({
      tool: deepAgentName,
      action: action === "allow" ? "ask" : action,
    });
  }
  return { trustedDirs: [], trustRules, untrustRules, executeAllowlist: [] };
}

/** Diagnostic: how many GUI policies were successfully mapped. */
export function getSyncedPolicyCount(): number {
  return Object.keys(syncedToolSettings).filter(
    (name) => name in GUI_TO_DEEPAGENT_TOOL,
  ).length;
}
