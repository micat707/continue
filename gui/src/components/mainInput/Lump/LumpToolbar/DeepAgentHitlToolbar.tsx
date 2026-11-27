import { selectActiveSession } from "../../../../redux/slices/sessionSlice";
import { useContext, useRef, useState } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useWebviewListener } from "../../../../hooks/useWebviewListener";
import { useAppSelector } from "../../../../redux/hooks";
import {
  clearHitlPending,
  markHitlPending,
} from "../../../../util/hitlPendingStore";
import type { ReviewChangeItem } from "./ReviewChangesCard";
import type {
  PathPattern,
  PermissionChoice,
  PermissionScope,
  PermissionScopeRequest,
} from "./PermissionScopeDialog";

export interface HitlDecision {
  id: string;
  type: "approve" | "reject";
  /** Kiro-style "Apply to" selection for path approvals. */
  scope?: PermissionScope;
  /** Kiro-style path pattern: exact path / parent directory / all. */
  pathPattern?: PathPattern;
  /** Directory (or `**`) that the backend should remember as trusted. */
  trustedDir?: string;
}

interface PendingAction {
  name?: string;
  args?: Record<string, unknown>;
}

interface PendingConfirmation {
  requestId: string;
  actions: PendingAction[];
  idx: number;
  toolName: string;
  path: string;
}

/**
 * Present the pending tool call as a FILE-ACCESS permission request, not a
 * command approval: the label is what the user is granting (read / write /
 * delete on a path), and the scope note tells them what approving remembers
 * (see the read-only grant logic in DeepAgentLLM's effectiveAction).
 */
function describePermission(
  name: string,
): { verb: string; scope: "read" | "write" } | null {
  switch (name) {
    case "read_file":
    case "read_files":
      return { verb: "读取文件", scope: "read" };
    case "list_directory":
    case "ls":
      return { verb: "读取目录", scope: "read" };
    case "file_search":
    case "grep_search":
    case "glob":
    case "grep":
      return { verb: "搜索（只读）", scope: "read" };
    case "fs_write":
    case "write_file":
      return { verb: "写入文件", scope: "write" };
    case "fs_append":
      return { verb: "追加文件", scope: "write" };
    case "str_replace":
    case "edit_file":
      return { verb: "编辑文件", scope: "write" };
    case "delete_file":
    case "delete":
      return { verb: "删除", scope: "write" };
    default:
      return null;
  }
}

/**
 * Watch for a DeepAgent human-in-the-loop interrupt (`deepAgentInterrupt` from
 * the IDE) and expose the pending approval items plus the decision callbacks.
 * The IDE pauses the agent until `deepAgentInterruptResponse` arrives.
 *
 * Designed to be mounted once (in LumpToolbar); it returns `active` so the
 * caller can render the ReviewChangesCard inside the Lump toolbar ladder.
 */
interface PendingApproval {
  requestId: string;
  /** The chat session that was active when the interrupt arrived. */
  sessionId: string | undefined;
  items: ReviewChangeItem[];
  actions: PendingAction[];
}

