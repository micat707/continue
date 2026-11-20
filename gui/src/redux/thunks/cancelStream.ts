import { selectActiveSession } from "../slices/sessionSlice";
import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  abortStream,
  clearDanglingMessages,
  inSession,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";

/**
 * Stop a stream. When `sessionId` is omitted, the currently displayed
 * session is stopped. The id is threaded into `abortStream` so only that
 * session's AbortController is signalled — a background turn in another chat
 * keeps running.
 */
export const cancelStream = createAsyncThunk<
  void,
  string | undefined,
  ThunkApiType
>("chat/cancelStream", async (sessionId, { dispatch, getState }) => {
  const targetSessionId = sessionId ?? selectActiveSession(getState()).id;
  dispatch(inSession(setInactive(), targetSessionId));
  dispatch(abortStream(targetSessionId));

  // Clear any dangling incomplete tool calls, thinking messages, etc.
  dispatch(inSession(clearDanglingMessages(), targetSessionId));
});
