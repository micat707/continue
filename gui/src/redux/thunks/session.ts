import { selectActiveSession, selectSessionById } from "../slices/sessionSlice";
import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { BaseSessionMetadata, ChatMessage, Session } from "core";
import { NEW_SESSION_TITLE } from "core/util/constants";
import { renderChatMessage } from "core/util/messageContent";
import { IIdeMessenger } from "../../context/IdeMessenger";
import { selectSelectedChatModel } from "../slices/configSlice";
import { selectSelectedProfile } from "../slices/profilesSlice";
import {
  deleteSessionMetadata,
  newSession,
  setAllSessionMetadata,
  setIsSessionMetadataLoading,
  updateSessionMetadata,
} from "../slices/sessionSlice";
import { AppDispatch, ThunkApiType } from "../store";
import { updateSelectedModelByRole } from "../thunks/updateSelectedModelByRole";

const MAX_TITLE_LENGTH = 100;

// Async session functions live in thunks (because of IDE messaging mostly)
// see sessionSlice for sync redux session functions

export async function getSession(
  ideMessenger: IIdeMessenger,
  id: string,
): Promise<Session> {
  const result = await ideMessenger.request("history/load", { id });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return result.content;
}

export const refreshSessionMetadata = createAsyncThunk<
  BaseSessionMetadata[],
  {
    offset?: number;
    limit?: number;
  },
  ThunkApiType
>("session/refreshMetadata", async ({ offset, limit }, { dispatch, extra }) => {
  const result = await extra.ideMessenger.request("history/list", {
    limit,
    offset,
  });
  if (result.status === "error") {
    throw new Error(result.error);
  }
  dispatch(setIsSessionMetadataLoading(false));
  dispatch(setAllSessionMetadata(result.content));
  return result.content;
});

export const deleteSession = createAsyncThunk<void, string, ThunkApiType>(
  "session/delete",
  async (id, { getState, dispatch, extra }) => {
    dispatch(deleteSessionMetadata(id)); // optimistic
    const state = getState();
    if (id === selectActiveSession(state).id) {
      await dispatch(loadLastSession());
    }
    const result = await extra.ideMessenger.request("history/delete", { id });
    if (result.status === "error") {
      throw new Error(result.error);
    }
    void dispatch(refreshSessionMetadata({}));
  },
);

export const updateSession = createAsyncThunk<void, Session, ThunkApiType>(
  "session/update",
  async (session, { extra, dispatch }) => {
    dispatch(
      updateSessionMetadata({
        sessionId: session.sessionId,
        title: session.title,
      }),
    ); // optimistic session metadata update
    await extra.ideMessenger.request("history/save", session);
    await dispatch(refreshSessionMetadata({}));
  },
);

/*
 this is only used for the custom focusContinueSessionId command at the moment
*/
export const loadSession = createAsyncThunk<
  void,
  {
    sessionId: string;
    saveCurrentSession: boolean;
  },
  ThunkApiType
