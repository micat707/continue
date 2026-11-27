import { useMemo, useRef, useState, useEffect, useContext } from "react";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import {
  getExecuteBuffer,
  getExecuteDone,
  subscribeExecuteProgress,
} from "./executeProgressStore";

interface CommandOutcomeCardProps {
  /** JSON produced by rewriteDeepAgentToolBlocks. */
  payload: string;
}

interface CommandCardData {
  command: string;
  output: string;
  exitCode: number | null;
  cwd?: string;
  /** True while the command is still executing (pending card). */
  running?: boolean;
  /** Identifies this execution run; used to subscribe to live progress. */
  runId?: string;
}

function parsePayload(payload: string): CommandCardData | undefined {
  try {
    const data = JSON.parse(payload);
    if (typeof data?.command === "string") {
      return {
        command: data.command,
        output: typeof data.output === "string" ? data.output : "",
        exitCode: typeof data.exitCode === "number" ? data.exitCode : null,
        cwd: typeof data.cwd === "string" ? data.cwd : undefined,
        running: data.running === true,
        runId: typeof data.runId === "string" ? data.runId : undefined,
      };
    }
  } catch {
    // Fall through to the plain-text fallback below.
  }
  return undefined;
}

/**
 * Kiro-style `agent-outcome` card for a deepagents `execute` (shell command)
 * call rendered inside the main chat's markdown stream. Mirrors Kiro's
 * "Run Command" outcome: a one-row summary (terminal icon + title + cwd) that
 * expands to reveal the command and its terminal output, separated by a
 * divider. Success/failure is conveyed by the icon color and the output's
 * `data-failed` flag — exactly like Kiro.
 *
 * While the command is still running, the card accumulates the command's FULL
 * output (streamed as incremental chunks via the `deepagentExecuteProgress`
 * event, keyed by runId) into a scroll-capped window — so the user can scroll
 * back through the command's whole history without leaving the chat. When the
 * completion event arrives, the card flips in place (stops spinning, colors
 * green/red) using the accumulated output, so there is no jarring content swap.
 */
