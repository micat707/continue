/**
 * DeepAgentChatPanel
 * -----------------
 * A self-contained VS Code Webview chat UI for the Deep Agents agent. This is
 * step ⑦: instead of dumping the agent result to an Output channel, we render a
 * real interactive chat that streams the agent's tokens and tool activity.
 *
 * The agent runs in the extension host (node side) via `createDeepAgent`, exactly
 * like the `continue.deepAgentTest` command. We use `agent.streamEvents(..., {
 * version: "v3" })` so we get streaming `messages` (token deltas) and `toolCalls`
 * (input/output/status) that we forward to the webview as `postMessage` events.
 *
 * This deliberately does NOT touch Continue's React GUI — it is a standalone
 * panel we fully control, so it works regardless of the GUI's internals.
 */

import * as vscode from "vscode";
import { randomUUID } from "crypto";
import { Command, MemorySaver } from "@langchain/langgraph";
import { createDeepAgent, type DeepAgent } from "deepagents";
import { HumanMessage, type BaseMessage } from "@langchain/core/messages";

import { ContinueLLMAdapter } from "./ContinueLLMAdapter";
import {
  approvePath,
  buildWorkspaceContext,
  classifyPath,
  createWorkspaceBackend,
  describeRoots,
  getWorkspaceLayout,
  isPathApproved,
  pickRootOverride,
  withApprovedPaths,
} from "./workspaceBackend";
import { createDeepAgentTools } from "./acpToolKit";
import {
  createKiroContextFileResolver,
  kiroPathToReal,
  KIRO_SUBAGENTS,
  SPEC_ORCHESTRATOR_PROMPT,
  SPEC_ORCHESTRATOR_TOOLS,
} from "./kiroSubagents";
import {
  createSpecWorkflowMiddleware,
  SpecWorkflowController,
} from "./specWorkflow";
import { createArtifact } from "./artifactStore";
import { createSpecTaskResolver, setSpecPathResolver } from "./specTools";
import {
  formatExecuteOutput,
  formatToolInput,
  formatToolOutput,
  truncate,
} from "./toolFormat";
import {
  mergeRules,
  resolveExecuteAction,
  type PermissionAction,
} from "./permissions";
import { loadGlobalConfig, loadWorkspaceConfig } from "./permissionStore";
import { getExtensionUri, getNonce } from "../util/vscode";
import { splitUnifiedDiff } from "core/util/unifiedDiff";
import type { ILLM } from "core";

interface WebviewToExtension {
  type:
    | "send"
    | "clear"
    | "pickRoot"
    | "ready"
    | "openFile"
    | "viewDiff"
    | "interruptResponse";
  text?: string;
  path?: string;
  diff?: string;
  decisions?: Array<{
    type: "approve" | "reject" | "edit" | "respond";
    message?: string;
  }>;
}

/**
 * Pull the real unified diff out of an `edit_file` result. The backend appends
 * `buildUnifiedDiff(...)` after the one-line success summary, so everything
 * from the `--- a/` header on is the diff. Returns "" when the backend did not
 * produce one (error, no-op edit, or an oversized file).
 */
function extractUnifiedDiff(output: string): string {
  const match = /\n--- a\/[^\n]*\n\+\+\+ b\//.exec(output);
  return match ? output.slice(match.index + 1).trimEnd() : "";
}

/**
 * Debug logging shared with ContinueLLMAdapter (same channel name resolves to
 * the same OutputChannel instance, so panel and model traffic interleave in
 * chronological order under Output → "DeepAgent Debug").
 */
const debugLog = vscode.window.createOutputChannel("DeepAgent Debug");
function logDebug(...args: unknown[]): void {
  for (const a of args) {
    debugLog.appendLine(typeof a === "string" ? a : JSON.stringify(a));
  }
}

export class DeepAgentChatPanel {
  public static current?: DeepAgentChatPanel;

