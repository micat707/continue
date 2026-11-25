/**
 * Kiro-aligned disk-backed artifact store.
 *
 * Mirrors extension.js artifact-store module (@10740339-10746965):
 *  - root = globalStorageUri/artifacts (set via setArtifactStoreRoot)
 *  - per-session dir `<sanitized-session>-<sha256(session).slice(0,8)>`
 *  - manifest.json is the source of truth; payload files live beside it
 *  - readManifest validates every entry's file exists (drops stale entries)
 *  - per-session in-memory lock serializes manifest writes
 *  - optional watcher on manifest.json files for multi-window sync
 */

import * as fs from "fs/promises";
import * as path from "path";
import * as crypto from "crypto";
import type { ArtifactPayload } from "./kiroExtraTools";

type ArtifactRecord = ArtifactPayload & { path: string };

let storeRoot: string | undefined;
const locks = new Map<string, Promise<unknown>>();
const knownSessions = new Set<string>();
type ChangeListener = (sessionId: string, artifacts: ArtifactPayload[]) => void;
const listeners = new Set<ChangeListener>();

export function setArtifactStoreRoot(globalStoragePath: string): void {
  storeRoot = path.join(globalStoragePath, "artifacts");
  void fs.mkdir(storeRoot, { recursive: true }).catch(() => {});
}

function requireRoot(): string {
  if (!storeRoot) throw new Error("Artifact store is not initialized.");
  return storeRoot;
}

export function sessionDir(sessionId: string): string {
  if (!sessionId) throw new Error("Invalid session id: (empty)");
  const sanitized = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const hash = crypto
    .createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 8);
  return path.join(requireRoot(), `${sanitized}-${hash}`);
}

function manifestPath(sessionId: string): string {
  return path.join(sessionDir(sessionId), "manifest.json");
}

function isUnderStore(filePath: string): boolean {
  const rel = path.relative(requireRoot(), filePath);
  return (
    !path.isAbsolute(rel) &&
    !rel.split(path.sep).includes("..") &&
    rel.length > 0
  );
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/** Serialize async writes per session (Kiro aMs). */
async function withLock<T>(
  sessionId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(sessionId);
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    return fn();
  })();
  const sentinel = run.catch(() => {});
  locks.set(sessionId, sentinel);
  try {
    return await run;
  } finally {
    if (locks.get(sessionId) === sentinel) locks.delete(sessionId);
  }
}

function isRecord(v: unknown): v is ArtifactRecord {
  if (!v || typeof v !== "object") return false;
  const o = v as any;
  return (
    typeof o.id === "string" &&
    typeof o.title === "string" &&
    typeof o.kind === "string" &&
    typeof o.path === "string"
  );
}

function toPayload(r: ArtifactRecord): ArtifactPayload {
  const { path: _filePath, ...rest } = r;
  return { ...rest, filePath: r.path || r.filePath };
}

