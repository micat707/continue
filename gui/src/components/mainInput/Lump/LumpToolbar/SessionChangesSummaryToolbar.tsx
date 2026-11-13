import { useContext, useEffect, useState } from "react";

import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { ReviewChangesCard } from "./ReviewChangesCard";

interface ChangedFile {
  filepath: string;
  originalContent?: string;
  newContent?: string;
}

/**
 * End-of-session "what did we change" summary. Shown when the agent is idle
 * (nothing streaming / pending) and the workspace has changes. It asks the
 * extension for every changed file (one record per file — multiple edits to the
 * same file are already collapsed into a single git resource) and lets the user
 * open each one (or all at once) in the VS Code multi-file "Changes" editor.
 *
 * The list is computed by the application from git state, not by the LLM, so it
 * is accurate and deterministic regardless of what the model "remembers".
 */
export function SessionChangesSummaryToolbar() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [files, setFiles] = useState<ChangedFile[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    ideMessenger
      .request("getChangedFiles", {})
      .then((result) => {
        if (cancelled) {
          return;
        }
        // `request` resolves the full message envelope ({ status, content }),
        // not the payload itself — unwrap it here.
        if (result.status === "error") {
          setFiles([]);
          return;
        }
        setFiles(Array.isArray(result.content) ? result.content : []);
      })
      .catch(() => {
        if (!cancelled) {
          setFiles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ideMessenger]);

  // Loading: keep the area empty to avoid a flash of the settings toolbar.
  if (files === null) {
    return null;
  }

  // No changes: render nothing — the settings shortcuts bar was removed on
  // purpose (configuration lives in the top-right header), and the bordered
  // Lump container hides itself when empty.
  if (files.length === 0) {
    return null;
  }

  const showOne = (file: ChangedFile) =>
    ideMessenger.post("showChanges", {
      title: "Session changes",
      files: [file],
    });

  const showAll = () =>
    ideMessenger.post("showChanges", {
      title: `Session changes (${files.length})`,
      files,
    });

  return (
    <ReviewChangesCard
      title={`Session changes (${files.length} files)`}
      items={files.map((file, index) => ({
        id: file.filepath || `changed-${index}`,
        label:
          file.originalContent && file.originalContent.length
            ? "modified"
            : "created",
        filename: file.filepath,
        actions: (
          <button
            type="button"
            className="kiro-button"
            data-size="small"
            data-variant="secondary"
            onClick={() => showOne(file)}
          >
            <i className="kiro-icon codicon codicon-eye" data-size="small" />
            View
          </button>
        ),
      }))}
      footer={{
        viewChangesLabel: `View changes (${files.length})`,
        onViewChanges: showAll,
        cancelLabel: "Dismiss",
        onCancel: () => setFiles([]),
      }}
    />
  );
}