  private readonly panel: vscode.WebviewPanel;
  private readonly agent: DeepAgent;
  private history: BaseMessage[] = [];
  private busy = false;
  /** Stable per-turn id so an interrupted run can be resumed on the same thread. */
  private threadId?: string;
  /** Paths the user approved via the HITL card; the backend lets these through. */
  private readonly approvedPaths = new Set<string>();
  /** Action requests of the currently pending interrupt (order matches decisions). */
  private pendingActions: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }> = [];
  /** Optional manual override; undefined = follow VS Code workspace folders. */
  private rootOverride?: string;

  private constructor(
    panel: vscode.WebviewPanel,
    llm: ILLM,
    rootOverride?: string,
  ) {
    this.panel = panel;
    this.rootOverride = rootOverride;
    // Spec workflow is OFF by default; only start_spec_workflow activates it.
    const specController = new SpecWorkflowController();

    const adapter = new ContinueLLMAdapter({
      llm,
      // Re-evaluated on every model call so the context follows the live
      // workspace folders, including ones added after this panel opened.
      systemContext: () => buildWorkspaceContext(this.rootOverride),
    });
    // Interrupt (human-in-the-loop) any read/write/edit/delete that targets a
    // path outside the workspace mounts. The run pauses and the webview shows an
    // Approve/Deny card; on resume it continues on the same thread. `when` reads
    // the live rootOverride because the arrow captures this instance.
    const isOutside = (p: unknown): boolean =>
      typeof p === "string" &&
      p.length > 0 &&
      classifyPath(p, this.rootOverride) === "outside" &&
      !isPathApproved(this.approvedPaths, p);
    const outsideWorkspace = (req: any): boolean => {
      const args = req?.toolCall?.args;
      // read_files carries an array of paths; interrupt if any is outside and
      // unapproved. Unknown shapes never stall the run.
      if (Array.isArray(args?.paths)) return args.paths.some(isOutside);
      const p = args?.file_path ?? args?.path;
      // Only interrupt when we can clearly see an out-of-workspace path; an
      // unrecognized request shape must NOT stall the run. A path the user
      // already approved this session is let through without re-prompting.
      return isOutside(p);
    };
    // `delete` is included in case the tool is registered under that name.
    const hitlTools = [
      "read_file",
      "read_files",
      "fs_write",
      "fs_append",
      "str_replace",
      "delete_file",
    ];
    const interruptOn: Record<string, unknown> = {};
    for (const tool of hitlTools) {
      interruptOn[tool] = {
        allowedDecisions: ["approve", "reject"],
        when: outsideWorkspace,
      };
    }
    // `execute` runs an arbitrary shell command on the user's machine. Like the
    // main chat path, it is governed by the HITL middleware: a command pauses on
    // the approval card UNLESS it matches the user's executeAllowlist (auto-run)
    // or the policy is "deny" (hard-blocked by the backend proxy below).
    const mergedPerm = mergeRules(
      loadGlobalConfig(),
      loadWorkspaceConfig(),
      null,
    );
    interruptOn["execute_pwsh"] = {
      allowedDecisions: ["approve", "reject"],
      when: (req: any) => {
        const layout = getWorkspaceLayout(this.rootOverride);
        return (
          resolveExecuteAction(
            mergedPerm,
            req?.toolCall?.args?.command,
            layout.mounts.map((m) => m.realPath),
            layout.mounts.map((m) => m.virtualPath),
          ) === "ask"
        );
      },
    };
    // `control_process` "start" launches an arbitrary shell command in the
    // background — same risk profile as `execute`, so it gets the same approval
    // gate. "stop" / output polling never interrupt.
    interruptOn["control_pwsh_process"] = {
      allowedDecisions: ["approve", "reject"],
      when: (req: any) => {
        if (req?.toolCall?.args?.action !== "start") return false;
        const layout = getWorkspaceLayout(this.rootOverride);
        return (
          resolveExecuteAction(
            mergedPerm,
            req?.toolCall?.args?.command,
            layout.mounts.map((m) => m.realPath),
            layout.mounts.map((m) => m.virtualPath),
          ) === "ask"
        );
      },
    };

    // Tools are natively Kiro-named now (no alias middleware); the batched HITL
    // scan sees the real names, so hitlTools + the execute/control rules above
    // cover every gated tool directly.

    this.agent = createDeepAgent({
      model: adapter,
      systemPrompt:
        "You are a helpful coding assistant. Use the filesystem tools when needed.",
      // Factory runs on every agent turn and reads the live workspace folders,
      // so adding a folder in Explorer takes effect on the next message.
      // The approval wrapper lets through paths the user approved on the
      // HITL card; everything else keeps the workspace containment.
      backend: () =>
        withApprovedPaths(createWorkspaceBackend(this.rootOverride), {
          // Panel path approval is handled entirely by interruptOn above; the
          // proxy's decide is a no-op ("ask" → falls through to the virtual
          // backend unchanged from before).
          decide: () => "ask" as PermissionAction,
          override: this.rootOverride,
          executeDenied: () => resolveExecuteAction(mergedPerm) === "deny",
        }),
      // Background process management tools (control_process / get_process_output /
      // list_processes) — mirror Kiro so dev servers etc. run without blocking.
      // web_search + web_fetch mirror Kiro's search-then-read web workflow.
      tools: createDeepAgentTools({
        surface: "webview",
        sessionId: "deepagent-chat-panel",
        rootOverride: this.rootOverride,
        specController,
        kiroExtraDeps: {
          toRealPath: (p) => kiroPathToReal(p, this.rootOverride),
          workspaceRoot: () =>
            getWorkspaceLayout(this.rootOverride).mounts[0]?.realPath ??
            process.cwd(),
          pushArtifact: (payload) => {
            this.panel.webview.postMessage({ type: "artifact", payload });
          },
          sessionId: "deepagent-chat-panel",
          artifactWriter: createArtifact,
          symbolResolver: async (filePath, content) => {
            const { getSymbolsForFile } = require("core/util/treeSitter");
            const symbols = await getSymbolsForFile(filePath, content);
            return symbols as any;
          },
        },
      }),
      checkpointer: new MemorySaver(),
      interruptOn,
      // Kiro's invoke_sub_agent: expose the 5 preset agents and let contextFiles
      // resolve against this panel's workspace layout. spec-task-execution is
      // specOnly and stays out of the normal "Available agents" description.
      subagents: KIRO_SUBAGENTS,
      contextFileResolver: createKiroContextFileResolver(this.rootOverride),
      specTaskResolver: createSpecTaskResolver((p) =>
        kiroPathToReal(p, this.rootOverride),
      ),
      // Default chat path runs no classifier. Only start_spec_workflow gates
      // entry into the spec workflow + sub-intent/orchestrator handling.
      middleware: [
        createSpecWorkflowMiddleware(specController, {
          orchestratorPrompt: SPEC_ORCHESTRATOR_PROMPT,
          orchestratorToolNames: SPEC_ORCHESTRATOR_TOOLS,
        }),
      ],
    });
    setSpecPathResolver((p) => kiroPathToReal(p, this.rootOverride));

    this.panel.webview.onDidReceiveMessage((m: WebviewToExtension) =>
      this.onMessage(m),
    );
    // Keep the header label in sync when folders are added/removed in Explorer.
    const foldersListener = vscode.workspace.onDidChangeWorkspaceFolders(() =>
      this.postRoots(),
    );
    this.panel.onDidDispose(() => {
      foldersListener.dispose();
      DeepAgentChatPanel.current = undefined;
    });
  }

  static createOrShow(llm: ILLM, rootOverride?: string) {
    const column = vscode.ViewColumn.Beside;
    if (DeepAgentChatPanel.current) {
      DeepAgentChatPanel.current.panel.reveal(column);
      DeepAgentChatPanel.current.rootOverride = rootOverride;
      DeepAgentChatPanel.current.postRoots();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "deepAgentChat",
      "DeepAgent Chat",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [getExtensionUri()],
      },
    );
    DeepAgentChatPanel.current = new DeepAgentChatPanel(
      panel,
      llm,
      rootOverride,
    );
    panel.webview.html = DeepAgentChatPanel.getHtml(panel.webview);
  }

  private postRoots() {
    this.panel.webview.postMessage({
      type: "root",
      text: describeRoots(this.rootOverride),
    });
  }

  private async onMessage(msg: WebviewToExtension) {
    if (msg.type === "send" && typeof msg.text === "string") {
      if (this.busy) return;
      await this.handleSend(msg.text);
    } else if (msg.type === "clear") {
      this.history = [];
      this.panel.webview.postMessage({ type: "cleared" });
    } else if (msg.type === "ready") {
      this.postRoots();
    } else if (msg.type === "pickRoot") {
      const picked = await pickRootOverride(this.rootOverride);
      if (picked) {
        this.rootOverride = picked.override;
        this.postRoots();
      }
    } else if (msg.type === "openFile") {
      const real = this.resolveRealPath(msg.path ?? "");
      if (real) {
        try {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(real),
          );
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          // The file may have been deleted since the edit ran.
        }
      }
    } else if (msg.type === "viewDiff") {
      const pair = splitUnifiedDiff(msg.diff ?? "");
      if (pair) {
        const parts = (msg.path ?? "file").split("/").filter(Boolean);
        const fileName = parts[parts.length - 1] || "file";
        // The tool result's diff covers only the CHANGE WINDOW, so the pair is
        // a fragment. Expand it into a FULL "before" snapshot: splice the
        // window's original lines back into the current file at the spot where
        // its modified lines occur, and diff that against the real file on
        // disk (real file = proper language mode, line numbers, scrolling).
        let beforeContent = pair.original;
        let language = "plaintext";
        let rightUri: vscode.Uri | undefined;
        const real = this.resolveRealPath(msg.path ?? "");
        if (real) {
          try {
            const doc = await vscode.workspace.openTextDocument(
              vscode.Uri.file(real),
            );
            const norm = (s: string) => s.replace(/\r\n/g, "\n");
            const text = norm(doc.getText());
            const at = text.indexOf(norm(pair.modified));
            if (at >= 0) {
              const tail = at + pair.modified.length;
              beforeContent =
                text.slice(0, at) + norm(pair.original) + text.slice(tail);
            }
            language = doc.languageId;
            rightUri = doc.uri;
          } catch {
            // File may have been deleted — fall back to the fragment pair.
          }
        }
        const before = await vscode.workspace.openTextDocument({
          content: beforeContent,
          language,
        });
        const after =
          rightUri ??
          (await vscode.workspace.openTextDocument({
            content: pair.modified,
            language,
          }));
        await vscode.commands.executeCommand(
          "vscode.diff",
          before.uri,
          after,
          `${fileName} (Agent changes)`,
          { preview: true },
        );
      }
    } else if (msg.type === "interruptResponse") {
      // Resume the paused (interrupted) run on the same thread with the user's
      // decision. runTurn loops if another approval is required. Approved paths
      // are registered first so the backend lets the tool through.
      if (this.busy && this.threadId) {
        const decisions = Array.isArray(msg.decisions) ? msg.decisions : [];
        decisions.forEach((d, i) => {
          const args = this.pendingActions[i]?.args ?? {};
          const p = args.file_path ?? args.path;
          if (d?.type === "approve" && typeof p === "string") {
            approvePath(this.approvedPaths, p);
          }
        });
        this.pendingActions = [];
        const command = new Command({ resume: { decisions } });
        await this.runTurn(command);
      }
    }
  }

  /** Map a deepagents virtual path (`/Folder/a.txt`) to a real disk path. */
  private resolveRealPath(virtualPath: string): string | undefined {
    const raw = virtualPath.trim().replace(/\\/g, "/");
    if (!raw.startsWith("/")) return undefined;

    const { mounts, singleRoot } = getWorkspaceLayout(this.rootOverride);
    const parts = raw.split("/").filter(Boolean);
    let mount = mounts[0];
    let rest = parts;
    if (!singleRoot) {
      const found = mounts.find((m) => m.name === parts[0]);
      if (!found) return undefined;
      mount = found;
      rest = parts.slice(1);
    }
    if (!mount) return undefined;
    return vscode.Uri.joinPath(vscode.Uri.file(mount.realPath), ...rest).fsPath;
  }

  private setBusy(value: boolean) {
    this.busy = value;
    this.panel.webview.postMessage({ type: "busy", value });
  }

  private async handleSend(text: string) {
    this.setBusy(true);
    this.panel.webview.postMessage({ type: "user", text });
    this.history.push(new HumanMessage(text));
    // Fresh thread per turn; an interrupted turn resumes on the same thread
    // until it completes, so the checkpoint never double-counts history.
    this.threadId = randomUUID();
    await this.runTurn({ messages: this.history });
  }

  /** Run one agent step and stream its tokens/tools to the webview. */
  private async runAgent(input: unknown, config: unknown) {
    const run: any = await this.agent.streamEvents(input as any, config as any);
    this.panel.webview.postMessage({ type: "runStart" });
    this.panel.webview.postMessage({ type: "assistantStart" });

    await Promise.all([this.streamMessages(run), this.streamToolCalls(run)]);

    const interrupted =
      Boolean(run.interrupted) || (run.interrupts?.length ?? 0) > 0;
    let output: any;
    if (!interrupted) {
      output = await run.output;
      this.panel.webview.postMessage({ type: "assistantEnd" });
    }
    const last = output?.messages?.[output.messages.length - 1];
    logDebug(
      "[panel] runAgent end:",
      `interrupted=${interrupted}`,
      `interruptTools=${JSON.stringify(
        (run.interrupts ?? []).map(
          (i: any) =>
            i?.payload?.actionRequests?.map((a: any) => a?.name) ?? [],
        ),
      )}`,
      `outputMessages=${output?.messages?.length ?? "none"}`,
      `lastMsg=${
        last
          ? `${last._getType()}: ${JSON.stringify(last.content).slice(0, 300)}`
          : "n/a"
      }`,
    );
    return { interrupted, interrupts: run.interrupts ?? [], output };
  }

  /**
   * Drive a full turn: run, and if the agent paused for human approval, surface
   * the request and stop. The webview's Approve/Deny button resumes via
   * `interruptResponse`, which calls this again with a Command — looping until
   * the turn completes or another approval is required.
   */
  private async runTurn(input: unknown) {
    const config = {
      version: "v3",
      configurable: { thread_id: this.threadId! },
    };
    try {
      const step = await this.runAgent(input, config);
      if (step.interrupted) {
        logDebug(
          "[panel] runTurn interrupted, surfacing approval card;",
          `pendingActions=${JSON.stringify(
            (step.interrupts[0]?.payload as any)?.actionRequests?.map(
              (a: any) => ({ name: a?.name, args: a?.args }),
            ) ?? [],
          )}`,
        );
        // Remember the pending actions so an Approve can register the exact
        // paths the backend should let through (order matches decisions).
        const hitl = step.interrupts[0]?.payload as
          | {
              actionRequests?: Array<{
                name?: string;
                args?: Record<string, unknown>;
              }>;
            }
          | undefined;
        this.pendingActions = hitl?.actionRequests ?? [];
        this.panel.webview.postMessage({
          type: "interrupt",
          request: step.interrupts[0]?.payload ?? null,
        });
        return; // stay busy; wait for the user's decision
      }
      if (step.output?.messages) {
        // Keep conversation turns only — the agent prepends its system message
        // each call and the workspace context is injected at the adapter
        // boundary, neither belongs in persisted history.
        this.history = step.output.messages.filter(
          (m: BaseMessage) => m._getType() !== "system",
        );
      }
      this.setBusy(false);
      logDebug("[panel] runTurn complete");
    } catch (e) {
      logDebug(
        "[panel] runTurn error:",
        e instanceof Error ? (e.stack ?? e.message) : String(e),
      );
      this.panel.webview.postMessage({
        type: "error",
        text: e instanceof Error ? (e.stack ?? e.message) : String(e),
      });
      this.setBusy(false);
    }
  }

  /** Stream the agent's assistant text tokens into the webview. */
  private async streamMessages(run: any) {
    for await (const msg of run.messages ?? []) {
      try {
        for await (const token of msg.text ?? []) {
          this.panel.webview.postMessage({ type: "token", text: token });
        }
      } catch {
        // A message lifecycle can reject if interrupted; ignore.
      }
    }
  }

  /** Stream tool start/end cards into the webview. */
  private async streamToolCalls(run: any) {
    let seq = 0;
    for await (const call of run.toolCalls ?? []) {
      try {
        // Key every card by the tool call id. Concurrent calls must not have
        // their start/end events crossed (the old __lastTool did exactly that).
        const id = String(call.id ?? `tool-${++seq}`);
        const name = call.name ?? "tool";
        const rawInput = await call.input;
        const input = formatToolInput(rawInput);
        const inputObj = rawInput as Record<string, unknown> | undefined;
        const filePath =
          rawInput && typeof rawInput === "object" && inputObj
            ? typeof inputObj.path === "string"
              ? inputObj.path
              : typeof inputObj.file_path === "string"
                ? inputObj.file_path
                : typeof inputObj.targetFile === "string"
                  ? inputObj.targetFile
                  : ""
            : "";
        this.panel.webview.postMessage({
          type: "toolStart",
          id,
          name,
          input,
          filePath,
        });

        let output = "";
        try {
          const raw = await call.output;
          output =
            name === "execute_pwsh"
              ? formatExecuteOutput(raw)
              : formatToolOutput(raw);
        } catch (err) {
          output =
            "error: " + (err instanceof Error ? err.message : String(err));
        }
        this.panel.webview.postMessage({
          type: "toolEnd",
          id,
          name,
          filePath,
          output: truncate(output, 4000),
          diff: name === "str_replace" ? extractUnifiedDiff(output) : "",
        });
      } catch {
        // ignore individual tool-event failures
      }
    }
  }

  // ---- Webview HTML ----

  private static getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "font-src https:",
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>DeepAgent Chat</title>
  <style>
    :root {
      --bg: #1e1e1e;
      --panel: #252526;
      --border: #3c3c3c;
      --fg: #d4d4d4;
      --muted: #9a9a9a;
      --accent: #4ec9b0;
      --user: #0e639c;
      --tool-bg: #2d2d30;
      --err: #f48771;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; height: 100%; background: var(--bg); color: var(--fg);
      font-family: -apple-system, "Segoe UI", system-ui, sans-serif;
      font-size: 13px;
    }
    #app { display: flex; flex-direction: column; height: 100vh; }
    header {
      padding: 10px 14px; border-bottom: 1px solid var(--border);
      font-weight: 600; color: var(--accent); display: flex;
      align-items: center; justify-content: space-between;
    }
    header button {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 12px;
    }
    header button:hover { color: var(--fg); }
    #messages { flex: 1; overflow-y: auto; padding: 14px; }
    .row { display: flex; margin-bottom: 12px; }
    .row.user { justify-content: flex-end; }
    .row.assistant { justify-content: flex-start; }
    .bubble {
      max-width: 82%; padding: 9px 12px; border-radius: 10px;
      white-space: pre-wrap; word-break: break-word; line-height: 1.5;
    }
    .row.user .bubble { background: var(--user); color: #fff; border-bottom-right-radius: 2px; }
    .row.assistant .bubble { background: var(--panel); border: 1px solid var(--border); border-bottom-left-radius: 2px; }
    .tool {
      max-width: 92%; margin: 0 0 12px auto; background: var(--tool-bg);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    }
    .tool-head {
      padding: 6px 10px; font-family: ui-monospace, "Cascadia Code", monospace;
      font-size: 12px; color: var(--accent); border-bottom: 1px solid var(--border);
      display: flex; align-items: center; gap: 8px;
    }
    .tool-head .dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--muted);
    }
    .tool-head .dot.done { background: var(--accent); }
    .tool-body { padding: 8px 10px; font-family: ui-monospace, "Cascadia Code", monospace; font-size: 11.5px; white-space: pre-wrap; word-break: break-word; color: var(--fg); max-height: 260px; overflow: auto; }
    .tool-body.summary { color: var(--muted); }
    .err { color: var(--err); white-space: pre-wrap; }
    #composer {
      border-top: 1px solid var(--border); padding: 10px; display: flex; gap: 8px;
      align-items: flex-end;
    }
    #input {
      flex: 1; resize: none; height: 42px; max-height: 160px; background: var(--panel);
      color: var(--fg); border: 1px solid var(--border); border-radius: 6px;
      padding: 8px 10px; font-family: inherit; font-size: 13px; line-height: 1.4;
    }
    #input:focus { outline: none; border-color: var(--accent); }
    #send {
      background: var(--accent); color: #06231e; border: none; border-radius: 6px;
      padding: 0 16px; height: 42px; font-weight: 600; cursor: pointer;
    }
    #send:disabled { opacity: 0.5; cursor: default; }
    .hint { color: var(--muted); font-size: 11px; padding: 0 14px 10px; }

    /* Kiro-style agent-outcome card for edit_file */
    .agent-outcome {
      max-width: 92%; margin: 0 0 12px auto; background: var(--tool-bg);
      border: 1px solid var(--border); border-radius: 8px; overflow: hidden;
    }
    .agent-outcome-summary {
      display: flex; align-items: center; gap: 8px; padding: 6px 10px;
      border-bottom: 1px solid var(--border);
    }
    .agent-outcome-status { display: inline-flex; align-items: center; }
    .agent-outcome-status .dot {
      width: 8px; height: 8px; border-radius: 50%; background: var(--muted);
    }
    .agent-outcome-status.agent-icon-accepted .dot { background: var(--accent); }
    .tool-call-title {
      font-family: ui-monospace, "Cascadia Code", monospace;
      font-size: 12px; color: var(--accent);
    }
    .file-label {
      display: inline-flex; align-items: center; gap: 5px; max-width: 260px;
      background: var(--panel); color: var(--fg); border: 1px solid var(--border);
      border-radius: 999px; padding: 1px 9px; font-size: 11px; cursor: pointer;
    }
    .file-label:hover { border-color: var(--accent); }
    .file-label-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .agent-outcome-actions { margin-left: auto; display: flex; gap: 6px; }
    .kiro-button {
      background: transparent; color: var(--muted); border: 1px solid var(--border);
      border-radius: 4px; padding: 2px 8px; cursor: pointer; font-size: 11px;
    }
    .kiro-button:hover { color: var(--fg); border-color: var(--accent); }
    .kiro-inline-diff-header {
      display: flex; align-items: center; gap: 7px; width: 100%; text-align: left;
      background: transparent; color: var(--muted); border: 0;
      padding: 5px 10px; cursor: pointer; font-size: 11.5px;
    }
    .chevron {
      width: 0; height: 0; border-left: 5px solid var(--muted);
      border-top: 4px solid transparent; border-bottom: 4px solid transparent;
      transition: transform .15s;
    }
    .chevron.expanded { transform: rotate(90deg); }
    .agent-outcome-details {
      border-top: 1px solid var(--border); max-height: 280px; overflow: auto;
    }
    .kiro-diff-pre {
      margin: 0; padding: 4px 0; font-family: ui-monospace, "Cascadia Code", monospace;
      font-size: 11.5px; line-height: 1.45;
    }
    .diff-line {
      padding: 0 10px; white-space: pre-wrap; word-break: break-word;
      color: var(--fg); border-left: 3px solid transparent;
    }
    .diff-line.meta { color: var(--muted); }
    .diff-line.added {
      color: #b5cea8; background: rgba(78, 201, 176, .14); border-left-color: #4ec9b0;
    }
    .diff-line.removed {
      color: #f48771; background: rgba(244, 135, 113, .14); border-left-color: #f48771;
    }

    /* Human-in-the-loop approval card for out-of-workspace access */
    .agent-outcome.hitl {
      max-width: 92%; margin: 0 0 12px auto; background: var(--tool-bg);
      border: 1px solid var(--accent); border-radius: 8px; overflow: hidden;
    }
    .hitl-action { display: flex; gap: 8px; padding: 2px 0; align-items: baseline; }
    .hitl-name { color: var(--accent); font-weight: 600; white-space: nowrap; }
    .hitl-args {
      color: var(--fg); white-space: pre-wrap; word-break: break-word; font-size: 11px;
    }
    .hitl-bar {
      display: flex; gap: 8px; padding: 8px 10px; border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <span>DeepAgent Chat</span>
      <span style="display:flex; gap:6px;">
        <button id="root" title="Change the directory the file tools operate on">root</button>
        <button id="clear">Clear</button>
      </span>
    </header>
    <div id="messages"></div>
    <div class="hint">Ask anything. The agent can list/read workspace files via its filesystem tools.</div>
    <div id="composer">
      <textarea id="input" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send">Send</button>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const sendEl = document.getElementById("send");
    const clearEl = document.getElementById("clear");
    const rootEl = document.getElementById("root");

    vscode.postMessage({ type: "ready" });

    let assistantBubble = null;

    function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }

    function addRow(role) {
      const row = document.createElement("div");
      row.className = "row " + role;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      row.appendChild(bubble);
      messagesEl.appendChild(row);
      scrollDown();
      return bubble;
    }

    const toolCards = new Map();

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    }

    function renderDiff(container, text) {
      container.textContent = "";
      const pre = el("pre", "kiro-diff-pre");
      const lines = text.split("\\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line === "" && i === lines.length - 1) continue;
        // Skip all unified-diff metadata; only the change rows + context show.
        if (line.indexOf("--- ") === 0 || line.indexOf("+++ ") === 0) continue;
        if (line.charAt(0) === "@") continue;
        let cls = "diff-line";
        if (line.charAt(0) === "+") cls += " added";
        else if (line.charAt(0) === "-") cls += " removed";
        // textContent only: file content must never be treated as HTML.
        pre.appendChild(el("div", cls, line));
      }
      container.appendChild(pre);
    }

    function addEditCard(filePath) {
      const wrap = el("div", "agent-outcome agent-outcome--running");
      const summary = el("div", "agent-outcome-summary");
      const status = el("span", "agent-outcome-status agent-icon-pending");
      const dot = el("span", "dot");
      status.appendChild(dot);
      summary.appendChild(status);
      const title = el("span", "tool-call-title", "Replacing…");
      summary.appendChild(title);

      const parts = (filePath || "").split("/").filter(Boolean);
      const fileName = parts.length ? parts[parts.length - 1] : "file";
      const pill = el("button", "file-label");
      pill.type = "button";
      pill.title = filePath || "";
      pill.appendChild(el("span", "file-label-name", fileName));
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        if (filePath) vscode.postMessage({ type: "openFile", path: filePath });
      });
      summary.appendChild(pill);

      const actions = el("div", "action-bar agent-outcome-actions");
      actions.style.display = "none";
      const viewBtn = el("button", "kiro-button kiro-icon-button", "View diff");
      viewBtn.type = "button";
      actions.appendChild(viewBtn);
      summary.appendChild(actions);
      wrap.appendChild(summary);

      const details = el("div", "kiro-inline-diff");
      const header = el("button", "kiro-inline-diff-header");
      header.type = "button";
      const chevron = el("span", "chevron");
      header.appendChild(chevron);
      header.appendChild(el("span", "kiro-inline-diff-title", "Details"));
      const body = el("div", "agent-outcome-details", "running…");
      body.style.display = "none";
      let expanded = false;
      header.addEventListener("click", () => {
        expanded = !expanded;
        body.style.display = expanded ? "" : "none";
        chevron.classList.toggle("expanded", expanded);
      });
      details.appendChild(header);
      details.appendChild(body);
      wrap.appendChild(details);
      messagesEl.appendChild(wrap);
      scrollDown();

      return {
        finish: (output, diff) => {
          wrap.className = "agent-outcome";
          status.className = "agent-outcome-status agent-icon-accepted";
          title.textContent = "Edit File";
          actions.style.display = "";
          if (diff) {
            renderDiff(body, diff);
            viewBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: "viewDiff", diff: diff, path: filePath });
            });
          } else {
            body.textContent = output || "(no changes)";
            viewBtn.style.display = "none";
          }
        },
      };
    }

    function addTool(name, filePath, input) {
      if (name === "str_replace") return addEditCard(filePath);
      const wrap = el("div", "tool");
      const head = el("div", "tool-head");
      const dot = el("span", "dot");
      head.appendChild(dot);
      head.appendChild(el("span", "tname", name));
      const body = el("div", "tool-body", input || "(no input)");
      wrap.appendChild(head);
      wrap.appendChild(body);
      messagesEl.appendChild(wrap);
      scrollDown();
      return {
        finish: (output) => {
          body.textContent = output || "(no output)";
          body.className = "tool-body";
          dot.classList.add("done");
        },
      };
    }

    // Human-in-the-loop approval card for a paused (interrupted) run.
    function addInterruptCard(request) {
      const wrap = el("div", "agent-outcome hitl");
      const head = el("div", "tool-head");
      head.appendChild(el("span", "dot"));
      head.appendChild(el("span", "tname", "Needs approval"));
      wrap.appendChild(head);

      const body = el("div", "tool-body");
      const actions = (request && request.actionRequests) || [];
      if (actions.length === 0) body.textContent = "(no pending actions)";
      for (const a of actions) {
        const line = el("div", "hitl-action");
        line.appendChild(el("span", "hitl-name", a.name || "tool"));
        line.appendChild(
          el("span", "hitl-args", a.args ? JSON.stringify(a.args) : ""),
        );
        body.appendChild(line);
      }
      wrap.appendChild(body);

      const bar = el("div", "hitl-bar");
      const approve = el("button", "kiro-button", "Approve");
      approve.type = "button";
      approve.addEventListener("click", () => {
        vscode.postMessage({
          type: "interruptResponse",
          decisions: actions.map(() => ({ type: "approve" })),
        });
        wrap.remove();
      });
      const reject = el("button", "kiro-button", "Reject");
      reject.type = "button";
      reject.addEventListener("click", () => {
        vscode.postMessage({
          type: "interruptResponse",
          decisions: actions.map(() => ({ type: "reject" })),
        });
        wrap.remove();
      });
      bar.appendChild(approve);
      bar.appendChild(reject);
      wrap.appendChild(bar);
      messagesEl.appendChild(wrap);
      scrollDown();
    }

    sendEl.addEventListener("click", () => {
      const text = inputEl.value.trim();
      if (!text) return;
      vscode.postMessage({ type: "send", text });
      inputEl.value = "";
      inputEl.style.height = "42px";
    });
    clearEl.addEventListener("click", () => {
      vscode.postMessage({ type: "clear" });
    });
    rootEl.addEventListener("click", () => {
      vscode.postMessage({ type: "pickRoot" });
    });
    inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendEl.click();
      }
    });
    inputEl.addEventListener("input", () => {
      inputEl.style.height = "42px";
      inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + "px";
    });

    window.addEventListener("message", (event) => {
      const m = event.data;
      switch (m.type) {
        case "user":
          addRow("user").textContent = m.text;
          assistantBubble = null;
          break;
        case "busy":
          sendEl.disabled = m.value;
          inputEl.disabled = m.value;
          break;
        case "runStart":
          assistantBubble = null;
          break;
        case "assistantStart":
          assistantBubble = addRow("assistant");
          break;
        case "token":
          if (!assistantBubble) assistantBubble = addRow("assistant");
          assistantBubble.textContent += m.text;
          scrollDown();
          break;
        case "toolStart": {
          const card = addTool(m.name, m.filePath || "", m.input || "");
          toolCards.set(m.id, card);
          window.__lastTool = card;
          break;
        }
        case "toolEnd": {
          const card = toolCards.get(m.id) || window.__lastTool;
          if (card) card.finish(m.output || "(no output)", m.diff || "");
          if (m.id) toolCards.delete(m.id);
          break;
        }
        case "assistantEnd":
          assistantBubble = null;
          break;
        case "cleared":
          messagesEl.innerHTML = "";
          assistantBubble = null;
          toolCards.clear();
          window.__lastTool = null;
          break;
        case "root":
          rootEl.textContent = m.text;
          rootEl.title = m.text + "\\n(click to change)";
          break;
        case "error": {
          const b = addRow("assistant");
          b.classList.add("err");
          b.textContent = "Error:\\n" + m.text;
          break;
        }
        case "interrupt":
          addInterruptCard(m.request);
          break;
        case "artifact": {
          const a = m.payload;
          const card = addRow("assistant");
          card.classList.add("artifact-card");
          const link = document.createElement("a");
          link.textContent = "Artifact: " + (a.title || a.id);
          link.href = a.url || "";
          link.title = a.filePath || "";
          link.style.cursor = "pointer";
          link.addEventListener("click", (e) => {
            e.preventDefault();
            vscode.postMessage({ type: "openFile", path: a.filePath });
          });
          card.appendChild(link);
          scrollDown();
          break;
        }
      }
    });
  </script>
</body>
</html>`;
  }
}
