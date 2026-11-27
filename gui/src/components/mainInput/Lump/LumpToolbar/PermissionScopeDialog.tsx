import { useState } from "react";

export type PermissionScope = "session" | "workspace" | "user";
export type PathPattern = "full" | "parent" | "all";

export interface PermissionChoice {
  pattern: PathPattern;
  scope: PermissionScope;
  trustedDir: string;
}

export interface PermissionScopeRequest {
  toolName: string;
  path: string;
  onConfirm: (choice: PermissionChoice) => void;
  onCancel: () => void;
}

interface PathOption {
  value: PathPattern;
  label: string;
  trustedDir: string;
}

/** Kiro shows display titles in the approval header, not raw tool ids. */
function toKiroTitle(name: string): string {
  const aliases: Record<string, string> = {
    list_directory: "List Directory",
    read_file: "Read File",
    read_files: "Read Files",
    file_search: "File Search",
    glob: "File Search",
    grep_search: "Grep Search",
    grep: "Grep Search",
    fs_write: "Write File",
    fs_append: "Append to File",
    str_replace: "Replace in File",
    delete_file: "Delete File",
  };
  return (
    aliases[name] ??
    name
      .split("_")
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ")
  );
}

/**
 * Kiro-style permission panel for a single file-access approval. It replaces
 * the plain Approve/Reject card for single path actions. Path / Apply-to are
 * always visible; "Always Allow" applies the selected path pattern and scope.
 * Apply-to defaults to "This session", so the first approval remembers the
 * choice for the rest of the session.
 * DOM reference: kiro_ref/dom_auth.html `.session-view-input`.
 */
function buildPathOptions(rawPath: string): PathOption[] {
  const normalized = (rawPath || ".").replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = normalized.lastIndexOf("/");
  const parent = idx > 0 ? normalized.slice(0, idx) : "";
  const parentPattern = parent ? `${parent}/**` : "**";

  const options: PathOption[] = [
    { value: "full", label: normalized, trustedDir: normalized },
    { value: "parent", label: parentPattern, trustedDir: parent || "**" },
    { value: "all", label: "**", trustedDir: "**" },
  ];
  const seen = new Set<string>();
  return options.filter((option) => {
    if (seen.has(option.label)) return false;
    seen.add(option.label);
    return true;
  });
}

export function PermissionScopeDialog({
  toolName,
  path,
  onConfirm,
  onCancel,
}: PermissionScopeRequest) {
  const options = buildPathOptions(path);
  const [pattern, setPattern] = useState<PathPattern>("full");
  const [scope, setScope] = useState<PermissionScope>("session");

  const current = options.find((o) => o.value === pattern) ?? options[0];

  return (
    <div
      className="agent-interaction-panel"
      data-variant="call-to-action"
      data-testid="kiro-permission-scope-dialog"
    >
      <div className="agent-interaction-panel-content-container">
        <div className="agent-interaction-panel-header">
          <span className="agent-interaction-panel-icon" />
          <span className="agent-interaction-panel-title">
            Your approval is required to continue: {toKiroTitle(toolName)}
          </span>
        </div>
        <div className="agent-interaction-panel-content">
          <div className="permission-request">
            <div className="permission-request-confirm">
              <div className="permission-request-field">
                <span className="permission-request-field-label">Path</span>
                <select
                  className="select-trigger permission-request-pattern-select"
                  aria-label="File path pattern to always allow or deny"
                  value={pattern}
                  onChange={(e) => setPattern(e.target.value as PathPattern)}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="permission-request-field">
                <span className="permission-request-field-label">Apply to</span>
                <select
                  className="select-trigger"
                  aria-label="Where the always allow or deny decision applies"
                  value={scope}
                  onChange={(e) => setScope(e.target.value as PermissionScope)}
                >
                  <option value="user">All workspaces</option>
                  <option value="workspace">This workspace</option>
                  <option value="session">This session</option>
                </select>
              </div>
            </div>

            <div className="permission-request-actions">
              <button
                type="button"
                className="kiro-button"
                data-variant="primary"
                data-default="true"
                onClick={() =>
                  onConfirm({
                    pattern,
                    scope,
                    trustedDir: current.trustedDir,
                  })
                }
              >
                Always Allow
              </button>
              <button
                type="button"
                className="kiro-button"
                data-severity="negative"
                data-variant="outline"
                onClick={onCancel}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
