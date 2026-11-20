import { selectActiveSession } from "../../redux/slices/sessionSlice";
import {
  ArrowLeftIcon,
  ChatBubbleOvalLeftIcon,
} from "@heroicons/react/24/outline";
import { Editor, JSONContent } from "@tiptap/react";
import { ChatHistoryItem, InputModifiers } from "core";
import { renderChatMessage } from "core/util/messageContent";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ErrorBoundary } from "react-error-boundary";
import styled from "styled-components";
import { Button, lightGray, vscBackground } from "../../components";
import { useFindWidget } from "../../components/find/FindWidget";
import TimelineItem from "../../components/gui/TimelineItem";
import { NewSessionButton } from "../../components/mainInput/belowMainInput/NewSessionButton";
import ThinkingBlockPeek from "../../components/mainInput/belowMainInput/ThinkingBlockPeek";
import ContinueInputBox from "../../components/mainInput/ContinueInputBox";
import { TurnNavigator, type TurnItem } from "./TurnNavigator";
import { useOnboardingCard } from "../../components/OnboardingCard";
import StepContainer from "../../components/StepContainer";
import { MessageFooter } from "./MessageFooter";
import { TabBar } from "../../components/TabBar/TabBar";
import { IdeMessengerContext } from "../../context/IdeMessenger";
import { useWebviewListener } from "../../hooks/useWebviewListener";
import {
  appendExecuteProgress,
  finishExecuteProgress,
} from "../../components/StyledMarkdownPreview/executeProgressStore";
import { useAppDispatch, useAppSelector } from "../../redux/hooks";
import {
  selectApplyStatesForCurrentSession,
  selectConfirmationRequiredApplyStates,
  selectDoneApplyStates,
  selectPendingToolCalls,
  selectToolCallsByStatus,
} from "../../redux/selectors/selectToolCalls";
import {
  cancelToolCall,
  ChatHistoryItemWithMessageId,
  newSession,
  updateToolCallOutput,
} from "../../redux/slices/sessionSlice";
import { handleApplyStateUpdate } from "../../redux/thunks/handleApplyStateUpdate";
import { streamEditThunk } from "../../redux/thunks/edit";
import { loadLastSession } from "../../redux/thunks/session";
import { streamResponseThunk } from "../../redux/thunks/streamResponse";
import { isJetBrains, isMetaEquivalentKeyPressed } from "../../util";
import { ToolCallDiv } from "./ToolCallDiv";
import { SessionChangesSummary } from "./SessionChangesSummary";

import { useStore } from "react-redux";
import FeedbackDialog from "../../components/dialogs/FeedbackDialog";

import { DeprecationBanner } from "../../components/DeprecationBanner";
import { FatalErrorIndicator } from "../../components/config/FatalErrorNotice";
import InlineErrorMessage from "../../components/mainInput/InlineErrorMessage";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { setDialogMessage, setShowDialog } from "../../redux/slices/uiSlice";
import { selectSelectedChatModel } from "../../redux/slices/configSlice";
import { MessageHeader } from "./MessageHeader.js";
import { RootState } from "../../redux/store";
import { cancelStream } from "../../redux/thunks/cancelStream";
import { getLocalStorage, setLocalStorage } from "../../util/localStorage";
import { ExploreDialogWatcher } from "./ExploreDialogWatcher";
import { WelcomeView } from "./WelcomeView";
import { useAutoScroll } from "./useAutoScroll";
import { useImageZoom } from "./useImageZoom";

// Flatten a chat message's content (string or multimodal parts) to plain text
// for use as a turn navigator preview.
function getMessageText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p: any) => (typeof p === "string" ? p : (p?.text ?? "")))
      .join(" ")
      .trim();
  }
  return "";
}

// Helper function to find the index of the latest conversation summary
function findLatestSummaryIndex(history: ChatHistoryItem[]): number {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].conversationSummary) {
      return i;
    }
  }
  return -1; // No summary found
}

const StepsDiv = styled.div`
  position: relative;
  background-color: transparent;

  & > * {
    position: relative;
  }

  .thread-message {
    margin: 0;
  }
`;

export const MAIN_EDITOR_INPUT_ID = "main-editor-input";

/** Recursively extract plain text from a TipTap editor state (JSONContent). */
function editorStateToPlainText(state: JSONContent | undefined): string {
  if (!state) {
    return "";
  }
  let text =
    state.type === "text" && typeof state.text === "string" ? state.text : "";
  if (Array.isArray(state.content)) {
    for (const child of state.content) {
      text += editorStateToPlainText(child);
      if (child.type === "paragraph" || child.type === "heading") {
        text += "\n";
      }
    }
  }
  return text.trim();
}

