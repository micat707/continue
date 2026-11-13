import { createAsyncThunk } from "@reduxjs/toolkit";
import { ApplyState, ApplyToFilePayload } from "core";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { logAgentModeEditOutcome } from "../../util/editOutcomeLogger";
import {
  selectApplyStateByToolCallId,
  selectToolCallById,
} from "../selectors/selectToolCalls";
import { updateEditStateApplyState } from "../slices/editState";
import {
  acceptToolCall,
  errorToolCall,
  updateApplyState,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { exitEdit } from "./edit";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const handleApplyStateUpdate = createAsyncThunk<
  void,
  ApplyState,
  ThunkApiType
>(
  "apply/handleStateUpdate",
  async (applyState, { dispatch, getState, extra }) => {
    console.log(
      `[continue][apply] updateApplyState status=${applyState.status} streamId=${applyState.streamId} toolCallId=${applyState.toolCallId ?? "n/a"} filepath=${applyState.filepath ?? "n/a"}`,
    );
    if (applyState.streamId === EDIT_MODE_STREAM_ID) {
      dispatch(updateEditStateApplyState(applyState));

      if (applyState.status === "closed") {
        const toolCallState = findToolCallById(
          getState().session.history,
          applyState.toolCallId!,
        );
        if (toolCallState) {
          logToolUsage(toolCallState, true, true, extra.ideMessenger);
        }
        void dispatch(exitEdit({}));
      }
    } else {
      // chat or agent
      // Some IDE paths send status updates WITHOUT toolCallId (e.g. the
      // acceptDiff command -> processDiff -> "closed" event). The stored apply
      // state knows its owning tool call, so recover it — otherwise the
      // "closed" bookkeeping below never runs and the edit gets stuck forever
      // with a spinning card and no LLM continuation.
      let effectiveState = applyState;
      if (!effectiveState.toolCallId) {
        const stored =
          getState?.()?.session?.codeBlockApplyStates?.states?.find(
            (s) => s.streamId === effectiveState.streamId,
          );
        if (stored?.toolCallId) {
          effectiveState = { ...effectiveState, toolCallId: stored.toolCallId };
        }
      }
      dispatch(updateApplyState(effectiveState));

      // Handle apply status updates - use toolCallId from event payload
      if (effectiveState.toolCallId) {
        const toolCallState = findToolCallById(
          getState().session.history,
          effectiveState.toolCallId,
        );

        if (
          applyState.status === "done" &&
          toolCallState?.toolCall.function.name &&
          getState().ui.toolSettings[toolCallState.toolCall.function.name] ===
            "allowedWithoutPermission"
        ) {
          extra.ideMessenger.post("acceptDiff", {
            streamId: applyState.streamId,
            filepath: applyState.filepath,
            toolCallId: effectiveState.toolCallId,
          });
        }

        if (applyState.status === "closed") {
          if (toolCallState) {
            const accepted = toolCallState.status !== "canceled";

            logToolUsage(toolCallState, accepted, true, extra.ideMessenger);

            // Log edit outcome for Agent Mode
            const newApplyState =
              getState().session.codeBlockApplyStates.states.find(
                (s) => s.streamId === applyState.streamId,
              );
            const newState = getState();
            if (newApplyState) {
              void logAgentModeEditOutcome(
                newState.session.history,
                newState.config.config,
                toolCallState,
                newApplyState,
                accepted,
                extra.ideMessenger,
              );
            }

            if (accepted) {
              if (toolCallState.status !== "errored") {
                dispatch(
                  acceptToolCall({
                    toolCallId: effectiveState.toolCallId,
                  }),
                );

                // Add autoformatting diff to tool output if present
                if (applyState.autoFormattingDiff) {
                  dispatch(
                    updateToolCallOutput({
                      toolCallId: effectiveState.toolCallId,
                      contextItems: [
                        {
                          icon: "info",
                          name: "Auto-formatting Applied",
                          description: "Editor auto-formatting changes",
                          content: `Along with your edits, the editor applied the following auto-formatting:\n\n${applyState.autoFormattingDiff}\n\n(Note: Pay close attention to changes such as single quotes being converted to double quotes, semicolons being removed or added, long lines being broken into multiple lines, adjusting indentation style, adding/removing trailing commas, etc. This will help you ensure future SEARCH/REPLACE operations to this file are accurate.)`,
                          hidden: false,
                        },
                      ],
                    }),
                  );
                } else {
                  dispatch(
                    updateToolCallOutput({
                      toolCallId: effectiveState.toolCallId,
                      contextItems: [
                        {
                          name: "Edit Success",
                          content: `Successfully edited ${applyState.filepath}`,
                          description: "",
                          hidden: true,
                        },
                      ],
                    }),
                  );
                }
              } else {
                dispatch(
                  updateToolCallOutput({
                    toolCallId: effectiveState.toolCallId,
                    contextItems: [
                      {
                        name: "Edit Failed",
                        content: `Failed to edit ${applyState.filepath}. To continue working with the file, read it again to see the most up-to-date contents`,
                        description: "",
                        hidden: true,
                      },
                    ],
                  }),
                );
              }

              void dispatch(
                streamResponseAfterToolCall({
                  toolCallId: effectiveState.toolCallId,
                }),
              );
            }
          }
        }

        if (applyState.status === "failed") {
          // Terminal apply failure (IDE couldn't apply/stream the diff).
          // Surface it as a VISIBLE tool output so the user sees why the edit
          // failed (e.g. an HTTP 404 / model-not-found from the apply model),
          // finish the tool call and let the LLM continue so it can retry —
          // instead of hanging forever on "Applying" with a spinning card, or
          // dying silently.
          if (toolCallState && toolCallState.status !== "canceled") {
            const failReason = applyState.error
              ? `\n\nUnderlying error: ${applyState.error}`
              : "";
            dispatch(
              updateToolCallOutput({
                toolCallId: effectiveState.toolCallId,
                contextItems: [
                  {
                    name: "Edit Failed",
                    content: `Failed to apply changes to ${applyState.filepath ?? "the file"}.${failReason}\n\nRead the file again to see its current content, then retry the edit.`,
                    description: "",
                    hidden: false,
                  },
                ],
              }),
            );
            if (toolCallState.status !== "errored") {
              dispatch(
                acceptToolCall({
                  toolCallId: effectiveState.toolCallId,
                }),
              );
            }
            void dispatch(
              streamResponseAfterToolCall({
                toolCallId: effectiveState.toolCallId,
              }),
            );
          }
        }
      } else if (applyState.status === "failed") {
        // Apply failure with no owning tool call (e.g. the manual "Apply"
        // button on a code block sends applyToFile without one). Nothing else
        // surfaces it — without this toast the failure is silently dropped
        // and the session just stops with no visible error.
        const failReason = applyState.error
          ? `: ${applyState.error}`
          : ". See the Continue console for the underlying error.";
        void extra.ideMessenger.ide.showToast(
          "error",
          `Failed to apply changes to ${applyState.filepath ?? "the file"}${failReason}`,
        );
      }
    }
  },
);

export const applyForEditTool = createAsyncThunk<
  void,
  ApplyToFilePayload & { toolCallId: string },
  ThunkApiType
>("apply/editTool", async (payload, { dispatch, getState, extra }) => {
  const { toolCallId, streamId } = payload;
  dispatch(
    updateApplyState({
      streamId,
      toolCallId,
      status: "not-started",
    }),
  );

  let didError = false;
  try {
    // Guard against a hung IDE-side apply (e.g. the apply-model request never
    // resolves because the provider returned an empty/broken response — seen
    // as "Unexpected end of JSON input" in the Continue console). Without a
    // timeout the apply state stays "streaming" forever and the status bar
    // hangs on 正在应用更改 with a dead 停止 button.
    const APPLY_TIMEOUT_MS = 120_000;
    let timedOut = false;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
    }, APPLY_TIMEOUT_MS);
    try {
      const response = await extra.ideMessenger.request("applyToFile", payload);
      if (response.status === "error") {
        didError = true;
      }
    } finally {
      clearTimeout(timeoutTimer);
    }
    if (timedOut) {
      didError = true;
    }
  } catch (e) {
    didError = true;
  }
  if (didError) {
    const state = getState();

    const toolCallState = selectToolCallById(state, toolCallId);
    const applyState = selectApplyStateByToolCallId(state, toolCallId);
    if (
      toolCallState &&
      applyState &&
      applyState.status !== "closed" &&
      toolCallState.status === "calling"
    ) {
      // Route through the "failed" terminal state so the tool call is finished
      // with an error output and the LLM is resumed — it can read the file and
      // retry the edit, instead of the turn just dying silently.
      void dispatch(
        handleApplyStateUpdate({
          status: "failed",
          streamId: applyState.streamId,
          toolCallId,
          filepath: payload.filepath,
        }),
      );
    }
  }
});
