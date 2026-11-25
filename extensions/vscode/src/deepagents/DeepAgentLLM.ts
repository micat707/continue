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
import {
  approvePath,
  buildWorkspaceContext,
  createWorkspaceBackend,
  describeRoots,
  inWorkspaceFolders,
  approveReadPath,
  getWorkspaceLayout,
  setActiveTurnAbort,
  isPathApproved,
  translateVirtualPathsInCommand,
  withApprovedPaths,
  setExecuteRunId,
} from "./workspaceBackend";
import { createDeepAgentToolsAsync } from "./acpToolKit";
import type { ContinueConfig } from "core";
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
import { pushArtifactToGui } from "./artifactBridge";
import { createArtifact } from "./artifactStore";
import { createSpecTaskResolver, setSpecPathResolver } from "./specTools";
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
import { getGuiPolicyLayer } from "./toolPolicyBridge";
import {
  formatExecuteOutput,
  formatToolBlock,
  formatToolInput,
  formatToolOutput,
  stripToolBlocks,
  TOOL_PENDING_MARKER,
} from "./toolFormat";

/**
 * Per-chat permission memory handle. Each session owns an independent handle
 * (approved / read-approved / denied paths + ephemeral policy layer). The
 * permission panel is a single global UI, so `activeSessionPermissions.impl`
 * points at the most recently used session's handle for backwards
 * compatibility, while `getSessionPermissionHandle(id)` addresses any session.
 */
export interface SessionPermissionHandle {
  getMemory(): {
    approved: string[];
    readApproved: string[];
    denied: string[];
  };
  clear(): void;
  getSessionPolicy(): PermissionConfig;
}

const sessionPermissionHandles = new Map<string, SessionPermissionHandle>();

/** Handle for the global permission panel (the most recently used session). */
export const activeSessionPermissions: { impl?: SessionPermissionHandle } = {};

export function getSessionPermissionHandle(
  sessionId?: string,
): SessionPermissionHandle | undefined {
  if (sessionId) {
    const handle = sessionPermissionHandles.get(sessionId);
    if (handle) return handle;
  }
  return activeSessionPermissions.impl;
}

/**
 * Tiny multi-producer / single-consumer queue for merging event streams.
 * `toolCall` / `toolResult` let a tool run through Continue's native
 * structured tool_call channel (stable toolCallId React key → no card jitter),
 * instead of the markdown-text + regex-rewrite path.
 */
type QueueItem =
  | { kind: "text" | "thinking"; text: string }
  | {
      kind: "toolCall";
      toolCall: {
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      };
    }
  | { kind: "toolResult"; toolCallId: string; content: string };

class AsyncTextQueue {
  private items: QueueItem[] = [];
  private resolvers: Array<() => void> = [];
  private closed = false;

