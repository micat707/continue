/**
 * DeepAgent engine-mode wrapper
 * -----------------------------
 * Makes Continue's MAIN chat run through the Deep Agents loop instead of calling
 * the model directly, while keeping the model selector unchanged.
 *
 * `core/llm/streamChat.ts` drives the chat with `config.selectedModelByRole.chat`,
 * so we replace THAT object with a clone whose `streamChat` is overridden to run
 * DeepAgent (using the original model as its inference engine). Every other field
 * and method is inherited from the original, so Continue's selector still shows
 * the original model name and all capabilities are preserved.
 *
 * Only assistant *text* is emitted (no `toolCalls`), so Continue's own tool loop
 * has nothing to execute and just renders the streamed answer. Tool activity
 * happens inside DeepAgent and is not shown in Continue's chat (use the
 * standalone "Deep Agent Chat" panel for tool cards).
 */

import type { ChatMessage, CompletionOptions, ILLM } from "core";
import { createDeepAgent } from "deepagents";
import { randomUUID } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Command, MemorySaver } from "@langchain/langgraph";
import {
  HumanMessage,
  AIMessage,
  type BaseMessage,
} from "@langchain/core/messages";

import { ContinueLLMAdapter } from "./ContinueLLMAdapter";
import { createPruneFileContent } from "./filePruning";
import {
  approvePath,
  buildWorkspaceContext,
  createWorkspaceBackend,
  describeRoots,
  inWorkspaceFolders,
  approveReadPath,
  createWorkspaceBackend,
  getWorkspaceLayout,
  setActiveTurnAbort,
  isPathApproved,
  translateVirtualPathsInCommand,
  withApprovedPaths,
  createBackgroundProcessTools,
  setExecuteRunId,
} from "./workspaceBackend";
import { createWebFetchTools } from "./webFetchTool";
import { createWebSearchTools } from "./webSearchTool";
import * as path from "path";
import {
  DEFAULT_PERMISSION_CONFIG,
  isReadTool,
  mergeRules,
  normalizePath,
  PermissionAction,
  PermissionConfig,
  resolveAction,
  resolveExecuteAction,
  type MergedRules,
} from "./permissions";
import { loadGlobalConfig, loadWorkspaceConfig } from "./permissionStore";
import { requestHitlDecision } from "./hitlBridge";
import {
  formatExecuteOutput,
  formatToolBlock,
  formatToolInput,
  formatToolOutput,
  stripToolBlocks,
} from "./toolFormat";

/**
 * Handle the permission panel uses to read/clear the active chat's session
 * memory. `impl` is (re)assigned on every `wrapWithDeepAgent` call, so it
 * always points at the most recently created chat wrapper.
 */
export const activeSessionPermissions: {
  impl?: {
    getMemory(): {
      approved: string[];
      readApproved: string[];
      denied: string[];
    };
    clear(): void;
    getSessionPolicy(): PermissionConfig;
  };
} = {};

/** Tiny multi-producer / single-consumer queue for merging two event streams. */
type QueueItem = { kind: "text" | "thinking"; text: string };