>(
  "session/load",
  async (
    { sessionId, saveCurrentSession: save },
    { extra, dispatch, getState },
  ) => {
    if (save) {
      // save the session in the background
      void dispatch(
        saveCurrentSession({
          openNewSession: false,
          generateTitle: true,
        }),
      );
    }

    // Prefer the in-memory session if it has live/unsaved streamed content.
    // The single global `state.session` used to lose a background chat's
    // stream on tab switch because loadSession always re-read from disk.
    const cached = selectSessionById(getState(), sessionId);
    if (
      cached.history.length > 0 ||
      (cached.id === sessionId && cached.title !== NEW_SESSION_TITLE) ||
      selectActiveSession(getState()).id === sessionId
    ) {
      dispatch(
        newSession({
          sessionId: cached.id || sessionId,
          title: cached.title,
          history: cached.history as any,
          mode: cached.mode,
        } as Session),
      );
      return;
    }

    const session = await getSession(extra.ideMessenger, sessionId);
    dispatch(newSession(session));

    // Restore selected chat model from session, if present
    if (session.chatModelTitle) {
      void dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
  },
);

export const selectChatModelForProfile = createAsyncThunk<
  void,
  string,
  ThunkApiType
>(
  "session/selectModelForCurrentProfile",
  async (modelTitle, { extra, dispatch, getState }) => {
    const state = getState();
    const modelMatch = state.config.config?.modelsByRole?.chat?.find(
      (m) => m.title === modelTitle,
    );
    const selectedProfile = selectSelectedProfile(state);
    if (selectedProfile && modelMatch) {
      await dispatch(
        updateSelectedModelByRole({
          role: "chat",
          modelTitle: modelTitle,
          selectedProfile,
        }),
      );
    }
  },
);

export const loadLastSession = createAsyncThunk<void, void, ThunkApiType>(
  "session/loadLast",
  async (_, { extra, dispatch, getState }) => {
    let lastSessionId = selectActiveSession(getState()).lastSessionId;

    // const lastSessionResult = await extra.ideMessenger.request("history/list", {
    //   limit: 1,
    // });
    // if (lastSessionResult.status === "success") {
    //   lastSessionId = lastSessionResult.content.at(0)?.sessionId;
    // }

    if (!lastSessionId) {
      dispatch(newSession());
      return;
    }

    let session: Session;
    try {
      session = await getSession(extra.ideMessenger, lastSessionId);
    } catch {
      // retry again after 1 sec
      await new Promise((resolve) => setTimeout(resolve, 1000));
      session = await getSession(extra.ideMessenger, lastSessionId);
    }
    dispatch(newSession(session));
    if (session.chatModelTitle) {
      dispatch(selectChatModelForProfile(session.chatModelTitle));
    }
  },
);

function getChatTitleFromMessage(message: ChatMessage) {
  const text =
    renderChatMessage(message)
      .split("\n")
      .filter((l) => l.trim() !== "")
      .slice(-1)[0] || "";

  // Truncate
  if (text.length > MAX_TITLE_LENGTH) {
    return text.slice(0, MAX_TITLE_LENGTH - 3) + "...";
  }
  return text;
}

export const saveCurrentSession = createAsyncThunk<
  void,
  { openNewSession: boolean; generateTitle: boolean; sessionId?: string },
  ThunkApiType
>(
  "session/saveCurrent",
  async (
    { openNewSession, generateTitle, sessionId },
    { dispatch, extra, getState },
  ) => {
    // With a sessionId, save that specific (possibly background) session;
    // otherwise fall back to the active session for existing callers.
    const session = sessionId
      ? selectSessionById(getState(), sessionId)
      : selectActiveSession(getState());

    // Start the fresh session BEFORE the empty-history early return below:
    // the native "+" button sends newSession even when the current session has
    // no messages, and skipping the reset there made the button a silent no-op
    // (no new session id → no new tab in the tab bar).
    if (openNewSession) {
      dispatch(newSession());
    }

    if (session.history.length === 0) {
      return;
    }

    const selectedChatModel = selectSelectedChatModel(getState());

    // New session has already been dispatched
    // Now save previous session and update chat title if relevant
    let title = session.title;
    if (title === NEW_SESSION_TITLE) {
      if (
        !getState().config.config?.disableSessionTitles &&
        selectedChatModel
      ) {
        let assistantResponse = session.history
          ?.filter((h) => h.message.role === "assistant")[0]
          ?.message?.content?.toString();

        if (assistantResponse && generateTitle) {
          try {
            console.log(
              `[AUTO_TITLE_STACK][GUI] chatDescriber/describe session=${
                session.id
              }\n${new Error().stack}`,
            );
            const result = await extra.ideMessenger.request(
              "chatDescriber/describe",
              {
                text: assistantResponse,
              },
            );
            if (result.status === "success" && result.content) {
              title = result.content;
            }
          } catch (e) {
            console.error("Error generating chat title", e);
          }
        }
      }
      // Fallbacks if above doesn't work out or session titles disabled
      if (title === NEW_SESSION_TITLE) {
        title = getChatTitleFromMessage(session.history[0].message);
      }
    }
    // More fallbacks in case of no title
    if (!title.length) {
      const metadata = session.allSessionMetadata.find(
        (m) => m.sessionId === session.id,
      );
      if (metadata?.title) {
        title = metadata.title;
      }
    }
    if (!title.length) {
      title = NEW_SESSION_TITLE;
    }

    const updatedSession: Session = {
      sessionId: session.id,
      title,
      workspaceDirectory: window.workspacePaths?.[0] || "",
      history: session.history,
      mode: session.mode,
      chatModelTitle: selectedChatModel?.title ?? null,
    };

    const result = await dispatch(updateSession(updatedSession));
    unwrapResult(result);
  },
);

/**
 * Lightweight, session-aware save used for periodic snapshots while a chat is
 * streaming. Unlike `saveCurrentSession` this never touches the active session,
 * never calls the title-generation model, and never refreshes metadata — it
 * only writes the given session's current history to disk so a webview reload
 * mid-stream loses at most one throttle window of content.
 */
export const saveSessionById = createAsyncThunk<void, string, ThunkApiType>(
  "session/saveById",
  async (sessionId, { getState, extra }) => {
    const state = getState();
    const session = selectSessionById(state, sessionId);
    if (!session.history.length) return;

    const snapshot: Session = {
      sessionId: session.id,
      title: session.title,
      workspaceDirectory: (window as any).workspacePaths?.[0] || "",
      history: session.history,
      mode: session.mode,
      chatModelTitle: selectSelectedChatModel(state)?.title ?? null,
    };
    await extra.ideMessenger.request("history/save", snapshot);
  },
);

const CHUNK_SAVE_INTERVAL_MS = 3_000;
const lastChunkSaveAt = new Map<string, number>();

/**
 * Throttle chunk saves to at most once per `CHUNK_SAVE_INTERVAL_MS` per session.
 * Called from the streaming loop after each chunk is committed. The final
 * end-of-turn save in `streamThunkWrapper` still guarantees a full flush.
 */
export function throttleChunkSave(
  sessionId: string,
  dispatch: AppDispatch,
): void {
  const now = Date.now();
  const last = lastChunkSaveAt.get(sessionId) ?? 0;
  if (now - last < CHUNK_SAVE_INTERVAL_MS) return;
  lastChunkSaveAt.set(sessionId, now);
  void dispatch(saveSessionById(sessionId));
}
