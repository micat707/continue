import {
  inSession,
  selectActiveSession,
  selectSessionById,
} from "../slices/sessionSlice";
import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { ContextItem, McpUiState } from "core";
import { CLIENT_TOOLS_IMPLS } from "core/tools/builtIn";
import { ContinueError, ContinueErrorReason } from "core/util/errors";

import { callClientTool } from "../../util/clientTools/callClientTool";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  acceptToolCall,
  errorToolCall,
  setPendingContinuation,
  setToolCallCalling,
  updateToolCallOutput,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { findToolCallById, logToolUsage } from "../util";
import { streamResponseAfterToolCall } from "./streamResponseAfterToolCall";

export const callToolById = createAsyncThunk<
  void,
  {
    toolCallId: string;
    isAutoApproved?: boolean;
    depth?: number;
    sessionId?: string;
  },
  ThunkApiType
>("chat/callTool", async (inputs, { dispatch, extra, getState }) => {
  const { toolCallId, isAutoApproved, depth = 0, sessionId } = inputs;

  const state = getState();
  // When a background session executes a tool, read its own history rather
  // than the active session's, so the tool call state resolves correctly.
  const owner = sessionId
    ? selectSessionById(state, sessionId)
    : selectActiveSession(state);
  const owningSessionId = sessionId ?? owner.id;
  const toolCallState = findToolCallById(owner.history, toolCallId);
  if (!toolCallState) {
    console.warn(`Tool call with ID ${toolCallId} not found`);
    return;
  }

  if (toolCallState.status !== "generated") {
    return;
  }

  const selectedChatModel = selectSelectedChatModel(state);

  if (!selectedChatModel) {
    throw new Error("No model selected");
  }

  dispatch(
    inSession(
      setToolCallCalling({
        toolCallId,
      }),
      owningSessionId,
    ),
  );

  const toolName = toolCallState.toolCall.function.name;
  console.log(
    `[tool-call] START tool=${toolName} toolCallId=${toolCallId} args=${JSON.stringify(
      toolCallState.parsedArgs ?? {},
    ).slice(0, 200)}`,
  );

  let output: ContextItem[] | undefined = undefined;
  let mcpUiState: McpUiState | undefined = undefined;
  let error: ContinueError | undefined = undefined;
  let streamResponse: boolean;

  // IMPORTANT:
  // Errors that occur while calling tool call implementations
  // Are caught and passed in output as context items
  // Errors that occur outside specifically calling the tool
  // Should not be caught here - should be handled as normal stream errors
  if (
    CLIENT_TOOLS_IMPLS.find(
      (toolName) => toolName === toolCallState.toolCall.function.name,
    )
  ) {
    // Tool is called on client side
    const {
      output: clientToolOutput,
      respondImmediately,
      error: clientToolError,
    } = await callClientTool(toolCallState, {
      dispatch,
      ideMessenger: extra.ideMessenger,
      getState,
    });
    output = clientToolOutput;
    error = clientToolError;
    streamResponse = respondImmediately;
  } else {
    // Tool is called on core side
    const result = await extra.ideMessenger.request("tools/call", {
      toolCall: toolCallState.toolCall,
    });
    if (result.status === "error") {
      throw new Error(result.error);
    } else {
      output = result.content.contextItems;
      mcpUiState = result.content.mcpUiState;
      error = result.content.errorMessage
        ? new ContinueError(
            result.content.errorReason || ContinueErrorReason.Unspecified,
            result.content.errorMessage,
          )
        : undefined;
    }
    streamResponse = true;
  }

  console.log(
    `[tool-call] END tool=${toolName} toolCallId=${toolCallId} result=${
      error
        ? `ERROR: ${error.message}`
        : `OK (${output?.length ?? 0} context items)`
    }`,
  );

  if (error) {
    dispatch(
      inSession(
        updateToolCallOutput({
          toolCallId,
          contextItems: [
            {
              icon: "problems",
              name: "Tool Call Error",
              description: "Tool Call Failed",
              content: `${toolCallState.toolCall.function.name} failed with the message: ${error.message}\n\nPlease try something else or request further instructions.`,
              hidden: false,
            },
          ],
        }),
        owningSessionId,
      ),
    );
  } else if (output?.length) {
    dispatch(
      inSession(
        updateToolCallOutput({
          toolCallId,
          contextItems: output,
          mcpUiState,
        }),
        owningSessionId,
      ),
    );
  }

  if (streamResponse) {
    if (error) {
      logToolUsage(toolCallState, false, false, extra.ideMessenger, output);
      dispatch(inSession(errorToolCall({ toolCallId }), owningSessionId));
    } else {
      logToolUsage(toolCallState, true, true, extra.ideMessenger, output);
      dispatch(inSession(acceptToolCall({ toolCallId }), owningSessionId));
    }

    // Send to the LLM to continue the conversation
    const wrapped = await dispatch(
      streamResponseAfterToolCall({
        toolCallId,
        depth: depth + 1,
        sessionId: owningSessionId,
      }),
    );
    unwrapResult(wrapped);
  } else {
    // `streamResponse === false` (respondImmediately: false) means an async
    // follow-up — the edit/apply stream — owns the turn's continuation. The
    // apply completion dispatches streamResponseAfterToolCall, which re-activates
    // the session and continues the conversation. Ending the turn here would
    // mark the session inactive mid-apply, and the streamThunkWrapper `finally`
    // would then dispatch setInactive and abort the pending continuation
    // ("aborted by session state"). Instead flag the pending continuation so the
    // safety-net cleanup skips this turn until the apply dispatches it.
    // (Every current respondImmediately:false client tool is an edit tool that
    // always dispatches an apply, so the turn is guaranteed to be continued —
    // or failed-and-continued — by the apply flow.)
    dispatch(inSession(setPendingContinuation(true), owningSessionId));
  }
});
