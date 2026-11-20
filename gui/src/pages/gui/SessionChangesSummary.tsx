import { useContext, useEffect, useMemo, useState } from "react";

import { IdeMessengerContext } from "../../context/IdeMessenger";

/**
 * Categorized "files changed this conversation" summary, rendered inline at the
 * end of the chat after the agent finishes answering (Kiro-style review). The
 * data comes from the extension's `getSessionChangedFiles`, which tracks only the
 * files the agent deliberately wrote/edited via write_file / edit_file — build
 * artifacts from `execute` are excluded, so a `mvn`/`npm` build never floods the
 * list.
 *
 * Behaviour:
 *  - empty categories are not shown;
 *  - a category with more than 3 files is collapsed by default (click to expand);
 *  - clicking a file opens it in the editor.
 */

interface Category {
  key: string;
  label: string;
  exts: string[];
}

const CATEGORIES: Category[] = [
  { key: "sql", label: "SQL 文件", exts: ["sql"] },
  {
    key: "frontend",
    label: "前端文件",
    exts: [
      "tsx",
      "jsx",
      "vue",
      "svelte",
      "css",
      "scss",
      "less",
      "html",
      "mjs",
      "cjs",
    ],
  },
  {
    key: "code",
    label: "代码文件",
    exts: [
      "java",
      "kt",
      "kts",
      "py",
      "go",
      "cs",
      "cpp",
      "cc",
      "c",
      "h",
      "hpp",
      "rb",
      "rs",
      "php",
      "ts",
      "js",
      "scala",
      "swift",
      "dart",
      "groovy",
      "lua",
      "pl",
    ],
  },
  {
    key: "config",
    label: "配置/文档",
    exts: [
      "md",
      "markdown",
      "yaml",
      "yml",
      "toml",
      "properties",
      "ini",
      "env",
      "xml",
      "json",
      "cfg",
      "conf",
      "txt",
    ],
  },
  { key: "other", label: "其他文件", exts: [] },
];

function classify(filepath: string): string {
  const ext = filepath.split(".").pop()?.toLowerCase() ?? "";
  for (const cat of CATEGORIES) {
    if (cat.exts.includes(ext)) return cat.key;
  }
  return "other";
}

function shortName(filepath: string): string {
  const parts = filepath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 2) return filepath;
  return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
}

export function SessionChangesSummary({
  visible,
  sessionKey,
}: {
  visible: boolean;
  sessionKey: string;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const [files, setFiles] = useState<string[] | null>(null);

  useEffect(() => {
    if (!visible) {
      return;
    }
    let cancelled = false;
    ideMessenger
      .request("getSessionChangedFiles", { sessionId: sessionKey || undefined })
      .then((result: any) => {
        if (cancelled) return;
        setFiles(Array.isArray(result?.content) ? result.content : []);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, sessionKey, ideMessenger]);

  const groups = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const f of files ?? []) {
      const key = classify(f);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(f);
    }
    return map;
  }, [files]);

  if (!files || files.length === 0) {
    return null;
  }

  return (
    <div className="session-changes-summary">
      <div className="session-changes-title">
        本次对话改动的文件（{files.length}）
      </div>
      {CATEGORIES.map((cat) => {
        const list = groups.get(cat.key);
        if (!list || list.length === 0) return null;
        return (
          <FileGroup
            key={cat.key}
            label={cat.label}
            files={list}
            onOpen={(f) => ideMessenger.post("openFile", { path: f })}
          />
        );
      })}
    </div>
  );
}

function FileGroup({
  label,
  files,
  onOpen,
}: {
  label: string;
  files: string[];
  onOpen: (path: string) => void;
}) {
  const [open, setOpen] = useState(files.length <= 3);
  const shown = open ? files : files.slice(0, 3);

  return (
    <div className="session-changes-group">
      <div
        className="session-changes-group-head"
        onClick={() => files.length > 3 && setOpen((o) => !o)}
        title={files.length > 3 ? (open ? "收起" : "展开") : undefined}
      >
        <span className="session-changes-group-label">
          {label}（{files.length}）
        </span>
        {files.length > 3 && (
          <span className="session-changes-toggle">
            {open ? "收起 ▲" : "展开 ▼"}
          </span>
        )}
      </div>
      {shown.map((f, i) => (
        <div
          key={i}
          className="session-changes-file"
          title={f}
          onClick={() => onOpen(f)}
        >
          {shortName(f)}
        </div>
      ))}
    </div>
  );
}
