import * as vscode from "vscode";

/**
 * Kiro-style session-start file tree (mirrors Kiro's FileTreeSerializer
 * ve3/E5/Ie2/ke3, async variant for the GUI's micatGetFileTree RPC):
 *  1. Explicitly expand every directory on the open-file ancestor chain.
 *  2. BFS-discover closed directories (fe3 filter) until `target` entries are
 *     open.
 *  3. Large dirs (>= 50 children) list only the first 30 + a summary.
 *  4. Final hard cap of 8000 chars.
 * Names are relative to the parent (root declared once) to save the prompt
 * budget that repeating long Windows paths would waste.
 */
const MAX_ENTRIES = 500;
const LARGE_DIR = 50;
const LARGE_SHOW = 30;
const MAX_CHARS = 8000;
// Kiro's A4 directory exclusion list (bundle @176926-176955), plus our `tmp`.
const EXCLUDED_DIRS = new Set([
  ".git",
  ".svn",
  ".vscode",
  ".idea",
  ".vs",
  "venv",
  ".venv",
  "env",
  ".env",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "bin",
  ".pytest_cache",
  ".vscode-test",
  ".continue",
  "__pycache__",
  "site-packages",
  ".gradle",
  ".mvn",
  ".cache",
  "gems",
  "vendor",
  ".next",
  ".kiro",
  ".micat", // our own config/steering dir (Kiro excludes .kiro the same way)
  "tmp", // scratch/offload logs: noise in the tree
]);
// Kiro's k4 file glob list (bundle @176847-176925), applied via fe3's endsWith
// check. Matching files are dropped from the tree before the entry budget.
const IGNORED_FILE_SUFFIXES = [
  ".ds_store",
  "-lock.json",
  ".lock",
  ".log",
  ".ttf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".mp4",
  ".svg",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".dmg",
  ".tgz",
  ".rar",
  ".7z",
  ".exe",
  ".dll",
  ".obj",
  ".o",
  ".o.d",
  ".a",
  ".lib",
  ".so",
  ".dylib",
  ".ncb",
  ".sdf",
  ".woff",
  ".woff2",
  ".eot",
  ".cur",
  ".avi",
  ".mpg",
  ".mpeg",
  ".mov",
  ".mp3",
  ".mkv",
  ".webm",
  ".jar",
  ".onnx",
  ".parquet",
  ".pqt",
  ".wav",
  ".webp",
  ".db",
  ".sqlite",
  ".wasm",
  ".plist",
  ".profraw",
  ".gcda",
  ".gcno",
  "go.sum",
  ".env",
  ".gitignore",
  ".gitkeep",
  ".continueignore",
  ".kiroignore",
  ".cursorignore",
  "config.json",
  ".csv",
  ".uasset",
  ".pdb",
  ".bin",
  ".chat",
  ".swp",
  ".pag",
  ".jsonl",
  ".eslintcache",
  ".ts.map",
  ".js.map",
  ".d.ts",
];
const treeFileIgnored = (name: string): boolean => {
  const lower = name.toLowerCase();
  return IGNORED_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
};

interface TreeNode {
  name: string;
  uri: vscode.Uri;
  isDir: boolean;
  status: "expanded" | "closed";
  children: TreeNode[];
  summary?: string;
}

export async function buildMicatFileTree(
  root: vscode.Uri,
  forceExpand: Set<string> = new Set(),
): Promise<string> {
  const treeRoot: TreeNode = {
    name: ".",
    uri: root,
    isDir: true,
    status: "closed",
    children: [],
  };
  let openCount = 0;

  const expandable = (node: TreeNode): boolean => {
    if (!node.isDir || node.status !== "closed") return false;
    const n = node.name.toLowerCase();
    if (n.startsWith(".")) return false;
    return !EXCLUDED_DIRS.has(n);
  };

  const expandNode = async (node: TreeNode, force = false): Promise<void> => {
    if (node.status === "expanded") return;
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(node.uri);
    } catch {
      node.status = "expanded";
      return;
    }
    entries.sort((a, b) => {
      const aDir = a[1] === vscode.FileType.Directory;
      const bDir = b[1] === vscode.FileType.Directory;
      if (aDir !== bDir) return aDir ? -1 : 1;
      return a[0].localeCompare(b[0]);
    });
    const filtered = entries.filter(
      ([name, type]) =>
        type === vscode.FileType.Directory || !treeFileIgnored(name),
    );
    const summarize = filtered.length >= LARGE_DIR && !force;
    const shown = summarize ? filtered.slice(0, LARGE_SHOW) : filtered;
    const hidden = filtered.length - shown.length;
    node.children = shown.map(([name, type]) => ({
      name,
      uri: vscode.Uri.joinPath(node.uri, name),
      isDir: type === vscode.FileType.Directory,
      status: "closed",
      children: [],
    }));
    if (hidden > 0) {
      node.summary = `${filtered.length} entries — first ${LARGE_SHOW} shown, ${hidden} more (use list_directory)`;
    }
    node.status = "expanded";
    openCount += shown.length;
  };

  const expandPath = async (dir: string): Promise<void> => {
    const rel = dir.startsWith(root.fsPath)
      ? dir.slice(root.fsPath.length).replace(/^[\\/]/, "")
      : "";
    let node = treeRoot;
    if (node.status === "closed") await expandNode(node, true);
    for (const part of rel.split(/[\\/]/).filter(Boolean)) {
      const child = node.children.find((c) => c.isDir && c.name === part);
      if (!child) break;
      await expandNode(child, true);
      node = child;
    }
  };
  for (const dir of forceExpand) {
    await expandPath(dir);
  }

  // Root is named "." - expandable() skips dot-names, so expand it first.
  await expandNode(treeRoot, true);

  for (let i = 0; i < MAX_ENTRIES && openCount < MAX_ENTRIES; i++) {
    const queue: TreeNode[] = [treeRoot];
    let target: TreeNode | undefined;
    while (queue.length > 0) {
      const node = queue.shift()!;
      if (expandable(node)) {
        target = node;
        break;
      }
      queue.push(...node.children);
    }
    if (!target) break;
    await expandNode(target);
  }

  const lines: string[] = [];
  const serialize = (node: TreeNode, indent: string): void => {
    for (const child of node.children) {
      if (!child.isDir) {
        lines.push(`${indent}<file name='${child.name}' />`);
      } else if (child.status === "expanded") {
        lines.push(`${indent}<folder name='${child.name}'>`);
        if (child.summary) {
          lines.push(`${indent}  <summary>${child.summary}</summary>`);
        }
        serialize(child, indent + "  ");
        lines.push(`${indent}</folder>`);
      } else {
        lines.push(`${indent}<folder name='${child.name}' closed />`);
      }
    }
  };
  lines.push(`<fileTree root='${root.fsPath}'>`, `<folder name='.'>`);
  serialize(treeRoot, "  ");
  lines.push("</folder>", "</fileTree>");
  let tree = lines.join("\n");
  if (tree.length > MAX_CHARS) {
    tree =
      tree.substring(0, MAX_CHARS) +
      "\n... (truncated, use listDirectory to explore)";
  }
  return tree;
}
