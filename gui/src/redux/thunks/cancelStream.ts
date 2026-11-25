import { selectActiveSession } from "../slices/sessionSlice";
import { createAsyncThunk } from "@reduxjs/toolkit";
import {
  abortStream,
  clearDanglingMessages,
  inSession,
  setInactive,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { abortLiveStream } from "./streamNormalInput";

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
  // Abort the exact controller the running stream captured (Redux's slot can
  // be a different object), then also signal the Redux slot for UI state.
  const live = abortLiveStream(targetSessionId);
  console.log(`[cancelStream] session=${targetSessionId} liveAbort=${live}`);
  dispatch(abortStream(targetSessionId));

  // Clear any dangling incomplete tool calls, thinking messages, etc.
  dispatch(inSession(clearDanglingMessages(), targetSessionId));
});