class AsyncTextQueue {
  private items: QueueItem[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;

  push(item: QueueItem) {
    if (this.closed || !item.text) return;
    this.items.push(item);
    const wake = this.resolvers.shift();
    if (wake) wake();
  }

  close() {
    this.closed = true;
    while (this.resolvers.length) this.resolvers.shift()!();
  }

  async *drain(): AsyncGenerator<QueueItem> {
    while (true) {
      while (this.items.length) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((resolve) => this.resolvers.push(resolve));
    }
  }
}

/**
 * Wrap a Continue chat model so its `streamChat` is driven by DeepAgent.
 * The original model is used as DeepAgent's inference engine (so we don't
 * recurse into the wrapper).
 *
 * `rootOverride` is optional: when undefined the agent's file tools follow
 * `vscode.workspace.workspaceFolders` automatically (all folders in Explorer).
 */
/**
 * Files this DeepAgent SESSION has created/modified via `write_file` / `edit_file`.
 * Surfaced to the GUI as a categorized "session changes" summary shown after the
 * agent finishes answering (see the GUI's `SessionChangesSummary`). Scoped to a
 * session using the same "first turn has no prior assistant message" reset as the
 * approval memory below — so a new chat starts with an empty list.
 *
 * We track file-WRITING tools only (not `execute`): a build command (`mvn` /
 * `npm`) produces hundreds of untracked build artifacts, and those must NOT
 * clutter the change list — only the files the agent deliberately wrote/edited
 * count as "changes this conversation made".
 */
const sessionChangedFiles = new Set<string>();

/** Read-only accessor for the GUI's `getSessionChangedFiles` ide command. */
export function getSessionChangedFiles(): string[] {
  return Array.from(sessionChangedFiles);
}

export function wrapWithDeepAgent(
  underlying: ILLM,
  rootOverride: string | undefined,
  onInvoke?: () => void,
): ILLM {
  const adapter = new ContinueLLMAdapter({
    llm: underlying,
    // Re-evaluated on every model call, so folders added via "Add Folder to
    // Workspace…" show up without rebuilding the agent.
    systemContext: () => buildWorkspaceContext(rootOverride),
  });
  // Human-in-the-loop + permission policy. A path the user APPROVED this session
  // is let through without re-prompting; a path the user DENIED is hard-blocked.
  // Everything else is decided by the three-layer policy (global → workspace →
  // session) resolved in `permEngine`. State lives in this closure, so it
  // persists across turns of the same chat. NOTE: applyDeepAgentWrap attaches
  // the wrapper to the MODEL object (once), not to a session — the memory is
  // scoped to a session by the new-session reset inside streamChat below.
  const approvedPaths = new Set<string>();
  // Read-only grants: approving a read-style tool (ls/read_file/grep…) unlocks
  // the approved subtree for READ tools only — write tools always re-prompt.
  const approvedReadPaths = new Set<string>();
  const deniedPaths = new Set<string>();
  // The SESSION layer of the policy (ephemeral, per chat). Global/workspace
  // layers come from VS Code settings and are read fresh on each turn.
  const sessionPolicy: PermissionConfig = {
    trustedDirs: [],
    trustRules: [],
    untrustRules: [],
  };

  // Expose this chat's session permission memory to the standalone permission
  // panel (read / clear). Single active wrapper at a time, so a module-level
  // handle is sufficient.
  activeSessionPermissions.impl = {
    getMemory: () => ({
      approved: [...approvedPaths],
      readApproved: [...approvedReadPaths],
      denied: [...deniedPaths],
    }),
    clear: () => {
      approvedPaths.clear();
      approvedReadPaths.clear();
      deniedPaths.clear();
    },
    getSessionPolicy: () => sessionPolicy,
  };

  // Re-read settings + re-merge the three layers. Called at agent creation and
  // at the start of every turn so setting changes take effect without a reload.
  let merged: MergedRules = mergeRules(
    DEFAULT_PERMISSION_CONFIG,
    null,
    sessionPolicy,
  );
  const recomputePolicy = () => {
    merged = mergeRules(
      loadGlobalConfig(),
      loadWorkspaceConfig(),
      sessionPolicy,
    );
  };
  recomputePolicy();

  // "inside" = within the workspace folders OR within a configured trusted dir;
  // everything else is "outside" (real filesystem, governed by untrustRules).
  const trustScopeOf = (path: string): "inside" | "outside" => {
    if (inWorkspaceFolders(path, rootOverride)) return "inside";
    const n = normalizePath(path);
    if (
      merged.trustedDirs.some(
        (d) => n === normalizePath(d) || n.startsWith(normalizePath(d) + "/"),
      )
    )
      return "inside";
    return "outside";
  };

  // Effective action for a tool + path, folding in this session's approvals /
  // denials (which override the static policy).
  const effectiveAction = (tool: string, path: string): PermissionAction => {
    // All-tools grants (approvals of write-style calls) unlock everything in
    // the approved subtree; read-only grants (approvals of ls/read_file/grep…)
    // unlock read-style tools only. A write outside the workspace therefore
    // always re-prompts even after a prior read approval — by design.
    if (isPathApproved(approvedPaths, path)) return "allow";
    if (isReadTool(tool) && isPathApproved(approvedReadPaths, path)) {
      return "allow";
    }
    if (deniedPaths.has(normalizePath(path))) return "deny";
    return resolveAction({ tool, scope: trustScopeOf(path), merged });
  };

  const permEngine = {
    effectiveAction,
    // The approval card only fires for "ask"; allow/deny never prompt.
    shouldInterrupt: (tool: string, req: any): boolean => {
      const args = req?.toolCall?.args;
      // read_files carries an array of paths; interrupt if any of them needs
      // approval (a non-string/unknown shape never stalls the run).
      if (Array.isArray(args?.paths)) {
        return args.paths.some(
          (p: unknown) =>
            typeof p === "string" &&
            p.trim() &&
            effectiveAction(tool, p) === "ask",
        );
      }
      const p = args?.file_path ?? args?.path;
      if (typeof p !== "string" || !p.trim()) return false;
      return effectiveAction(tool, p) === "ask";
    },
  };

  // Path-bearing tools that can be governed by the policy. Tools not in this
  // list run through the default virtual backend (inside-workspace only).
  const governedTools = [
    "read_file",
    "read_files",
    "fs_write",
    "fs_append",
    "str_replace",
    "delete_file",
    "list_directory",
    "file_search",
    "grep_search",
  ];
  const interruptOn: Record<string, unknown> = {};
  for (const tool of governedTools) {
    interruptOn[tool] = {
      allowedDecisions: ["approve", "reject"],
      when: (req: any) => permEngine.shouldInterrupt(tool, req),
    };
  }
  // `execute` (arbitrary shell commands) is NOT path-governed — a command can
  // touch anything the user can (any file, the network, other processes), so
  // the inside/outside path rules do not apply. It is governed by the HITL
  // middleware (interruptOn) directly: a command pauses on the approval card
  // UNLESS it matches the user's executeAllowlist (then it auto-runs) or the
  // policy resolves to "deny" (then the backend proxy hard-blocks it).
  interruptOn["execute_pwsh"] = {
    allowedDecisions: ["approve", "reject"],
    when: (req: any) => {
      const command = req?.toolCall?.args?.command;
      const layout = getWorkspaceLayout(rootOverride);
      // Catastrophic commands (recursive root / whole-workspace delete, format,
      // mkfs…) resolve to "deny" → `when` returns false → NO approval card is
      // shown at all, and the allowlist cannot grant them.
      return (
        resolveExecuteAction(
          merged,
          command,
          layout.mounts.map((m) => m.realPath),
          layout.mounts.map((m) => m.virtualPath),
        ) === "ask"
      );
    },
  };
  // `control_process` "start" launches an arbitrary shell command in the
  // background — same risk profile as `execute`, so it gets the same approval
  // gate (auto-run on allowlist, hard-block on deny, card on "ask"). "stop" /
  // output polling are harmless and never interrupt.
  interruptOn["control_pwsh_process"] = {
    allowedDecisions: ["approve", "reject"],
    when: (req: any) => {
      if (req?.toolCall?.args?.action !== "start") return false;
      const command = req?.toolCall?.args?.command;
      const layout = getWorkspaceLayout(rootOverride);
      return (
        resolveExecuteAction(
          merged,
          command,
          layout.mounts.map((m) => m.realPath),
          layout.mounts.map((m) => m.virtualPath),
        ) === "ask"
      );
    },
  };
  const executeDenied = () => {
    const layout = getWorkspaceLayout(rootOverride);
    return (
      resolveExecuteAction(
        merged,
        undefined,
        layout.mounts.map((m) => m.realPath),
        layout.mounts.map((m) => m.virtualPath),
      ) === "deny"
    );
  };

  // Tools are now natively named with Kiro names (no alias middleware), so the
  // batched HITL scan sees the real tool names directly — governedTools and the
  // execute/control_process rules above already cover them.

  const agent = createDeepAgent({
    model: adapter,
    // Kiro-style large-file pruning driven by the MAIN LLM: read_file's
    // `explanation` becomes the pruning prompt's reasoning. The callback never
    // throws, so a failed/irrelevant reply simply returns the full file.
    pruneFileContent: createPruneFileContent(async (prompt, signal) => {
      const response = await adapter.invoke([new HumanMessage(prompt)], {
        signal,
      });
      return typeof response.content === "string" ? response.content : "";
    }),
    systemPrompt:
      "You are a helpful coding assistant. Use the filesystem tools when needed.",
    // Factory runs on every agent turn, so workspace changes (including
    // folders added via "Add Folder to Workspace…") are picked up live, and the
    // policy is re-evaluated each turn.
    backend: () =>
      withApprovedPaths(createWorkspaceBackend(rootOverride), {
        decide: effectiveAction,
        override: rootOverride,
        executeDenied,
      }),
    // Background process management tools (control_process / get_process_output /
    // list_processes) — mirror Kiro so dev servers etc. run without blocking.
    // web_search + web_fetch mirror Kiro's search-then-read web workflow.
    tools: [
      ...createBackgroundProcessTools(),
      ...createWebFetchTools(),
      ...createWebSearchTools(),
    ],
    // MemorySaver keeps the thread state so a paused run can be resumed on the
    // same thread_id after the user's decision.
    checkpointer: new MemorySaver(),
    interruptOn,
  });

  // Clone the model: inherit its prototype (all methods) and copy its own
  // instance fields (title, provider, options, capabilities, ...).
  const wrapper: any = Object.create(Object.getPrototypeOf(underlying));
  Object.assign(wrapper, underlying);
  wrapper.__deepAgent = true;
  wrapper.__original = underlying;

  wrapper.streamChat = async function* (
    messages: ChatMessage[],
    _signal: AbortSignal,
    _options: CompletionOptions,
    _messageOptions?: any,
  ): AsyncGenerator<ChatMessage> {
    // Hard evidence in the Extension Host log that THIS chat turn went through
    // the DeepAgent wrapper (Help → Toggle Developer Tools → Console, or
    // Output → "Extension Host").
    console.log(
      `[DeepAgent] >>> chat turn entered DeepAgent wrapper | model=${(underlying as any).title ?? underlying.model} | messages=${messages.length} | roots=${describeRoots(rootOverride)}`,
    );
    onInvoke?.();

    // Expose this turn's abort signal so the execute tool can interrupt a
    // running terminal command when the user presses "Stop" (otherwise the
    // tool await stays pending and the turn hangs on "processing").
    setActiveTurnAbort(_signal);

    // Re-read the permission policy from VS Code settings for this turn so
    // global/workspace changes apply without a reload.
    recomputePolicy();

    // Session scoping of the approval memory: the wrapper is attached to the
    // MODEL (applyDeepAgentWrap wraps once), not to a chat session — without
    // this reset, approvals granted in one chat would silently leak into every
    // later chat. The GUI sends the full history on every turn, so a turn with
    // no prior assistant message IS the first turn of a new session: wipe the
    // grants/denials from the previous chat.
    if (!messages.some((m) => m.role === "assistant")) {
      if (approvedPaths.size || approvedReadPaths.size || deniedPaths.size) {
        console.log(
          "[DeepAgent] new session detected — clearing approval memory",
        );
        approvedPaths.clear();
        approvedReadPaths.clear();
        deniedPaths.clear();
        sessionChangedFiles.clear();
      }
    }

    const lcMessages: BaseMessage[] = [];
    for (const m of messages) {
      if (m.role === "user" || m.role === "assistant") {
        const raw =
          typeof m.content === "string"
            ? m.content
            : (m.content ?? [])
                .filter((p: any) => p.type === "text")
                .map((p: any) => p.text)
                .join("");
        // Tool blocks were injected into previous turns for display only —
        // strip them so the model doesn't see its own rendered tool cards.
        const text = stripToolBlocks(raw);
        if (text.trim()) {
          lcMessages.push(
            m.role === "user" ? new HumanMessage(text) : new AIMessage(text),
          );
        }
      }
    }

    const threadId = randomUUID();

    let run: any;
    try {
      run = await agent.streamEvents(
        { messages: lcMessages },
        { version: "v3", configurable: { thread_id: threadId } },
      );
    } catch (e) {
      yield {
        role: "assistant",
        content:
          "DeepAgent error: " + (e instanceof Error ? e.message : String(e)),
      };
      return;
    }

    // Merge one agent run's assistant text + tool-activity into the queue.
    // Returns true if the run paused for human approval (interrupt).
    const queue = new AsyncTextQueue();
    let answerChars = 0;
    let toolCount = 0;

    const pump = async (run: any): Promise<boolean> => {
      const textProducer = (async () => {
        try {
          for await (const msg of run.messages ?? []) {
            try {
              // Reasoning arrives via the message's `.reasoning` projection
              // (ChatModelStream over reasoning-delta events — see
              // ContinueLLMAdapter). Iterate it CONCURRENTLY with `.text`:
              // both streams read the same event buffer, and draining one
              // before the other could drop events that arrived earlier.
              const reasoningJob = (async () => {
                try {
                  for await (const rt of (msg as any).reasoning ?? []) {
                    if (rt) {
                      queue.push({ kind: "thinking", text: rt });
                    }
                  }
                } catch {
                  // Reasoning projection unavailable for this message; ignore.
                }
              })();
              for await (const token of msg.text ?? []) {
                if (token) {
                  answerChars += token.length;
                  queue.push({ kind: "text", text: token });
                }
              }
              await reasoningJob;
            } catch {
              // A message lifecycle can reject if interrupted; ignore.
            }
          }
        } catch (e) {
          console.log(`[DeepAgent] messages stream failed | ${String(e)}`);
        }
      })();

      const toolProducer = (async () => {
        try {
          for await (const call of run.toolCalls ?? []) {
            try {
              const name = call.name ?? "tool";
              const input = formatToolInput(await call.input);
              // Track files the agent deliberately wrote/edited this session so
              // the GUI can list "changes this conversation made" after answering
              // (build artifacts from `execute` are intentionally excluded).
              if (
                name === "fs_write" ||
                name === "fs_append" ||
                name === "str_replace"
              ) {
                try {
                  const obj = JSON.parse(input) as {
                    filepath?: unknown;
                    path?: unknown;
                  };
                  const fp =
                    typeof obj.filepath === "string"
                      ? obj.filepath
                      : typeof obj.path === "string"
                        ? obj.path
                        : undefined;
                  if (fp) {
                    const root =
                      rootOverride ??
                      getWorkspaceLayout(rootOverride).mounts[0]?.realPath ??
                      "";
                    sessionChangedFiles.add(
                      path.isAbsolute(fp) ? fp : path.resolve(root, fp),
                    );
                  }
                } catch {
                  // args not yet parseable — skip this one
                }
              }
              // The toolCalls stream yields as soon as the call STARTS (output
              // is a promise that resolves later). For `execute`, surface a SINGLE
              // pending Run Command card at execution start. The live output is
              // streamed separately via the `deepagentExecuteProgress` webview
              // event (keyed by a fresh runId), so we never re-emit pending
              // blocks and the GUI has nothing to dedupe. When `call.output`
              // resolves below, the completed block replaces this card.
              if (name === "execute_pwsh") {
                const runId = uuidv4();
                setExecuteRunId(runId);
                queue.push({
                  kind: "text",
                  text: formatToolBlock(
                    name,
                    input,
                    JSON.stringify({ running: true, output: "", runId }),
                  ),
                });
              }
              let output = "";
              try {
                // The execute tool's result must reach the GUI as a JSON
                // envelope ({ output, exitCode }) so the Run Command card shows
                // the correct green/red status — deepagents' own string output
                // would lose the exit code.
                output =
                  name === "execute_pwsh"
                    ? formatExecuteOutput(await call.output)
                    : formatToolOutput(await call.output);
              } catch (err) {
                output =
                  "error: " +
                  (err instanceof Error ? err.message : String(err));
              }
              toolCount += 1;
              queue.push({
                kind: "text",
                text: formatToolBlock(
                  name,
                  input,
                  output,
                  // The execute card keeps a head + a tail (the tail carries
                  // BUILD SUCCESS/FAILURE), so it needs a bigger budget than
                  // the 2000-char default.
                  name === "execute_pwsh" ? 4000 : undefined,
                ),
              });
            } catch {
              // ignore individual tool-event failures
            }
          }
        } catch (e) {
          console.log(`[DeepAgent] toolCalls stream failed | ${String(e)}`);
        }
      })();

      await Promise.all([textProducer, toolProducer]);
      const interrupted =
        Boolean(run.interrupted) || (run.interrupts?.length ?? 0) > 0;
      if (!interrupted) {
        await run.output;
      }
      return interrupted;
    };

    // Abort handling for the HITL wait is wired per-request inside
    // requestHitlDecision(payload, _signal): pressing Stop rejects only this
    // turn's pending approval, not approvals belonging to other chat sessions.

    // Run the agent loop in the BACKGROUND: it pumps every run's text/tools into
    // `queue`, pausing on HITL interrupts and resuming on the user's decision.
    // The outer `for await (queue.drain())` streams those pieces to Continue in
    // real time — this is what restores token-by-token streaming (the original
    // Continue behavior) and keeps it live across interrupts/resumes.
    const agentLoop = (async () => {
      try {
        let currentRun = run;
        // Resolved once per turn (workspace may change between turns via the
        // backend factory, but a single turn's interrupts share this layout).
        const workspaceLayout = getWorkspaceLayout(rootOverride);
        while (true) {
          const interrupted = await pump(currentRun);
          if (!interrupted) break;
          // Surface the approval card and wait for the user's decision.
          const payload = currentRun.interrupts[0]?.payload;
          // Model-return boundary: normalize virtual mount paths in `execute`
          // commands into REAL paths HERE — the single middleware point for
          // command path resolution. Every downstream consumer (the approval
          // card the user reviews, execution, logs, previews) then sees the
          // same already-interpreted command, so nothing can skip this step.
          // The backend.execute translation stays as defense-in-depth (it is
          // idempotent on an already-real path).
          if (payload?.actionRequests) {
            for (const a of payload.actionRequests) {
              if (
                a?.name === "execute_pwsh" &&
                typeof a.args?.command === "string"
              ) {
                a.args.command = translateVirtualPathsInCommand(
                  a.args.command,
                  workspaceLayout.mounts,
                  workspaceLayout.singleRoot,
                );
              }
            }
          }
          const decisions = await requestHitlDecision(payload, _signal);
          // Fold the user's decision into this session's permission memory so
          // the interrupt does not re-fire for the same path this chat:
          //  - approve a READ tool → read-only grant for the subtree (writes
          //    under it still re-prompt)
          //  - approve a WRITE-style tool → all-tools grant (the user saw and
          //    approved that exact operation)
          //  - reject → the path is denied (backend hard-blocks, no card)
          decisions.forEach((d, i) => {
            const req = payload?.actionRequests?.[i];
            const p = req?.args?.file_path ?? req?.args?.path;
            if (typeof p !== "string") return;
            if (d?.type === "approve") {
              if (isReadTool(String(req?.name ?? ""))) {
                approveReadPath(approvedReadPaths, p);
              } else {
                approvePath(approvedPaths, p);
              }
            } else {
              deniedPaths.add(normalizePath(p));
            }
          });
          // Resume the SAME thread with the user's decision.
          currentRun = await agent.streamEvents(
            new Command({ resume: { decisions } }),
            { version: "v3", configurable: { thread_id: threadId } },
          );
        }
      } finally {
        // Always close so the outer drain loop terminates, even on error.
        queue.close();
      }
    })();

    try {
      for await (const piece of queue.drain()) {
        if (piece.kind === "thinking") {
          yield { role: "thinking", content: piece.text } as ChatMessage;
        } else {
          yield { role: "assistant", content: piece.text };
        }
      }
      await agentLoop;
      console.log(
        `[DeepAgent] <<< chat turn done | chars=${answerChars} | tools=${toolCount}`,
      );
    } catch (e) {
      console.log(`[DeepAgent] <<< chat turn interrupted | ${String(e)}`);
      queue.close();
      yield {
        role: "assistant",
        content:
          "\n\n[DeepAgent interrupted: " +
          (e instanceof Error ? e.message : String(e)) +
          "]",
      };
    } finally {
      setActiveTurnAbort(undefined);
    }
  };

  return wrapper as ILLM;
}