/** Read manifest and drop entries whose payload file no longer exists. */
async function readManifest(sessionId: string): Promise<ArtifactRecord[]> {
  try {
    const raw = await fs.readFile(manifestPath(sessionId), "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const valid = arr.filter(isRecord);
    const results = await Promise.all(
      valid.map(async (r) => ({
        r,
        ok: isUnderStore(r.path) && (await exists(r.path)),
      })),
    );
    return results.filter((x) => x.ok).map((x) => x.r);
  } catch {
    return [];
  }
}

async function writeManifest(
  sessionId: string,
  records: ArtifactRecord[],
): Promise<void> {
  await fs.mkdir(sessionDir(sessionId), { recursive: true });
  await fs.writeFile(
    manifestPath(sessionId),
    JSON.stringify(records, null, 2),
    "utf8",
  );
  notify(sessionId, records.map(toPayload));
}

function notify(sessionId: string, artifacts: ArtifactPayload[]): void {
  for (const l of listeners) {
    try {
      l(sessionId, artifacts);
    } catch {
      /* ignore listener error */
    }
  }
}

/** Watch manifest.json files for changes made by other windows/processes. */
export function startArtifactWatcher(subscriptions: {
  push(x: unknown): void;
}): void {
  if (!storeRoot) return;
  // Lazy require to avoid a static vscode import in tests/core.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const vscode = require("vscode") as typeof import("vscode");
  const pattern = new vscode.RelativePattern(storeRoot, "*/manifest.json");
  const watcher = vscode.workspace.createFileSystemWatcher(
    pattern,
    false,
    false,
    true,
  );
  subscriptions.push(watcher);
  const onChange = async (uri: import("vscode").Uri) => {
    const dirName = path.basename(path.dirname(uri.fsPath));
    let sid: string | undefined;
    for (const s of knownSessions) {
      if (path.basename(sessionDir(s)) === dirName) {
        sid = s;
        break;
      }
    }
    if (sid) {
      const records = await readManifest(sid);
      notify(sid, records.map(toPayload));
    }
  };
  watcher.onDidCreate((u) => void onChange(u));
  watcher.onDidChange((u) => void onChange(u));
}

export function onArtifactsChanged(listener: ChangeListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const EXT_BY_KIND: Record<string, string> = {
  markdown: "md",
  image: "png",
  svg: "svg",
  mermaid: "mmd",
  html: "html",
  pdf: "pdf",
  code: "txt",
  office: "bin",
};

/**
 * Create an artifact: copy/write the payload into the session dir, append to
 * manifest. Returns the payload with real `filePath` + `kiro-artifact://` URL.
 */
export async function createArtifact(input: {
  sessionId: string;
  title: string;
  kind: string;
  content?: string;
  sourcePath?: string;
  format?: string;
  toRealPath?: (p: string) => string;
}): Promise<ArtifactPayload> {
  if (!input.sessionId) throw new Error("An artifact needs a session id.");
  const title = input.title.trim();
  if (!title) throw new Error("An artifact needs a title.");
  const ext = input.format || EXT_BY_KIND[input.kind] || "bin";
  const id = crypto.randomUUID();

  return withLock(input.sessionId, async () => {
    const dir = sessionDir(input.sessionId);
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${id}.${ext}`);
    let content = input.content ?? "";
    if (input.sourcePath) {
      const real = input.toRealPath
        ? input.toRealPath(input.sourcePath)
        : input.sourcePath;
      await fs.copyFile(real, filePath);
      if (["markdown", "svg", "mermaid", "html", "code"].includes(input.kind)) {
        content = await fs.readFile(filePath, "utf8");
      }
    } else {
      await fs.writeFile(filePath, content, "utf8");
    }
    const payload: ArtifactPayload = {
      id,
      title,
      kind: input.kind,
      content,
      filePath,
      ...(input.format ? { format: input.format } : {}),
      url: `kiro-artifact://${id}`,
      sessionId: input.sessionId,
      createdAt: new Date().toISOString(),
    };
    const records = await readManifest(input.sessionId);
    records.push({ ...payload, path: filePath });
    await writeManifest(input.sessionId, records);
    knownSessions.add(input.sessionId);
    return payload;
  });
}

/** List artifacts (rebuild GUI state after reload). */
export async function listArtifacts(
  sessionId?: string,
): Promise<ArtifactPayload[]> {
  if (!sessionId) return [];
  knownSessions.add(sessionId);
  const records = await readManifest(sessionId);
  return records.map(toPayload);
}

/** Dismiss an artifact: remove from manifest + delete payload file. */
export async function deleteArtifact(
  id: string,
  sessionId?: string,
): Promise<boolean> {
  if (!sessionId) return false;
  return withLock(sessionId, async () => {
    const records = await readManifest(sessionId);
    const found = records.find((r) => r.id === id);
    if (!found) return false;
    const remaining = records.filter((r) => r.id !== id);
    await writeManifest(sessionId, remaining);
    try {
      if (isUnderStore(found.path)) await fs.unlink(found.path);
    } catch {
      /* best effort */
    }
    return true;
  });
}

/** Delete a whole session's artifacts. */
export async function deleteSessionArtifacts(sessionId: string): Promise<void> {
  await withLock(sessionId, async () => {
    try {
      await fs.rm(sessionDir(sessionId), { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });
  knownSessions.delete(sessionId);
  notify(sessionId, []);
}
