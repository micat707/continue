import { useMemo } from "react";

interface UserInputOutcomeCardProps {
  /** JSON produced by rewriteDeepAgentToolBlocks. */
  payload: string;
}

interface UserInputCardData {
  question: string;
  answer: string;
  pending?: boolean;
}

function parsePayload(payload: string): UserInputCardData | undefined {
  try {
    const data = JSON.parse(payload);
    if (
      typeof data?.question === "string" &&
      typeof data?.answer === "string"
    ) {
      return {
        question: data.question,
        answer: data.answer,
        pending: Boolean(data.pending),
      };
    }
  } catch {
    // fall through
  }
  return undefined;
}

/**
 * Kiro-style `tool-call-view` summary for an ANSWERED `user_input` question.
 * Mirrors kiro-ui-agent-chat's agent-outcome row: a pending question glyph +
 * the question text in the title, with the selected answer shown muted below.
 * This keeps answered clarifications visible in the chat flow (the live
 * interactive card itself lives above the input box and disappears after the
 * answer is submitted).
 */
export function UserInputOutcomeCard({ payload }: UserInputOutcomeCardProps) {
  const data = useMemo(() => parsePayload(payload.trim()), [payload]);

  if (!data) {
    return <pre className="whitespace-pre-wrap text-xs">{payload}</pre>;
  }

  return (
    <div className="agent-outcome user-input-outcome">
      <div className="agent-outcome-summary">
        <i
          className={`kiro-icon codicon codicon-question ${
            data.pending ? "agent-icon-pending" : "agent-icon-accepted"
          }`}
        />
        <span className="tool-call-title">{data.question}</span>
      </div>
      {data.pending ? (
        <div className="user-input-outcome-answer user-input-outcome-waiting">
          Waiting for your answer…
        </div>
      ) : (
        data.answer && (
          <div className="user-input-outcome-answer">{data.answer}</div>
        )
      )}
    </div>
  );
}

export default UserInputOutcomeCard;
