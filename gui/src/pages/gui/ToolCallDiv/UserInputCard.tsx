import { useContext, useEffect, useMemo, useState } from "react";
import { ToolCallState } from "core";
import { IdeMessengerContext } from "../../../context/IdeMessenger";
import { useWebviewListener } from "../../../hooks/useWebviewListener";

export type Option = {
  title: string;
  description?: string;
  recommended?: boolean;
  subOptions?: Array<{ title: string; description?: string }>;
  subOptionsLabel?: string;
};

export type PendingQuestion = {
  requestId: string;
  question: string;
  options: Option[];
};

export type UserInputResponse = {
  requestId: string;
  answer: string;
  subOptions: string[];
  skipped: boolean;
};

/**
 * Models sometimes cram the whole option list into `question` as markdown
 * (e.g. "**桌面框架选项**：- [ ] **Electron**（推荐）：..."). Show only the
 * leading question line; the real choices come from the `options` array.
 */
function cleanQuestion(s: string): string {
  const firstLine = s.split("\n")[0].trim();
  return firstLine
    .replace(/[-*]\s*\[[ xX]\]\s*/g, "") // drop "- [ ] " list markers
    .replace(/\*\*/g, "") // drop markdown bold
    .replace(/[：:]\s*[-（(].*$/, "") // drop "：- ..." trailing option soup
    .trim();
}

function asOptions(raw: Array<string | Option> | undefined): Option[] {
  return (raw ?? []).map((o) => (typeof o === "string" ? { title: o } : o));
}

/** Pull the chosen answer out of Kiro's `Question ID: 0\nResponse: …` result. */
function extractAnswer(content: string | undefined): string {
  if (!content) return "";
  const match = content.match(/^Response:\s*([\s\S]*)$/m);
  const answer = (match?.[1] ?? content).trim();
  // Skip's canonical text is verbose; Kiro shows a short marker instead.
  return answer.includes("ready to move on to the next phase")
    ? "Skipped"
    : answer;
}

/**
 * Pure UI for the user_input question card. No protocol / toolCallState deps;
 * the chat-flow wrapper (UserInputCard) owns the IDE bridge.
 */
export function UserInputQuestionCard({
  requestId,
  question,
  options,
  onSubmit,
}: {
  requestId: string;
  question: string;
  options: Option[];
  onSubmit: (response: UserInputResponse) => void;
}) {
  // Kiro's kiro-user-input-option uses role="radio" → single-select.
  const [selectedTitle, setSelectedTitle] = useState<string | null>(null);
  const [freeText, setFreeText] = useState("");
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setSelectedTitle(null);
    setFreeText("");
    setSubmitted(false);
  }, [requestId]);

  const submitAnswer = () => {
    if (submitted) return;
    const answer = selectedTitle ?? freeText.trim();
    if (!answer) return;
    setSubmitted(true);
    onSubmit({ requestId, answer, subOptions: [], skipped: false });
  };

  const skip = () => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit({ requestId, answer: "", subOptions: [], skipped: true });
  };

  return (
    <div className="agent-interaction-panel" data-variant="call-to-action">
      <div className="agent-interaction-panel-content-container">
        <div className="agent-interaction-panel-header">
          <span className="agent-interaction-panel-icon">
            <i className="kiro-icon codicon codicon-question" />
          </span>
          <span className="agent-interaction-panel-title">Input required</span>
        </div>
        <div className="agent-interaction-panel-content">
          <div className="kiro-user-input-card">
            <div className="kiro-user-input-question">
              <div className="kiro-streaming-text">
                <p>{cleanQuestion(question)}</p>
              </div>
            </div>
            {options.length > 0 && (
              <div className="kiro-user-input-options">
                {options.map((o) => {
                  const isSelected = selectedTitle === o.title;
                  return (
                    <div
                      key={o.title}
                      role="radio"
                      aria-checked={isSelected}
                      tabIndex={submitted ? -1 : 0}
                      onClick={() => !submitted && setSelectedTitle(o.title)}
                      onKeyDown={(e) => {
                        if (
                          (e.key === "Enter" || e.key === " ") &&
                          !submitted
                        ) {
                          e.preventDefault();
                          setSelectedTitle(o.title);
                        }
                      }}
                      className={`kiro-user-input-option ${isSelected ? "kiro-user-input-option--selected" : ""}`}
                    >
                      <div className="kiro-user-input-option-header">
                        <span className="kiro-user-input-option-title">
                          {o.title}
                          {o.recommended && (
                            <span className="kiro-user-input-badge">
                              Recommended
                            </span>
                          )}
                        </span>
                      </div>
                      {o.description && (
                        <div className="kiro-user-input-option-description">
                          {o.description}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <textarea
              className="kiro-user-input-textarea"
              placeholder="Or type your own answer…"
              value={freeText}
              onChange={(e) => setFreeText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitAnswer();
                }
              }}
              disabled={submitted}
              rows={2}
            />
            <div className="kiro-user-input-actions">
              <button
                type="button"
                className="kiro-button"
                data-variant="secondary"
                data-purpose="default"
                data-active="false"
                data-loading="false"
                onClick={skip}
                disabled={submitted}
              >
                Cancel
              </button>
              <button
                type="button"
                className="kiro-button"
                data-variant="primary"
                data-purpose="default"
                data-active="false"
                data-loading="false"
                onClick={submitAnswer}
                disabled={submitted || (!selectedTitle && !freeText.trim())}
              >
                Submit answer
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Inline question card rendered in the chat flow from a native DeepAgent tool call. */
export function UserInputCard({
  toolCallState,
}: {
  toolCallState: ToolCallState;
}) {
  const ideMessenger = useContext(IdeMessengerContext);
  const args = toolCallState.parsedArgs as
    | { question?: string; options?: Array<string | Option> }
    | undefined;
  const isPending = toolCallState.status !== "done";

  const [pending, setPending] = useState<PendingQuestion | null>(null);

  const question = args?.question ?? "";
  const options: Option[] = useMemo(
    () => asOptions(args?.options),
    [args?.options],
  );

  useWebviewListener(
    "userInputRequested",
    async (data) => {
      if (!isPending) return;
      setPending({
        requestId: data.requestId,
        question: data.question,
        options: (data.options ?? []) as Option[],
      });
    },
    [isPending, question],
    !isPending,
  );

  const effective = pending
    ? {
        requestId: pending.requestId,
        question: pending.question,
        options: pending.options,
      }
    : { requestId: "pending", question, options };

  // Kiro's toolCallUpdate: when the tool result arrives, swap the interactive
  // question for a compact answered summary IN PLACE (same toolCallId key)
  // instead of appending a second card further down the chat.
  if (toolCallState.status === "done") {
    const answer = extractAnswer(toolCallState.output?.[0]?.content);
    return (
      <div className="agent-outcome user-input-outcome">
        <div className="agent-outcome-summary">
          <i className="kiro-icon codicon codicon-question agent-icon-accepted" />
          <span className="tool-call-title">
            {cleanQuestion(effective.question)}
          </span>
        </div>
        {answer && <div className="user-input-outcome-answer">{answer}</div>}
      </div>
    );
  }

  return (
    <UserInputQuestionCard
      key={effective.requestId}
      requestId={effective.requestId}
      question={effective.question}
      options={effective.options}
      onSubmit={(response) => {
        void ideMessenger.post("userInputResponse", response);
      }}
    />
  );
}
