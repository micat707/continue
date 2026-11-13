// src/components/ThinkingBlockPeek.tsx
import { ChevronDownIcon, ChevronRightIcon } from "@heroicons/react/24/outline";
import { ChevronUpIcon } from "@heroicons/react/24/solid";
import { ChatHistoryItem } from "core";
import { useEffect, useState } from "react";
import styled from "styled-components";

import { AnimatedEllipsis } from "../../AnimatedEllipsis";
import StyledMarkdownPreview from "../../StyledMarkdownPreview";

const MarkdownWrapper = styled.div`
  & > div > *:first-child {
    margin-top: 0 !important;
  }
`;

interface ThinkingBlockPeekProps {
  content: string;
  redactedThinking?: string;
  index: number;
  prevItem: ChatHistoryItem | null;
  inProgress?: boolean;
  signature?: string;
  tokens?: number;
}

function ThinkingBlockPeek({
  content,
  redactedThinking,
  index,
  prevItem,
  inProgress,
  tokens,
}: ThinkingBlockPeekProps) {
  const [open, setOpen] = useState(false);
  const [startTime, setStartTime] = useState<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState<string>("");

  const duplicateRedactedThinkingBlock =
    prevItem &&
    prevItem.message.role === "thinking" &&
    redactedThinking &&
    prevItem.message.redactedThinking;

  // While the model is still thinking we force the block open (arrow down,
  // content streaming live) so the user can watch it reason; once it finishes
  // we collapse it (arrow right) and let the user re-open at will.
  const expanded = inProgress || open;

  useEffect(() => {
    if (inProgress) {
      setStartTime(Date.now());
      setElapsedTime("");
    } else {
      if (startTime) {
        const endTime = Date.now();
        const diff = endTime - startTime;
        const diffString = `${(diff / 1000).toFixed(1)}s`;
        setElapsedTime(diffString);
      }
      setOpen(false);
    }
  }, [inProgress]);

  return duplicateRedactedThinkingBlock ? null : (
    <div className="thread-message">
      {/* Horizontal rhythm: .thread-message already supplies the 10px chat
          gutter, so the label column adds only 4px (px-1) to land on the
          same 14px left edge as reply text (.thread-message 10px +
          StepContainer p-1 4px). No capsule border/padding — that would
          re-indent the words and break alignment with the reply text. */}
      <div className="mt-1 flex flex-col px-1">
        <div>
          <button
            type="button"
            data-testid="thinking-block-peek"
            aria-expanded={expanded}
            aria-controls={`thinking-block-content-${index}`}
            onClick={() => setOpen(!open)}
            className="text-description m-0 mb-2 flex min-w-0 cursor-pointer flex-row items-center gap-1.5 border-0 bg-transparent p-0 text-xs transition-colors duration-200 ease-in-out hover:brightness-125"
          >
            {inProgress ? (
              <span className="flex flex-row items-center gap-1.5">
                {redactedThinking ? "深度思考（已脱敏）" : "深度思考"}
                <AnimatedEllipsis />
              </span>
            ) : redactedThinking ? (
              "深度思考（已脱敏）"
            ) : (
              "深度思考" +
              (elapsedTime ? `（${elapsedTime}）` : "") +
              (tokens ? `（${tokens} tokens）` : "")
            )}
            {expanded ? (
              <ChevronDownIcon className="h-3 w-3" />
            ) : (
              <ChevronRightIcon className="h-3 w-3" />
            )}
          </button>
        </div>
        <div
          id={`thinking-block-content-${index}`}
          className={`overflow-y-auto transition-all duration-300 ease-in-out ${
            expanded ? "max-h-[50vh] opacity-100" : "max-h-0 opacity-0"
          }`}
        >
          {redactedThinking ? (
            <div className="text-description pl-5 text-xs italic">
              Thinking content redacted due to safety reasons.
            </div>
          ) : (
            <MarkdownWrapper>
              <StyledMarkdownPreview
                isRenderingInStepContainer
                source={content}
                itemIndex={index}
              />
            </MarkdownWrapper>
          )}
        </div>
      </div>
    </div>
  );
}

export default ThinkingBlockPeek;
