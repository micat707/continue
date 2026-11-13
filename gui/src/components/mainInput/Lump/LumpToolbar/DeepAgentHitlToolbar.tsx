import { useContext, useRef, useState } from "react";
import { IdeMessengerContext } from "../../../../context/IdeMessenger";
import { useWebviewListener } from "../../../../hooks/useWebviewListener";
import type { ReviewChangeItem } from "./ReviewChangesCard";

export interface HitlDecision {
  id: string;
  type: "approve" | "reject";
}

interface PendingAction {
  name?: string;
  args?: Record<string, unknown>;
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
      return { verb: "读取文件", scope: "read" };
    case "ls":
      return { verb: "读取目录", scope: "read" };
    case "glob":
    case "grep":
      return { verb: "搜索（只读）", scope: "read" };
    case "write_file":
      return { verb: "写入文件", scope: "write" };
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
export function useDeepAgentHitl() {
  const ideMessenger = useContext(IdeMessengerContext);
  const [items, setItems] = useState<ReviewChangeItem[]>([]);
  // The pending actionRequests live in a ref (not state) so the decision
  // builders never read a stale closure: item callbacks created during one
  // render must still see the full action list when clicked later.
  const actionsRef = useRef<PendingAction[]>([]);

  useWebviewListener("deepAgentInterrupt", async (payload: any) => {
    const req = payload?.request;
    const actions = (req?.actionRequests ?? []) as PendingAction[];
    actionsRef.current = actions;
    setItems(
      actions.map((a, i) => {
        // Command approval: the human must see the FULL command before
        // deciding. It is shown in the description (the filename chip is
        // path-specific and would mangle the command). Approving grants this
        // one run only — there is no session memory for commands.
        if (a.name === "execute") {
          const command =
            typeof a.args?.command === "string" ? a.args.command : "";
          return {
            id: String(i),
            label: "执行命令",
            filename: undefined,
            description: command
              ? `将在 shell 中执行：${command}　（批准仅对本次命令生效）`
              : "批准后执行该命令（批准仅对本次命令生效）",
            onAccept: () => decide(i, "approve"),
            onReject: () => decide(i, "reject"),
          };
        }
        // Background-process start launches an arbitrary shell command too —
        // same risk profile as `execute`, so the human must also see the FULL
        // command. (Without this branch it fell into the path branch below,
        // which has no file_path for control_process: the card rendered a bare
        // "control_process" chip with no command and the wrong fallback title.)
        if (a.name === "control_process" && a.args?.action === "start") {
          const command =
            typeof a.args?.command === "string" ? a.args.command : "";
          return {
            id: String(i),
            label: "启动后台进程",
            filename: undefined,
            description: command
              ? `将在后台 shell 中启动：${command}　（批准仅对本次命令生效）`
              : "批准后在后台启动该进程（批准仅对本次命令生效）",
            onAccept: () => decide(i, "approve"),
            onReject: () => decide(i, "reject"),
          };
        }
        const p = a.args?.file_path ?? a.args?.path;
        const perm = describePermission(String(a.name ?? ""));
        return {
          id: String(i),
          label: perm?.verb ?? a.name ?? "tool",
          filename: typeof p === "string" ? p : undefined,
          description: perm
            ? perm.scope === "read"
              ? "批准后将允许本会话读取该路径及其子内容（其他读取工具同样免审批）；写入操作仍会单独询问"
              : "批准后将允许本会话对该路径及其子内容执行此操作"
            : undefined,
          onAccept: () => decide(i, "approve"),
          onReject: () => decide(i, "reject"),
        };
      }),
    );
  });

  const send = (decisions: HitlDecision[]) => {
    void ideMessenger.post("deepAgentInterruptResponse", { decisions });
    actionsRef.current = [];
    setItems([]);
  };

  // Decisions must be a full parallel array to the interrupt's actionRequests
  // (LangGraph validates the length), so build from the ref, not from `items`.
  const decide = (idx: number, type: "approve" | "reject") => {
    send(
      actionsRef.current.map((_, i) => ({
        id: String(i),
        type: i === idx ? type : "reject",
      })),
    );
  };

  const bulk = (type: "approve" | "reject") => {
    send(actionsRef.current.map((_, i) => ({ id: String(i), type })));
  };

  return {
    active: items.length > 0,
    items,
    bulkApprove: () => bulk("approve"),
    bulkReject: () => bulk("reject"),
  };
}