export function useDeepAgentHitl() {
  const ideMessenger = useContext(IdeMessengerContext);
  const currentSessionId = useAppSelector(
    (state) => selectActiveSession(state).id,
  );
  // useWebviewListener registers its handler once; read the live session id
  // through a ref so the approval is stamped with the session that is actually
  // displayed when the interrupt message arrives.
  const currentSessionIdRef = useRef(currentSessionId);
  currentSessionIdRef.current = currentSessionId;

  // Keyed by requestId, so two sessions paused on approvals do not clobber each
  // other, and a decision is always routed back to its own request.
  const [pending, setPending] = useState<Record<string, PendingApproval>>({});
  // After a path-bearing Accept, Kiro enters a `confirm` stage: choose the
  // trusted path pattern and the scope before actually sending the decision.
  const [confirming, setConfirming] = useState<PendingConfirmation | null>(
    null,
  );

  useWebviewListener("deepAgentInterrupt", async (payload: any) => {
    const req = payload?.request;
    const requestId = payload?.requestId as string | undefined;
    if (!requestId) {
      console.warn("[DeepAgentHitl] interrupt without requestId, ignoring");
      return;
    }
    const actions = (req?.actionRequests ?? []) as PendingAction[];
    // Prefer the session id stamped at the source (DeepAgentLLM) and carried by
    // the protocol. Only fall back to the currently displayed session when an
    // older IDE build omits it — reading `currentSessionIdRef` here was the
    // root cause of approval cards appearing in the wrong chat: the interrupt
    // can arrive after the user has already switched tabs.
    const ownerSessionId: string | undefined =
      payload?.sessionId ?? currentSessionIdRef.current;
    // Tell the stream watchdog that this session is waiting on a human, not
    // on model output; otherwise it aborts after 3 minutes of silence.
    markHitlPending(ownerSessionId);

    const items = actions.map((a, i): ReviewChangeItem => {
      // Command approval: the human must see the FULL command before
      // deciding. It is shown in the description (the filename chip is
      // path-specific and would mangle the command). Approving grants this
      // one run only — there is no session memory for commands.
      if (
        a.name === "execute" ||
        a.name === "execute_pwsh" ||
        a.name === "execute_bash"
      ) {
        const command =
          typeof a.args?.command === "string" ? a.args.command : "";
        return {
          id: String(i),
          label: "执行命令",
          filename: undefined,
          description: command
            ? `将在 shell 中执行：${command}　（批准仅对本次命令生效）`
            : "批准后执行该命令（批准仅对本次命令生效）",
          onAccept: () => decide(requestId, actions, i, "approve"),
          onReject: () => decide(requestId, actions, i, "reject"),
        };
      }
      // Background-process start launches an arbitrary shell command too —
      // same risk profile as `execute`, so the human must also see the FULL
      // command.
      if (
        (a.name === "control_process" || a.name === "control_pwsh_process") &&
        a.args?.action === "start"
      ) {
        const command =
          typeof a.args?.command === "string" ? a.args.command : "";
        return {
          id: String(i),
          label: "启动后台进程",
          filename: undefined,
          description: command
            ? `将在后台 shell 中启动：${command}　（批准仅对本次命令生效）`
            : "批准后在后台启动该进程（批准仅对本次命令生效）",
          onAccept: () => decide(requestId, actions, i, "approve"),
          onReject: () => decide(requestId, actions, i, "reject"),
        };
      }
      const p =
        a.args?.file_path ??
        a.args?.path ??
        a.args?.targetFile ??
        (Array.isArray(a.args?.paths) ? a.args.paths[0] : undefined);
      const perm = describePermission(String(a.name ?? ""));
      const label = perm?.verb ?? a.name ?? "tool";
      return {
        id: String(i),
        label,
        filename: typeof p === "string" ? p : undefined,
        description: perm
          ? perm.scope === "read"
            ? "批准后将选择授权目录及生效范围；读取授权不会自动放开写入"
            : "批准后将选择授权目录及生效范围"
          : undefined,
        onAccept: () => {
          if (perm && typeof p === "string") {
            setConfirming({
              requestId,
              actions,
              idx: i,
              toolName: String(a.name ?? ""),
              path: p,
            });
            return;
          }
          decide(requestId, actions, i, "approve");
        },
        onReject: () => decide(requestId, actions, i, "reject"),
      };
    });

    setPending((prev) => ({
      ...prev,
      [requestId]: { requestId, sessionId: ownerSessionId, items, actions },
    }));

    // Single file-access action: skip the plain Approve/Reject card entirely
    // and open the Kiro-style panel directly, defaulting to "This session".
    // Multiple actions / commands still use the first card so the user sees
    // everything being authorized.
    if (actions.length === 1) {
      const a = actions[0];
      const p =
        a.args?.file_path ??
        a.args?.path ??
        a.args?.targetFile ??
        (Array.isArray(a.args?.paths) ? a.args.paths[0] : undefined);
      const perm = describePermission(String(a.name ?? ""));
      if (perm && typeof p === "string") {
        setConfirming({
          requestId,
          actions,
          idx: 0,
          toolName: String(a.name ?? ""),
          path: p,
        });
        return;
      }
    }
    setConfirming(null);
  });

  const send = (requestId: string, decisions: HitlDecision[]) => {
    // Echo the owning session so the IDE resolves this specific session's
    // pending request (defensive — requestId is already unique, but the id
    // makes the routing explicit and audit-able).
    const owner = pending[requestId]?.sessionId;
    clearHitlPending(owner);
    void ideMessenger.post("deepAgentInterruptResponse", {
      requestId,
      sessionId: owner,
      decisions,
    });
    setPending((prev) => {
      const next = { ...prev };
      delete next[requestId];
      return next;
    });
  };

  // Decisions must be a full parallel array to the interrupt's actionRequests
  // (LangGraph validates the length), so build from this request's actions.
  const decide = (
    requestId: string,
    actions: PendingAction[],
    idx: number,
    type: "approve" | "reject",
  ) => {
    send(
      requestId,
      actions.map((_, i) => ({
        id: String(i),
        type: i === idx ? type : "reject",
      })),
    );
  };

  const confirmPermission = (choice: PermissionChoice) => {
    if (!confirming) return;
    const { requestId, actions, idx } = confirming;
    send(
      requestId,
      actions.map((_, i) =>
        i === idx
          ? {
              id: String(i),
              type: "approve" as const,
              scope: choice.scope,
              pathPattern: choice.pattern,
              trustedDir: choice.trustedDir,
            }
          : { id: String(i), type: "reject" as const },
      ),
    );
    setConfirming(null);
  };

  const bulk = (
    requestId: string,
    actions: PendingAction[],
    type: "approve" | "reject",
  ) => {
    send(
      requestId,
      actions.map((_, i) => ({ id: String(i), type })),
    );
  };

  // Only render the approval that belongs to the currently displayed session.
  // When the user switches chat sessions, the other session's card disappears
  // here while its agent stays paused until that session's decision arrives.
  const mine = Object.values(pending).filter(
    (p) => p.sessionId === currentSessionId,
  );
  const activeApproval = mine[mine.length - 1];

  const scopeRequest: PermissionScopeRequest | undefined =
    confirming && pending[confirming.requestId]?.sessionId === currentSessionId
      ? {
          toolName: confirming.toolName,
          path: confirming.path,
          onConfirm: confirmPermission,
          onCancel: () => setConfirming(null),
        }
      : undefined;

  return {
    active: Boolean(activeApproval),
    items: activeApproval?.items ?? [],
    bulkApprove: () =>
      activeApproval &&
      bulk(activeApproval.requestId, activeApproval.actions, "approve"),
    bulkReject: () =>
      activeApproval &&
      bulk(activeApproval.requestId, activeApproval.actions, "reject"),
    scopeRequest,
  };
}
