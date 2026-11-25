/**
 * Native toolCall card for DeepAgent `execute_pwsh`.
 *
 * Kiro's model: a tool call has a stable id; live output is keyed by runId in a
 * separate store; the completed result updates the SAME view in place. Here the
 * toolCallState (sessionSlice.history) supplies the stable id + final output,
 * while `executeProgressStore[runId]` supplies the live stream — and this card
 * simply projects both into the existing CommandOutcomeCard payload so that
 * all visual behaviour (spinner, exit code, terminal link, scroll) is shared
 * with the markdown path.
 */

import { useEffect, useMemo, useState } from "react";
import type { ToolCallState } from "core";
import {
  getExecuteBuffer,
  getExecuteDone,
  subscribeExecuteProgress,
} from "../../../components/StyledMarkdownPreview/executeProgressStore";
import { CommandOutcomeCard } from "../../../components/StyledMarkdownPreview/CommandOutcomeCard";

interface ExecuteEnvelope {
  output: string;
  exitCode?: number | null;
  truncated?: boolean;
  runId?: string;
}

function parseEnvelope(
  content: string | undefined,
): ExecuteEnvelope | undefined {
  if (!content) return undefined;
  try {
    const parsed = JSON.parse(content) as ExecuteEnvelope;
    if (typeof parsed.output === "string") return parsed;
  } catch {
    // toolResult may be a plain string when the tool failed early
  }
  return { output: content };
}

export function ExecutePwshCard({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  const args = toolCallState.parsedArgs as
    | { command?: string; cwd?: string; __runId?: string }
    | undefined;
  const command = args?.command ?? "";
  const cwd = args?.cwd;
  const argsRunId = args?.__runId;
  const done = toolCallState.status === "done";
  const envelope = useMemo(
    () => parseEnvelope(toolCallState.output?.[0]?.content),
    [toolCallState.output],
  );
  const finalRunId = envelope?.runId ?? argsRunId;

  // While running, mirror the live store into local state so the payload passed
  // to CommandOutcomeCard changes (and thus re-renders) on every chunk. This is
  // exactly Kiro's `appendShellChunk(runId, chunk)` → subscribed card update.
  const [liveText, setLiveText] = useState("");
  useEffect(() => {
    if (done || !argsRunId) return;
    setLiveText(getExecuteBuffer(argsRunId));
    return subscribeExecuteProgress(argsRunId, () => {
      setLiveText(getExecuteBuffer(argsRunId));
    });
  }, [done, argsRunId]);

  const payload = useMemo(() => {
    const isRunning = !done;
    const liveDone = argsRunId ? getExecuteDone(argsRunId) : undefined;
    const running = isRunning && !liveDone?.done;
    const output =
      isRunning && argsRunId
        ? liveText
        : (envelope?.output ?? toolCallState.output?.[0]?.content ?? "");
    const exitCode = isRunning
      ? (liveDone?.exitCode ?? null)
      : (envelope?.exitCode ?? null);
    return JSON.stringify({
      command,
      output,
      exitCode,
      cwd,
      running,
      runId: finalRunId,
    });
  }, [
    command,
    cwd,
    done,
    envelope,
    liveText,
    argsRunId,
    finalRunId,
    toolCallState.output,
  ]);

  return <CommandOutcomeCard payload={payload} />;
}