  push(item: QueueItem) {
    if (this.closed) return;
    if ((item.kind === "text" || item.kind === "thinking") && !item.text)
      return;
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
const changedFilesBySession = new Map<string, Set<string>>();

/** Get (or create) the changed-file set for a specific chat session. */
function getSessionChangedFilesSet(sessionId: string): Set<string> {
  let set = changedFilesBySession.get(sessionId);
  if (!set) {
    set = new Set<string>();
    changedFilesBySession.set(sessionId, set);
  }
  return set;
}

/**
 * Read-only accessor for the GUI's `getSessionChangedFiles` ide command.
 * With a `sessionId`, returns only that session's files; without one, returns
 * the union (backwards compatibility for the legacy global call).
 */
export function getSessionChangedFiles(sessionId?: string): string[] {
  if (sessionId) {
    return Array.from(changedFilesBySession.get(sessionId) ?? []);
  }
  const all = new Set<string>();
  for (const files of changedFilesBySession.values()) {
    for (const f of files) all.add(f);
  }
  return Array.from(all);
}

/**
 * One isolated DeepAgent runtime for a single chat session. Owns its own
 * agent, adapter, approval memory and changed-file set, so a turn in session B
 * can never clear or inherit the permission state of session A.
 */
type SessionRuntime = {
  streamChat(
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
    messageOptions?: any,
  ): AsyncGenerator<ChatMessage>;
};

async function buildSessionRuntime(
  underlying: ILLM,
  rootOverride: string | undefined,
  sessionId: string,
  onInvoke: (() => void) | undefined,
  getConfig: (() => Promise<ContinueConfig | undefined>) | undefined,
): Promise<SessionRuntime> {
  const adapter = new ContinueLLMAdapter({
    llm: underlying,
    // The owning chat session id. Threaded all the way to the wire-level RAW
    // logger so every llm.log entry for this conversation shares one id.
    sessionId,
    // Re-evaluated on every model call, so folders added via "Add Folder to
    // Workspace…" show up without rebuilding the agent.
    systemContext: () => buildWorkspaceContext(rootOverride),
  });
  // Human-in-the-loop + permission policy. A path the user APPROVED this session
  // is let through without re-prompting; a path the user DENIED is hard-blocked.
  // Everything else is decided by the three-layer policy (global → workspace →
  // session) resolved in `permEngine`. All of this state lives in THIS runtime's
  // closure — one per chat session — so it persists across that chat's turns and
  // is completely isolated from every other session. No "first turn clears
  // memory" heuristic is needed any more.
  const approvedPaths = new Set<string>();
  // Files this session wrote/edited — private set keyed by the owning session.
  const sessionChangedFiles = getSessionChangedFilesSet(sessionId);
  // Spec workflow is OFF by default. Only the model calling
  // `start_spec_workflow` flips this flag for this session.
  const specController = new SpecWorkflowController();
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

  // Expose this session's permission memory: register a per-session handle (so
  // the panel can address any session by id) and also point the legacy global
  // handle at it for the "most recently used session" compatibility path.
  const permissionHandle: SessionPermissionHandle = {
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
  sessionPermissionHandles.set(sessionId, permissionHandle);
  activeSessionPermissions.impl = permissionHandle;

  // Re-read settings + re-merge the three layers. Called at agent creation and
  // at the start of every turn so setting changes take effect without a reload.
  let merged: MergedRules = mergeRules(
    DEFAULT_PERMISSION_CONFIG,
    null,
    sessionPolicy,
  );
  const recomputePolicy = () => {
    // GUI Tools-page policies are the single source of truth for per-tool
    // decisions. Fold them into the session layer (highest precedence), ahead
    // of this session's transient path approvals so an explicit GUI "disabled"
    // still wins. DeepAgent's own red lines (outside files / execute never
    // auto-allow) are applied later by resolveAction()/resolveExecuteAction().
    const guiLayer = getGuiPolicyLayer();
    const withGui: PermissionConfig = {
      trustedDirs: sessionPolicy.trustedDirs,
      // GUI rules LAST: within a layer mergeRules uses last-write-wins, so an
      // explicit Tools-page decision overrides transient session entries.
      trustRules: [...sessionPolicy.trustRules, ...guiLayer.trustRules],
      untrustRules: [...sessionPolicy.untrustRules, ...guiLayer.untrustRules],
      executeAllowlist: sessionPolicy.executeAllowlist,
    };
    merged = mergeRules(loadGlobalConfig(), loadWorkspaceConfig(), withGui);
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
    // LangGraph dispatches the library-internal name (model-facing is
    // `append_lines`, see ContinueLLMAdapter).
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
  // MCP tools are discovered asynchronously and execute inside this DeepAgent
  // loop (never via Continue's tools/call harness).
  const { tools: allTools, mcpInfo } = await createDeepAgentToolsAsync({
    surface: "ide",
    sessionId,
    rootOverride,
    getConfig,
    specController,
    kiroExtraDeps: {
      toRealPath: (p) => kiroPathToReal(p, rootOverride),
      workspaceRoot: () =>
        getWorkspaceLayout(rootOverride).mounts[0]?.realPath ?? process.cwd(),
      sessionId,
      pushArtifact: pushArtifactToGui,
      artifactWriter: createArtifact,
      symbolResolver: async (filePath, content) => {
        const { getSymbolsForFile } = require("core/util/treeSitter");
        const symbols = await getSymbolsForFile(filePath, content);
        return symbols as any;
      },
    },
  });

  // MCP tools are external/unknown code: only servers Continue marked as
  // protected force an approval card; the rest auto-run, matching Continue's
  // own trust model as closely as the extension-side config allows.
  for (const mcp of mcpInfo) {
    interruptOn[mcp.name] = {
      allowedDecisions: ["approve", "reject"],
      when: () => mcp.requiresApproval,
    };
  }

  const agent = createDeepAgent({
    model: adapter,
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
    // Pre-loaded above: built-in DeepAgent tools + MCP tools. All execute in
    // this agent loop; none fall back to Continue's tools/call harness.
    tools: allTools,
    // MemorySaver keeps the thread state so a paused run can be resumed on the
    // same thread_id after the user's decision.
    checkpointer: new MemorySaver(),
    interruptOn,
    // Kiro's invoke_sub_agent: expose the 5 preset agents and let contextFiles
    // resolve against this session's workspace layout. spec-task-execution is
    // specOnly and stays out of the normal "Available agents" description.
    subagents: KIRO_SUBAGENTS,
    contextFileResolver: createKiroContextFileResolver(rootOverride),
    specTaskResolver: createSpecTaskResolver((p) =>
      kiroPathToReal(p, rootOverride),
    ),
    // Default chat path runs no classifier. The model opts into the spec
    // workflow via `start_spec_workflow`; only then does spec sub-intent
    // classification + the orchestrator prompt/tool whitelist apply.
    middleware: [
      createSpecWorkflowMiddleware(specController, {
        orchestratorPrompt: SPEC_ORCHESTRATOR_PROMPT,
        orchestratorToolNames: SPEC_ORCHESTRATOR_TOOLS,
      }),
    ],
  });
  setSpecPathResolver((p) => kiroPathToReal(p, rootOverride));

  const streamChat = async function* (
    messages: ChatMessage[],
    _signal: AbortSignal,
    _options: CompletionOptions,
    _messageOptions?: any,
  ): AsyncGenerator<ChatMessage> {
    // `sessionId` is the runtime's owning session (captured when this runtime
    // was built by the singleton router), NOT a value read from a module-global.
    // This runtime's approval memory / changed files are private to that chat,
    // so there is no cross-session state to reset and no first-turn heuristic.
    console.log(
      `[DeepAgent] >>> chat turn entered DeepAgent wrapper | session=${sessionId} | model=${(underlying as any).title ?? underlying.model} | messages=${messages.length} | roots=${describeRoots(rootOverride)}`,
    );
    onInvoke?.();

    // Expose this turn's abort signal so the execute tool can interrupt a
    // running terminal command when the user presses "Stop" (otherwise the
    // tool await stays pending and the turn hangs on "processing").
    setActiveTurnAbort(_signal);

    // Re-read the permission policy from VS Code settings for this turn so
    // global/workspace changes apply without a reload.
    recomputePolicy();

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
      run = await agent.streamEvents({ messages: lcMessages }, {
        version: "v3",
        configurable: { thread_id: threadId },
        // Propagate the turn's abort signal into LangGraph so "Stop" actually
        // cancels the agent run (and its in-flight LLM fetch). Previously the
        // signal was only used to interrupt terminal commands, so the agent
        // kept generating after the user pressed Stop.
        signal: _signal,
      } as any);
      console.log(
        `[DeepAgent] agent.streamEvents started | session=${sessionId} abortedAtStart=${_signal?.aborted ?? "no-signal"}`,
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(
        "[DeepAgent] agent run failed |",
        err.message,
        "\nSTACK:",
        err.stack,
      );
      yield {
        role: "assistant",
        content: "DeepAgent error: " + err.message,
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
            if (_signal?.aborted) {
              console.log(`[DeepAgent] textProducer stops: signal aborted`);
              break;
            }
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
                if (_signal?.aborted) break;
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
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(
            `[DeepAgent] messages stream failed | ${err.message}`,
            "\nSTACK:",
            err.stack,
          );
        }
      })();

      const toolProducer = (async () => {
        try {
          for await (const call of run.toolCalls ?? []) {
            if (_signal?.aborted) {
              console.log(`[DeepAgent] toolProducer stops: signal aborted`);
              break;
            }
            try {
              const name = call.name ?? "tool";
              const input = formatToolInput(await call.input);
              // Every tool shares one stable id between tool_call and
              // tool_result. The `deepagent-` prefix tells the GUI this tool
              // already ran inside DeepAgent — Continue's tool loop must not
              // execute it a second time.
              const isExecute = name === "execute_pwsh";
              // Every DeepAgent tool now goes through the native toolCall /
              // toolResult channel (stable id → in-place card update, Kiro
              // toolCallUpdate semantics). The GUI maps each name to a card in
              // FunctionSpecificToolCallDiv, with a generic card as fallback.
              // Old sessions still render their persisted markdown blocks via
              // rewriteDeepAgentToolBlocks — that path is untouched.
              const structured = true;
              // Give every structured tool a stable, name-based id so its card
              // updates in place (Kiro toolCallUpdate). The `deepagent-` prefix
              // tells Continue's tool loop the tool already ran inside DeepAgent.
              const structuredToolCallId = `deepagent-${name}-${
                call.id ?? uuidv4()
              }`;
              // For execute: allocate the runId BEFORE emitting the tool_call so
              // the GUI card can subscribe to `deepagentExecuteProgress[runId]`
              // the moment it mounts (Kiro's streamedShellOutput[runId] model).
              const runId = isExecute ? uuidv4() : undefined;
              if (runId) setExecuteRunId(runId);
              // Inject runId into the model-facing arguments so parsedArgs.runId
              // is available on the toolCallState in the GUI. Keep the original
              // command/input untouched for the actual tool execution.
              const toolCallArgs =
                runId && input
                  ? (() => {
                      try {
                        return JSON.stringify({
                          ...JSON.parse(input),
                          __runId: runId,
                        });
                      } catch {
                        return input;
                      }
                    })()
                  : input;
              // Track files the agent deliberately wrote/edited this session so
              // the GUI can list "changes this conversation made" after answering
              // (build artifacts from `execute` are intentionally excluded).
              if (
                name === "fs_write" ||
                // LangGraph dispatches the library-internal name; only the
                // model-facing name is `append_lines` (see ContinueLLMAdapter).
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
              // Native tool_call for user_input / MCP / execute: the GUI renders
              // it via toolCallState keyed by this stable id, so the result
              // updates in place (Kiro's toolCallUpdate semantics) with no
              // markdown-rewrite jitter. The `deepagent-` id prefix prevents
              // Continue's tool loop from running it a second time.
              if (structured) {
                queue.push({
                  kind: "toolCall",
                  toolCall: {
                    id: structuredToolCallId,
                    type: "function",
                    function: { name, arguments: toolCallArgs },
                  },
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
              // invoke_sub_agent: emit an empty envelope as a fallback so the
              // outer card always reaches "done" even if run.subagents yields no
              // handle. subagentProducer overwrites this same id with the full
              // nested tool tree (Kiro SubtaskToolCall) shortly after.
              if (name === "invoke_sub_agent") {
                let subName = "sub-agent";
                try {
                  const obj = JSON.parse(input) as { name?: unknown };
                  if (typeof obj.name === "string") subName = obj.name;
                } catch {
                  /* keep default */
                }
                queue.push({
                  kind: "toolResult",
                  toolCallId: structuredToolCallId,
                  content: JSON.stringify({
                    __subagent: true,
                    name: subName,
                    final: output,
                    children: [],
                  }),
                });
                continue;
              }
              if (structured) {
                // Complete the structured tool call: same toolCallId, so the GUI
                // updates the existing card's status/output in place (Kiro's
                // toolCallUpdate semantics) instead of creating a new card.
                // For execute, attach runId to the envelope so the card can stop
                // subscribing to live progress and show the final result even if
                // a progress chunk was missed.
                let finalContent = output;
                if (runId) {
                  try {
                    const envelope = JSON.parse(output) as Record<
                      string,
                      unknown
                    >;
                    finalContent = JSON.stringify({ ...envelope, runId });
                  } catch {
                    finalContent = JSON.stringify({
                      output,
                      exitCode: null,
                      runId,
                    });
                  }
                }
                queue.push({
                  kind: "toolResult",
                  toolCallId: structuredToolCallId,
                  content: finalContent,
                });
              } else {
                queue.push({
                  kind: "text",
                  text: formatToolBlock(name, input, output),
                });
              }
            } catch {
              // ignore individual tool-event failures
            }
          }
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(
            `[DeepAgent] toolCalls stream failed | ${err.message}`,
            "\nSTACK:",
            err.stack,
          );
        }
      })();

      // Kiro SubtaskToolCall: collect each subagent's own tool calls from the
      // native `run.subagents` projection and stream them into the GUI as a
      // JSON envelope on the SAME toolCallId as the outer invoke_sub_agent.
      // The GUI renders a nested tool group inside the Sub-agent card. `cause`
      // links the subagent run back to its triggering tool_call_id (verified in
      // langchain/dist/agents/transformers/subagent.js).
      const runSubagentProducer = async () => {
        type Child = {
          name: string;
          input: string;
          output: string;
          status: string;
          children?: Child[];
        };

        const collect = async (
          sub: any,
          depth: number,
        ): Promise<{ children: Child[]; final: string }> => {
          const children: Child[] = [];
          const toolCallId = `deepagent-invoke_sub_agent-${
            sub.cause?.tool_call_id ?? ""
          }`;
          let final = "";
          // Push the whole envelope on every change — same toolCallId means the
          // GUI updates one card in place (Kiro tool_call_update semantics).
          const emit = () => {
            queue.push({
              kind: "toolResult",
              toolCallId,
              content: JSON.stringify({
                __subagent: true,
                name: sub.name ?? "sub-agent",
                final,
                children,
              }),
            });
          };

          if (depth < 3) {
            for await (const call of sub.toolCalls ?? []) {
              if (_signal?.aborted) break;
              const child: Child = {
                name: call.name ?? "tool",
                input: formatToolInput(await call.input),
                output: "",
                status: "pending",
              };
              children.push(child);
              emit(); // tool-call row appears immediately
              try {
                child.output = formatToolOutput(await call.output);
                child.status = String(await call.status);
              } catch (err) {
                child.status = "error";
                child.output =
                  "error: " +
                  (err instanceof Error ? err.message : String(err));
              }
              emit(); // output fills in place
            }
            // Grandchild subagents (nested delegation) — same shape.
            for await (const nested of sub.subagents ?? []) {
              const nestedData = await collect(nested, depth + 1);
              children.push({
                name: `sub-agent: ${nested.name ?? "agent"}`,
                input: "",
                output: nestedData.final,
                status: "completed",
                children: nestedData.children,
              } as Child);
              emit();
            }
          }
          // Final assistant text from the subagent (outer result fallback).
          try {
            for await (const msg of sub.messages ?? []) {
              for await (const token of msg.text ?? []) final += token;
            }
          } catch {
            /* subagent text is best-effort */
          }
          emit();
          return { children, final };
        };

        try {
          for await (const sub of run.subagents ?? []) {
            if (_signal?.aborted) break;
            await collect(sub, 0);
          }
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e));
          console.error(`[DeepAgent] subagents stream failed | ${err.message}`);
        }
      };

      // textProducer streams tokens live. toolProducer must finish before
      // subagentProducer so its placeholder envelope (children: []) is pushed
      // first — the subagent's full envelope then overwrites the same id.
      // run.subagents is log-backed (StreamChannel), so iterating it after the
      // tool stream still yields every handle.
      await Promise.all([textProducer, toolProducer]);
      await runSubagentProducer();
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
          const decisions = await requestHitlDecision(
            payload,
            _signal,
            sessionId,
          );
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
        } else if (piece.kind === "toolCall") {
          // Native structured tool call — the GUI renders it via toolCallState
          // keyed by this stable id, so the card never jitters on updates.
          yield {
            role: "assistant",
            content: "",
            toolCalls: [piece.toolCall],
            metadata: { deepAgentToolCall: true },
          } as ChatMessage;
        } else if (piece.kind === "toolResult") {
          // Same toolCallId → GUI updates the existing card in place (done +
          // output), and `deepAgentTool` tells it NOT to re-execute the tool.
          yield {
            role: "tool",
            content: piece.content,
            toolCallId: piece.toolCallId,
            metadata: { deepAgentTool: true },
          } as ChatMessage;
        } else {
          yield { role: "assistant", content: piece.text };
        }
      }
      await agentLoop;
      console.log(
        `[DeepAgent] <<< chat turn done | chars=${answerChars} | tools=${toolCount}`,
      );
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      console.error(
        `[DeepAgent] <<< chat turn interrupted | ${err.message}`,
        "\nSTACK:",
        err.stack,
      );
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

  return { streamChat };
}

/**
 * The singleton model wrapper attached by `applyDeepAgentWrap`. `core` holds a
 * single reference to this object, so it cannot be replaced per session.
 * Instead it acts as a router: on each turn it extracts the owning session id
 * from `messageOptions` and delegates to that session's isolated runtime,
 * creating one on first use. Session A and B therefore get independent agents,
 * approval memory and changed-file sets even though they share this wrapper.
 */
export function wrapWithDeepAgent(
  underlying: ILLM,
  rootOverride: string | undefined,
  onInvoke?: () => void,
  getConfig?: () => Promise<ContinueConfig | undefined>,
): ILLM {
  // Clone the model: inherit its prototype (all methods) and copy its own
  // instance fields (title, provider, options, capabilities, ...).
  const wrapper: any = Object.create(Object.getPrototypeOf(underlying));
  Object.assign(wrapper, underlying);
  wrapper.__deepAgent = true;
  wrapper.__original = underlying;

  const runtimes = new Map<string, SessionRuntime>();
  const runtimePromises = new Map<string, Promise<SessionRuntime>>();
  const DEFAULT_SESSION_ID = "__default__";

  wrapper.streamChat = async function* (
    messages: ChatMessage[],
    signal: AbortSignal,
    options: CompletionOptions,
    messageOptions?: any,
  ): AsyncGenerator<ChatMessage> {
    const sessionId: string =
      messageOptions?.sessionId ??
      messageOptions?.chatSessionId ??
      DEFAULT_SESSION_ID;
    let runtime = runtimes.get(sessionId);
    if (!runtime) {
      let pending = runtimePromises.get(sessionId);
      if (!pending) {
        pending = buildSessionRuntime(
          underlying,
          rootOverride,
          sessionId,
          onInvoke,
          getConfig,
        ).then((built) => {
          runtimes.set(sessionId, built);
          runtimePromises.delete(sessionId);
          return built;
        });
        runtimePromises.set(sessionId, pending);
      }
      runtime = await pending;
    }
    yield* runtime.streamChat(messages, signal, options, messageOptions);
  };

  return wrapper as ILLM;
}
