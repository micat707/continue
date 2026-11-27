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

export type QuestionItem = {
  question: string;
  options: Option[];
  multiple?: boolean;
};

/** Models often don't set `multiple` but write "(可多选)" in the question. */
function isMultiSelect(item: QuestionItem): boolean {
  return (
    item.multiple === true ||
    /可多选|多选|multi[- ]?select|select (all|any|several)/i.test(item.question)
  );
}

/** A, B, C … (AA, AB … beyond Z) for stable, scannable option labels. */
function optionLabel(index: number): string {
  let n = index + 1;
  let label = "";
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
}

export type PendingQuestion = {
  requestId: string;
  question: string;
  options: Option[];
  questions?: QuestionItem[];
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

type AnswerEntry = { label: string; question: string; value: string };

/** Split a batched "Q1: …\nQ2: …" answer into structured rows. Returns null
 * for a plain single answer so the simple renderer is used unchanged. */
function parseAnswerEntries(answer: string): AnswerEntry[] | null {
  const parts = answer
    .split(/(?=Q\d+:\s)/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;
  const entries: AnswerEntry[] = [];
  for (const part of parts) {
    const m = part.match(/^Q(\d+):\s*([\s\S]*)$/);
    if (!m) return null;
    const body = m[2];
    const arrow = body.indexOf("->");
    entries.push({
      label: `Q${m[1]}`,
      question: (arrow >= 0 ? body.slice(0, arrow) : body).trim(),
      value: (arrow >= 0 ? body.slice(arrow + 2) : "").trim(),
    });
  }
  return entries;
}

/**
 * Pure UI for the user_input question card. No protocol / toolCallState deps;
 * the chat-flow wrapper (UserInputCard) owns the IDE bridge.
 */
/** Renders the option list for one question; single- or multi-select. */
function QuestionOptions({
  options,
  selectedTitles,
  multiple,
  onToggle,
  disabled,
}: {
  options: Option[];
  selectedTitles: string[];
  multiple: boolean;
  onToggle: (title: string) => void;
  disabled: boolean;
}) {
  return (
    <div className="kiro-user-input-options">
      {options.map((o, index) => {
        const isSelected = selectedTitles.includes(o.title);
        return (
          <div
            key={o.title}
            role={multiple ? "checkbox" : "radio"}
            aria-checked={isSelected}
            tabIndex={disabled ? -1 : 0}
            onClick={() => !disabled && onToggle(o.title)}
            onKeyDown={(e) => {
              if ((e.key === "Enter" || e.key === " ") && !disabled) {
                e.preventDefault();
                onToggle(o.title);
              }
            }}
            className={`kiro-user-input-option ${isSelected ? "kiro-user-input-option--selected" : ""}`}
          >
            <div className="kiro-user-input-option-header">
              <span className="kiro-option-letter">{optionLabel(index)}.</span>
              <span className="kiro-user-input-option-title">
                {o.title}
                {o.recommended && (
                  <span className="kiro-user-input-badge">Recommended</span>
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
  );
}

export function UserInputQuestionCard({
  requestId,
  question,
  options,
  questions,
  onSubmit,
}: {
  requestId: string;
  question: string;
  options: Option[];
  questions?: QuestionItem[];
  onSubmit: (response: UserInputResponse) => void;
}) {
  // Normalize to a list so single- and multi-question modes share one renderer.
  const items: QuestionItem[] =
    questions && questions.length > 0 ? questions : [{ question, options }];
  const multi = items.length > 1;

  // One (possibly multi) selection AND one free-text answer per question.
  // Keeping the input under its own question preserves the Q↔A relationship.
  const [selected, setSelected] = useState<string[][]>(items.map(() => []));
  const [details, setDetails] = useState<string[]>(items.map(() => ""));
  const [submitted, setSubmitted] = useState(false);

  useEffect(() => {
    setSelected(items.map(() => []));
    setDetails(items.map(() => ""));
    setSubmitted(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestId]);

  const toggleOption = (index: number, title: string) => {
    setSelected((prev) => {
      const next = [...prev];
      if (isMultiSelect(items[index])) {
        next[index] = next[index].includes(title)
          ? next[index].filter((t) => t !== title)
          : [...next[index], title];
      } else {
        // Single-select: clicking the chosen one keeps it (no empty state).
        next[index] = [title];
      }
      return next;
    });
  };

  const isOther = (titles: string[]) =>
    titles.some((t) => /other|其他|type below|请描述|describe/i.test(t));

  const submitAnswer = () => {
    if (submitted) return;
    if (multi) {
      // Pair each question with its own answers (single or multi select) plus
      // its free text so the model sees which answer belongs where.
      const parts = items.map((item, i) => {
        const choices = selected[i];
        const detail = details[i].trim();
        const a = choices.length ? choices.join(", ") : "(skipped)";
        return `Q${i + 1}: ${cleanQuestion(item.question)} -> ${a}${
          detail ? ` (detail: ${detail})` : ""
        }`;
      });
      setSubmitted(true);
      onSubmit({
        requestId,
        answer: parts.join("\n"),
        subOptions: [],
        skipped: false,
      });
      return;
    }
    const answer = selected[0].join(", ") || details[0].trim();
    if (!answer) return;
    setSubmitted(true);
    onSubmit({ requestId, answer, subOptions: [], skipped: false });
  };

  const skip = () => {
    if (submitted) return;
    setSubmitted(true);
    onSubmit({ requestId, answer: "", subOptions: [], skipped: true });
  };

  const allAnswered = multi
    ? selected.every((s) => s.length > 0) ||
      details.some((d) => d.trim().length > 0)
    : Boolean(selected[0].length > 0 || details[0].trim());

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
            <div
              className={`kiro-user-input-questions ${multi ? "kiro-user-input-questions--scroll" : ""}`}
            >
              {items.map((item, i) => (
                <div className="kiro-user-input-question-block" key={i}>
                  <div className="kiro-user-input-question">
                    <div className="kiro-streaming-text">
                      <p>
                        {multi ? `${i + 1}. ` : ""}
                        {cleanQuestion(item.question)}
                      </p>
                    </div>
                  </div>
                  <QuestionOptions
                    options={item.options}
                    selectedTitles={selected[i]}
                    multiple={isMultiSelect(item)}
                    onToggle={(title) => toggleOption(i, title)}
                    disabled={submitted}
                  />
                  <textarea
                    className={`kiro-user-input-textarea kiro-user-input-question-detail ${
                      isOther(selected[i]) ? "is-highlighted" : ""
                    }`}
                    placeholder={
                      isOther(selected[i])
                        ? "请在这里描述你的选择…"
                        : "补充这个题目的答案（可选）…"
                    }
                    value={details[i]}
                    onChange={(e) =>
                      setDetails((prev) => {
                        const next = [...prev];
                        next[i] = e.target.value;
                        return next;
                      })
                    }
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (multi) e.currentTarget.blur();
                        else submitAnswer();
                      }
                    }}
                    disabled={submitted}
                    rows={1}
                  />
                </div>
              ))}
            </div>
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
                disabled={submitted || !allAnswered}
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
    | {
        question?: string;
        options?: Array<string | Option>;
        questions?: Array<{
          question?: string;
          options?: Array<string | Option>;
          multiple?: boolean;
        }>;
      }
    | undefined;
  const isPending = toolCallState.status !== "done";

  const [pending, setPending] = useState<PendingQuestion | null>(null);

  const question = args?.question ?? "";
  const options: Option[] = useMemo(
    () => asOptions(args?.options),
    [args?.options],
  );
  const questions: QuestionItem[] | undefined = useMemo(
    () =>
      args?.questions?.length
        ? args.questions.map((q) => ({
            question: q.question ?? "",
            options: asOptions(q.options),
            multiple: q.multiple,
          }))
        : undefined,
    [args?.questions],
  );

  useWebviewListener(
    "userInputRequested",
    async (data) => {
      if (!isPending) return;
      setPending({
        requestId: data.requestId,
        question: data.question,
        options: (data.options ?? []) as Option[],
        questions: (data.questions ?? undefined) as QuestionItem[] | undefined,
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
        questions: pending.questions,
      }
    : { requestId: "pending", question, options, questions };

  // Kiro's toolCallUpdate: when the tool result arrives, swap the interactive
  // question for a compact answered summary IN PLACE (same toolCallId key)
  // instead of appending a second card further down the chat.
  if (toolCallState.status === "done") {
    const answer = extractAnswer(toolCallState.output?.[0]?.content);
    const entries = answer ? parseAnswerEntries(answer) : null;
    return (
      <div className="agent-outcome user-input-outcome">
        <div className="agent-outcome-summary">
          <i className="kiro-icon codicon codicon-question agent-icon-accepted" />
          <span className="tool-call-title">
            {cleanQuestion(effective.question)}
          </span>
        </div>
        {answer && (
          <div className="agent-outcome-details">
            {entries ? (
              <div
                className="user-input-outcome-entries"
                data-testid="user-input-answer"
              >
                {entries.map((entry) => (
                  <div className="user-input-outcome-entry" key={entry.label}>
                    <span className="user-input-outcome-entry-label">
                      {entry.label}
                    </span>
                    <span className="user-input-outcome-entry-question">
                      {entry.question}
                    </span>
                    <span className="user-input-outcome-entry-arrow">→</span>
                    <span className="user-input-outcome-entry-value">
                      {entry.value || "(skipped)"}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="user-input-outcome-answer"
                data-testid="user-input-answer"
              >
                {answer}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <UserInputQuestionCard
      key={effective.requestId}
      requestId={effective.requestId}
      question={effective.question}
      options={effective.options}
      questions={effective.questions}
      onSubmit={(response) => {
        void ideMessenger.post("userInputResponse", response);
      }}
    />
  );
}