function fallbackRender({ error, resetErrorBoundary }: any) {
  // Call resetErrorBoundary() to reset the error boundary and retry the render.

  return (
    <div
      role="alert"
      className="px-2"
      style={{ backgroundColor: vscBackground }}
    >
      <p>Something went wrong:</p>
      <pre style={{ color: "red" }}>{error.message}</pre>
      <pre style={{ color: lightGray }}>{error.stack}</pre>

      <div className="text-center">
        <Button onClick={resetErrorBoundary}>Restart</Button>
      </div>
    </div>
  );
}

export function Chat() {
  const dispatch = useAppDispatch();
  const ideMessenger = useContext(IdeMessengerContext);
  const reduxStore = useStore<RootState>();
  const onboardingCard = useOnboardingCard();
  const showSessionTabs = useAppSelector(
    (store) => store.config.config.ui?.showSessionTabs ?? true,
  );
  const isStreaming = useAppSelector(
    (state) => selectActiveSession(state).isStreaming,
  );
  const [stepsOpen] = useState<(boolean | undefined)[]>([]);
  const mainTextInputRef = useRef<HTMLInputElement>(null);
  const stepsDivRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  // Layout: the message list (flex-1, min-h-0) and the composer are SIBLINGS in
  // a flex column, so a composer height change (toolbar card in/out, the
  // reserved slot expanding/collapsing) only changes how much of the list is
  // VISIBLE — scrollTop is left untouched, so existing messages never move.
  //
  // This replaced the previous absolute-overlay + paddingBottom-compensation
  // scheme: shrinking/growing the padding there changed the scrollable height,
  // and with the conversation pinned to the bottom the browser clamped
  // scrollTop, visibly dropping/raising the whole conversation at every phase
  // change (the "画面突然掉落" at the end of a turn).
  //
  // RULE for this layout: never re-pin the list to the bottom when the
  // composer resizes — that would reintroduce the same movement.
  const history = useAppSelector((state) => selectActiveSession(state).history);
  const showChatScrollbar = useAppSelector(
    (state) => state.config.config.ui?.showChatScrollbar,
  );
  // Busy states that keep the Kiro-style stream bar mounted through the WHOLE
  // file-modify flow (LLM streaming -> tool executing -> apply streaming):
  // the bar occupies one fixed slot and only swaps its text, so the composer
  // never jumps between phases — the review card replacing it at the end is
  // the single visible layout change.
  const isApplyingState = useAppSelector((state) =>
    selectApplyStatesForCurrentSession(state).some(
      (applyState) => applyState.status === "streaming",
    ),
  );
  const hasRunningToolCall = useAppSelector(
    (state) => selectToolCallsByStatus(state, "calling").length > 0,
  );

  // Apply-state safety net. The chat turn's busy state (session.isStreaming and
  // pending tool calls) is now guaranteed to reset by the try/finally in
  // streamThunkWrapper — that is the single source of truth for turn cleanup.
  //
  // This watchdog exists ONLY for the cross-process apply flow: if the IDE-side
  // apply stream dies before it sends a terminal "failed"/"closed" event, the GUI
  // apply state stays "streaming" forever (streamThunkWrapper cannot see it, it's
  // owned by the IDE). Mark it failed so the UI recovers.
  //
  // Keyed on the BOOLEAN isApplyingState (not a freshly-filtered array) so the
  // timer isn't torn down and recreated on every store update.
  useEffect(() => {
    if (!isApplyingState) {
      return;
    }
    const APPLY_STUCK_TIMEOUT_MS = 180_000;
    const timer = setTimeout(() => {
      const s = reduxStore.getState();
      for (const applyState of selectApplyStatesForCurrentSession(s).filter(
        (a) => a.status === "streaming",
      )) {
        void dispatch(
          handleApplyStateUpdate({
            status: "failed",
            streamId: applyState.streamId,
            toolCallId: applyState.toolCallId,
            filepath: applyState.filepath,
          }),
        );
      }
    }, APPLY_STUCK_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isApplyingState, reduxStore, dispatch]);
  // A user-authorization confirmation dialog is up — a tool call awaiting
  // approval (PendingToolCallToolbar) or a finished apply awaiting Accept
  // (PendingApplyStatesToolbar / ReviewChangesCard). While the user must act,
  // nothing is "answering" anymore, so the answering/apply stream bar is hidden.
  // Auto-accepted (allowedWithoutPermission) applies are excluded: they never
  // render a card, so they must not hide the stream bar either — otherwise the
  // brief done→closed window collapsed the composer (the conversation jitter).
  const pendingToolCalls = useAppSelector(selectPendingToolCalls);
  const pendingConfirmationApplyStates = useAppSelector(
    selectConfirmationRequiredApplyStates,
  );
  const hasPendingConfirmation =
    pendingToolCalls.length > 0 || pendingConfirmationApplyStates.length > 0;
  // Busy = the turn is still in flight (streaming / tool running / apply
  // streaming / awaiting a confirmation). Gates both the per-turn footer and the
  // session-changes summary so neither appears until the agent settles.
  const isSessionBusy =
    isStreaming ||
    isApplyingState ||
    hasRunningToolCall ||
    hasPendingConfirmation;
  const codeToEdit = useAppSelector((state) => state.editModeState.codeToEdit);
  const isInEdit = useAppSelector(
    (store) => selectActiveSession(store).isInEdit,
  );
  const selectedModel = useAppSelector(selectSelectedChatModel);
  const contextPercentage = useAppSelector(
    (state) => selectActiveSession(state).contextPercentage,
  );

  const lastSessionId = useAppSelector(
    (state) => selectActiveSession(state).lastSessionId,
  );
  const hasDismissedExploreDialog = useAppSelector(
    (state) => state.ui.hasDismissedExploreDialog,
  );
  const jetbrains = useMemo(() => {
    return isJetBrains();
  }, []);

  useAutoScroll(stepsDivRef, history);

  // User-message images render as thumbnails; click to view the full image.
  useImageZoom(stepsDivRef, ".kiro-user-bubble");

  useEffect(() => {
    // Cmd + Backspace to delete current step
    const listener = (e: KeyboardEvent) => {
      if (
        e.key === "Backspace" &&
        (jetbrains ? e.altKey : isMetaEquivalentKeyPressed(e)) &&
        !e.shiftKey
      ) {
        void dispatch(cancelStream());
      }
    };
    window.addEventListener("keydown", listener);

    return () => {
      window.removeEventListener("keydown", listener);
    };
  }, [isStreaming, jetbrains, isInEdit]);

  const { widget, highlights } = useFindWidget(
    stepsDivRef,
    tabsRef,
    isStreaming,
  );

  const sendInput = useCallback(
    (
      editorState: JSONContent,
      modifiers: InputModifiers,
      index?: number,
      editorToClearOnSend?: Editor,
    ) => {
      const stateSnapshot = reduxStore.getState();
      const latestPendingToolCalls = selectPendingToolCalls(stateSnapshot);
      const latestPendingApplyStates = selectDoneApplyStates(stateSnapshot);
      const isCurrentlyInEdit = selectActiveSession(stateSnapshot).isInEdit;
      const codeToEditSnapshot = stateSnapshot.editModeState.codeToEdit;
      const selectedModelByRole =
        stateSnapshot.config.config.selectedModelByRole;
      const currentMode = selectActiveSession(stateSnapshot).mode;

      // Cancel all pending tool calls
      latestPendingToolCalls.forEach((toolCallState) => {
        dispatch(
          cancelToolCall({
            toolCallId: toolCallState.toolCallId,
          }),
        );
      });

      // Reject all pending apply states
      latestPendingApplyStates.forEach((applyState) => {
        if (applyState.status !== "closed") {
          ideMessenger.post("rejectDiff", applyState);
        }
      });
      const model = isCurrentlyInEdit
        ? (selectedModelByRole.edit ?? selectedModelByRole.chat)
        : selectedModelByRole.chat;

      if (!model) {
        return;
      }

      if (isCurrentlyInEdit && codeToEditSnapshot.length === 0) {
        return;
      }

      if (isCurrentlyInEdit) {
        void dispatch(
          streamEditThunk({
            editorState,
            codeToEdit: codeToEditSnapshot,
          }),
        );
      } else {
        void dispatch(streamResponseThunk({ editorState, modifiers, index }));

        if (editorToClearOnSend) {
          editorToClearOnSend.commands.clearContent();
        }
      }

      // Increment localstorage counter for popup
      const currentCount = getLocalStorage("mainTextEntryCounter");
      if (currentCount) {
        setLocalStorage("mainTextEntryCounter", currentCount + 1);
        if (currentCount === 300) {
          dispatch(setDialogMessage(<FeedbackDialog />));
          dispatch(setShowDialog(true));
        }
      } else {
        setLocalStorage("mainTextEntryCounter", 1);
      }
    },
    [dispatch, ideMessenger, reduxStore],
  );

  useWebviewListener(
    "newSession",
    async () => {
      // unwrapResult(response) // errors if session creation failed
      mainTextInputRef.current?.focus?.();
    },
    [mainTextInputRef],
  );

  // Handle partial tool call output for streaming updates
  useWebviewListener(
    "toolCallPartialOutput",
    async (data) => {
      // Update tool call output in Redux store
      dispatch(
        updateToolCallOutput({
          toolCallId: data.toolCallId,
          contextItems: data.contextItems,
        }),
      );
    },
    [dispatch],
  );

  // DeepAgent: append incremental output chunks (or the completion signal) to
  // the per-run store keyed by runId, so each running "Run Command" card updates
  // in place (no chat re-render).
  useWebviewListener(
    "deepagentExecuteProgress",
    async (data) => {
      if (data.done) {
        finishExecuteProgress(data.runId, data.exitCode ?? null);
      } else if (typeof data.chunk === "string" && data.chunk.length > 0) {
        appendExecuteProgress(data.runId, data.chunk);
      }
    },
    [appendExecuteProgress, finishExecuteProgress],
  );

  const isLastUserInput = useCallback(
    (index: number): boolean => {
      return !history
        .slice(index + 1)
        .some((entry) => entry.message.role === "user");
    },
    [history],
  );

  const renderChatHistoryItem = useCallback(
    (item: ChatHistoryItemWithMessageId, index: number) => {
      const {
        message,
        editorState,
        contextItems,
        appliedRules,
        toolCallStates,
      } = item;

      // Show the agent header only on the first assistant item of a turn, so a
      // single answer (reasoning + tool calls + reply) renders exactly one
      // header. Scan back over tool/thinking items; a preceding assistant item
      // means we are still inside the same turn.
      let showHeader = true;
      for (let i = index - 1; i >= 0; i--) {
        const role = history[i]?.message.role;
        if (role === "assistant") {
          showHeader = false;
          break;
        }
        if (role === "user") {
          break;
        }
      }

      // End-of-turn detection: this is the last assistant item of the turn if
      // no later assistant item appears before the next user message.
      let isTurnEnd = true;
      for (let i = index + 1; i < history.length; i++) {
        const role = history[i]?.message.role;
        if (role === "user") {
          break;
        }
        if (role === "assistant" || role === "tool") {
          isTurnEnd = false;
          break;
        }
      }

      // The turn is still in flight while streaming, a tool call is executing,
      // an apply is streaming into the editor, or a confirmation dialog awaits
      // the user. Suppress the credits/elapsed footer for the latest turn until
      // it has fully settled (older, completed turns keep their footer).
      const showFooter =
        isTurnEnd && !(isSessionBusy && isLastUserInput(index));
      const promptLogs = item.promptLogs ?? [];
      const modelName =
        promptLogs[promptLogs.length - 1]?.modelTitle ?? selectedModel?.title;
      const estimatedTokens = promptLogs.reduce(
        (sum, log) =>
          sum +
          Math.ceil((log.prompt?.length ?? 0) / 4) +
          Math.ceil((log.completion?.length ?? 0) / 4),
        0,
      );
      const credits =
        estimatedTokens > 0
          ? Math.max(0.01, estimatedTokens * 0.00002)
          : undefined;
      const elapsedMs = item.turnElapsedMs;

      // Calculate once for the entire function
      const latestSummaryIndex = findLatestSummaryIndex(history);
      const isBeforeLatestSummary =
        latestSummaryIndex !== -1 && index < latestSummaryIndex;

      if (message.role === "user") {
        return (
          <div className="kiro-user-row">
            <div
              className={`kiro-user-bubble${
                isStreaming && isLastUserInput(index)
                  ? "kiro-user-bubble--streaming"
                  : ""
              }`}
            >
              <ContinueInputBox
                onEnter={(newEditorState, modifiers) => {
                  // The bubble IS the user's own message rendered as an
                  // editable input. Its Send appends the text as a NEW message
                  // (index === undefined → appended at history.length, exactly
                  // like the main composer), so nothing is ever deleted: the
                  // existing reply stays and the new answer is streamed below.
                  //
                  // The bubble's editor is deliberately NOT passed as
                  // editorToClearOnSend — sendInput would clearContent() and
                  // blank out the user's own rendered message.
                  if (!editorStateToPlainText(newEditorState)) {
                    return;
                  }
                  sendInput(newEditorState, modifiers, undefined);
                }}
                isLastUserInput={isLastUserInput(index)}
                isMainInput={false}
                editorState={editorState ?? item.message.content}
                contextItems={contextItems}
                appliedRules={appliedRules}
                inputId={message.id}
              />
            </div>
          </div>
        );
      }

      if (message.role === "tool") {
        return null;
      }

      if (message.role === "assistant") {
        return (
          <>
            {/* Always render assistant content through normal path */}
            <div className="thread-message">
              {showHeader && <MessageHeader />}
              <TimelineItem
                item={item}
                iconElement={
                  <ChatBubbleOvalLeftIcon width="16px" height="16px" />
                }
                open={
                  typeof stepsOpen[index] === "undefined"
                    ? true
                    : stepsOpen[index]!
                }
                onToggle={() => {}}
              >
                <StepContainer
                  index={index}
                  isLast={index === history.length - 1}
                  item={item}
                  latestSummaryIndex={latestSummaryIndex}
                />
              </TimelineItem>
              {showFooter && (
                <MessageFooter
                  credits={credits}
                  elapsedMs={elapsedMs}
                  modelName={modelName}
                />
              )}
            </div>

            {toolCallStates && (
              <ToolCallDiv
                toolCallStates={toolCallStates}
                historyIndex={index}
              />
            )}
          </>
        );
      }

      if (message.role === "thinking") {
        const thinkingContent = renderChatMessage(message);
        if (!thinkingContent?.trim()) {
          return null;
        }
        return (
          <div className={isBeforeLatestSummary ? "opacity-50" : ""}>
            <ThinkingBlockPeek
              content={thinkingContent}
              redactedThinking={message.redactedThinking}
              index={index}
              prevItem={index > 0 ? history[index - 1] : null}
              inProgress={index === history.length - 1 && isStreaming}
              signature={message.signature}
            />
          </div>
        );
      }

      // Default case - regular assistant message
      return (
        <div className="thread-message">
          {showHeader && <MessageHeader />}
          <TimelineItem
            item={item}
            iconElement={<ChatBubbleOvalLeftIcon width="16px" height="16px" />}
            open={
              typeof stepsOpen[index] === "undefined" ? true : stepsOpen[index]!
            }
            onToggle={() => {}}
          >
            <StepContainer
              index={index}
              isLast={index === history.length - 1}
              item={item}
              latestSummaryIndex={latestSummaryIndex}
            />
          </TimelineItem>
          {showFooter && (
            <MessageFooter
              credits={credits}
              elapsedMs={elapsedMs}
              modelName={modelName}
            />
          )}
        </div>
      );
    },
    [
      sendInput,
      isLastUserInput,
      history,
      stepsOpen,
      isStreaming,
      isApplyingState,
      hasRunningToolCall,
      hasPendingConfirmation,
      isSessionBusy,
      selectedModel,
      contextPercentage,
    ],
  );

  const showScrollbar = showChatScrollbar ?? window.innerHeight > 5000;

  // Derive turn list (user question -> first following assistant answer) for
  // the slide-out navigator. Pure function of history; safe to recompute.
  const turns = useMemo<TurnItem[]>(() => {
    const list: TurnItem[] = [];
    for (const item of history) {
      const role = item.message.role;
      if (role === "user") {
        list.push({
          id: item.message.id,
          q: getMessageText(item.message.content).trim(),
          answerId: "",
          answer: "",
        });
      } else if (
        (role === "assistant" || role === "tool" || role === "thinking") &&
        list.length > 0
      ) {
        const last = list[list.length - 1];
        if (!last.answerId) last.answerId = item.message.id;
        // Accumulate the full answer text (assistant + tool output) so the
        // navigator's keyword search can match reply content too.
        const txt = getMessageText(item.message.content).trim();
        if (txt) last.answer = last.answer ? `${last.answer} ${txt}` : txt;
      }
    }
    return list;
  }, [history]);

  return (
    <>
      {!!showSessionTabs && !isInEdit && <TabBar ref={tabsRef} />}
      {widget}

      <StepsDiv
        ref={stepsDivRef}
        className={`kiro-chat-scroll pb-[8px] pt-[8px] ${showScrollbar ? "thin-scrollbar" : "no-scrollbar"} min-h-0 min-w-0 flex-1 overflow-y-scroll`}
      >
        <DeprecationBanner dismissable={true} />
        {highlights}
        {history
          .filter((item) => item.message.role !== "system")
          .map((item, index: number) => (
            <div
              key={item.message.id}
              id={`msg-${item.message.id}`}
              style={{
                minHeight: index === history.length - 1 ? "200px" : 0,
              }}
            >
              <ErrorBoundary FallbackComponent={fallbackRender}>
                {renderChatHistoryItem(item, index)}
              </ErrorBoundary>
              {index === history.length - 1 && <InlineErrorMessage />}
            </div>
          ))}
        {!isSessionBusy && (
          <SessionChangesSummary
            visible={!isSessionBusy}
            sessionKey={lastSessionId ?? ""}
          />
        )}
        {history.length === 0 && (
          <WelcomeView showOnboardingCard={onboardingCard.show} />
        )}
      </StepsDiv>
      <div className={"kiro-chat-input relative z-10 w-full min-w-0 shrink-0"}>
        <ContinueInputBox
          isMainInput
          isLastUserInput={false}
          onEnter={(editorState, modifiers, editor) =>
            sendInput(editorState, modifiers, undefined, editor)
          }
          inputId={MAIN_EDITOR_INPUT_ID}
          aboveInput={
            (isStreaming || isApplyingState || hasRunningToolCall) &&
            !hasPendingConfirmation ? (
              /* The streaming bar lives INSIDE the main input's reserved
                 LumpSlot (see ContinueInputBox aboveInput), sharing one
                 high-water slot with the review-changes card: the slot grows
                 once when the tallest phase first appears and every later
                 bar/card swap happens inside the reserved space, so the
                 conversation is never shoved up/down mid-turn. NO extra
                 horizontal wrapper here: LumpSlot sits inside the same
                 `px-2` container as the GradientBorder input frame, so the
                 bar's edges line up pixel-perfect with the input frame — an
                 inner `px-2` would double-inset the bar by 8px. */
              <div className="kiro-stream-bar">
                <div className="kiro-stream-bar__status">
                  <span className="kiro-stream-bar__pulse" aria-hidden />
                  <span
                    className="kiro-stream-bar__text"
                    data-is-thinking="true"
                  >
                    {isApplyingState ? "正在应用更改" : "正在回答中"}
                    <span className="kiro-stream-bar__dots" aria-hidden>
                      <i>.</i>
                      <i>.</i>
                      <i>.</i>
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  className="kiro-stream-bar__stop"
                  onClick={() => {
                    void dispatch(cancelStream());
                    if (isApplyingState) {
                      // Abort EVERY in-flight apply of this session: cancel
                      // the owning tool calls (so the later "closed" events
                      // don't resume the LLM), then reject each diff with
                      // its real streamId — the empty-payload rejectDiff
                      // used before fell back to the wrong file and never
                      // closed the apply state, leaving the status bar
                      // stuck on 正在应用更改.
                      const streamingStates =
                        selectApplyStatesForCurrentSession(
                          reduxStore.getState(),
                        ).filter((s) => s.status === "streaming");
                      streamingStates.forEach((applyState) => {
                        if (applyState.toolCallId) {
                          dispatch(
                            cancelToolCall({
                              toolCallId: applyState.toolCallId,
                            }),
                          );
                        }
                        ideMessenger.post("rejectDiff", {
                          filepath: applyState.filepath ?? "",
                          streamId: applyState.streamId,
                          toolCallId: applyState.toolCallId,
                        });
                      });
                    }
                  }}
                >
                  停止
                </button>
              </div>
            ) : undefined
          }
        />

        <div
          style={{
            pointerEvents: isStreaming ? "none" : "auto",
          }}
        >
          <div className="flex flex-row items-center justify-between pb-1 pl-0.5 pr-2">
            <div className="xs:inline hidden">
              {history.length === 0 && lastSessionId && !isInEdit && (
                <NewSessionButton
                  onClick={async () => {
                    await dispatch(loadLastSession());
                  }}
                  className="flex items-center gap-2"
                >
                  <ArrowLeftIcon className="h-3 w-3" />
                  <span className="text-xs">Last Session</span>
                </NewSessionButton>
              )}
            </div>
          </div>
          <FatalErrorIndicator />
          {!hasDismissedExploreDialog && <ExploreDialogWatcher />}
        </div>
      </div>

      {turns.length > 1 && <TurnNavigator turns={turns} />}
    </>
  );
}