export function CommandOutcomeCard({ payload }: CommandOutcomeCardProps) {
  const [expanded, setExpanded] = useState(false);
  const ideMessenger = useContext(IdeMessengerContext);
  const data = useMemo(() => parsePayload(payload.trim()), [payload]);

  const scrollRef = useRef<HTMLPreElement>(null);
  // A running card's content comes from the per-run progress store (keyed by
  // runId) — the accumulated full output plus the completion state — not from
  // the static markdown payload. When `done` arrives we keep showing the same
  // accumulated text, only flipping the spinner/colour so the transition is
  // seamless (no content swap). Fall back to the payload for non-live cards.
  const isLive = Boolean(data.running && data.runId);
  const [live, setLive] = useState(() =>
    isLive
      ? {
          text: getExecuteBuffer(data.runId as string),
          done: getExecuteDone(data.runId as string).done,
          exitCode: getExecuteDone(data.runId as string).exitCode,
        }
      : { text: data.output, done: !data.running, exitCode: data.exitCode },
  );
  useEffect(() => {
    if (!isLive) return;
    const runId = data.runId as string;
    const unsubscribe = subscribeExecuteProgress(runId, () => {
      const d = getExecuteDone(runId);
      setLive({
        text: getExecuteBuffer(runId),
        done: d.done,
        exitCode: d.exitCode,
      });
    });
    // Do NOT clear the run here: a native toolCall card may remount while the
    // command is still running (status change, session refresh). The store is
    // self-cleaning once done (see subscribeExecuteProgress unsubscribe) and
    // capped at MAX_LIVE_BYTES, so leaving it is both safe and race-free.
    return unsubscribe;
  }, [isLive, data.runId]);

  // Keep auto-scrolling to the newest line unless the user scrolled up to read
  // history (then we leave their position alone until they return to the bottom).
  const stick = useRef(true);
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  };
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [live.text]);

  if (!data) {
    return <pre className="whitespace-pre-wrap text-xs">{payload}</pre>;
  }

  const { command, output, cwd } = data;
  // For a live (running) card we render from the accumulated buffer; otherwise
  // from the static markdown payload. `effectiveRunning` is false once the
  // completion event has flipped the live card in place.
  const viewText = isLive ? live.text : output;
  const effectiveRunning = isLive && !live.done;
  // `exitCode === null` means UNKNOWN, not failed: the command timed out, was
  // interrupted, or the terminal never reported an exit status (this fork's
  // shell integration doesn't always fire the end event). Only an EXPLICIT
  // non-zero code is a failure — painting "unknown" red made successful
  // builds (BUILD SUCCESS in the terminal) show a red status icon.
  const exitCode = live.exitCode;
  const viewFailed = effectiveRunning
    ? false
    : exitCode !== null && exitCode !== 0;
  // Unknown exit status → amber "pending" badge, distinct from red "failed".
  const viewUnknown = !effectiveRunning && exitCode === null;
  const statusClass = effectiveRunning
    ? "agent-icon-inProgress"
    : viewFailed
      ? "agent-icon-error"
      : viewUnknown
        ? "agent-icon-pending"
        : "agent-icon-accepted";

  return (
    <div
      className={`agent-outcome agent-outcome-command${
        effectiveRunning ? "agent-outcome-running" : ""
      }`}
    >
      <div
        className="agent-outcome-summary cursor-pointer"
        onClick={() => setExpanded(!expanded)}
        title="Toggle command output"
      >
        <span className={`agent-outcome-status ${statusClass}`}>
          <i
            className={`kiro-icon codicon ${
              effectiveRunning ? "codicon-loading" : "codicon-terminal"
            }`}
          />
        </span>
        <span className="tool-call-title">Run Command</span>
        {/* The conclusion belongs on the card itself — otherwise the user has
            to expand the card and scroll to the very bottom of the output to
            find out whether the command succeeded. */}
        {!effectiveRunning && (
          <span className={`kiro-command-status ${statusClass}`}>
            {viewFailed
              ? `✗ 失败 (exit ${exitCode})`
              : viewUnknown
                ? "⚠ 状态未知"
                : "✓ 成功"}
          </span>
        )}
        {cwd && (
          <span
            className="kiro-command-cwd"
            title={`Working directory: ${cwd}`}
          >
            {cwd}
          </span>
        )}
        {/* Jump to the real integrated terminal where the command ran, so the
            user can watch the full live output if the card's capped window is
            not enough. */}
        <i
          className="kiro-icon codicon codicon-terminal kiro-card-terminal-link"
          title="在终端中查看实时输出"
          onClick={(e) => {
            e.stopPropagation();
            ideMessenger?.post("showAgentTerminal", {});
          }}
        />
        <i
          className={`kiro-icon codicon codicon-chevron-right outcome-chevron ${
            expanded ? "expanded" : ""
          }`}
        />
      </div>

      {expanded && (
        <div className="agent-outcome-details">
          <pre className="kiro-command-text">{command}</pre>
          <hr className="agent-outcome-divider" />
          {effectiveRunning ? (
            <>
              <pre
                className="kiro-terminal-content running"
                ref={scrollRef}
                onScroll={onScroll}
              >
                {viewText.length > 0 ? viewText : "（命令执行中…）"}
              </pre>
              <div className="kiro-running-hint">
                实时输出（可滚动查看完整历史）。完整实时流请点右上角终端图标。
              </div>
            </>
          ) : (
            <>
              <pre
                className="kiro-terminal-content"
                data-failed={viewFailed ? "true" : "false"}
              >
                {viewText.length > 0 ? viewText : "（无输出）"}
              </pre>
              {viewUnknown && (
                <div className="kiro-running-hint">
                  退出码未知（命令超时、被中断，或终端未回传退出码）——
                  状态未知不等于失败， 请点右上角终端图标查看命令的真实结局。
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

export default CommandOutcomeCard;
