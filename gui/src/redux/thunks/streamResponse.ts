import { inSession, selectActiveSession } from "../slices/sessionSlice";
import { createAsyncThunk, unwrapResult } from "@reduxjs/toolkit";
import { JSONContent } from "@tiptap/core";
import { InputModifiers } from "core";

import { v4 as uuidv4 } from "uuid";
import { resolveEditorContent } from "../../components/mainInput/TipTapEditor/utils/resolveEditorContent";
import { selectSelectedChatModel } from "../slices/configSlice";
import {
  resetNextCodeBlockToApplyIndex,
  submitEditorAndInitAtIndex,
  updateHistoryItemAtIndex,
} from "../slices/sessionSlice";
import { ThunkApiType } from "../store";
import { streamNormalInput } from "./streamNormalInput";
import { streamThunkWrapper } from "./streamThunkWrapper";
import { updateFileSymbolsFromFiles } from "./updateFileSymbols";

export const streamResponseThunk = createAsyncThunk<
  void,
  {
    editorState: JSONContent;
    modifiers: InputModifiers;
    index?: number;
  },
  ThunkApiType
>(
  "chat/streamResponse",
  async ({ editorState, modifiers, index }, { dispatch, extra, getState }) => {
    // Capture the owning session ONCE at entry. If the user switches chats while
    // context providers resolve, every write below and the turn-end flush must
    // still land in the session that started this turn.
    const owningSessionId = selectActiveSession(getState()).id;
    await dispatch(
      streamThunkWrapper({
        sessionId: owningSessionId,
        run: async () => {
          const state = getState();
          const selectedChatModel = selectSelectedChatModel(state);
          const inputIndex = index ?? selectActiveSession(state).history.length; // Either given index or concat to end

          if (!selectedChatModel) {
            throw new Error("No chat model selected");
          }
          dispatch(
            inSession(
              submitEditorAndInitAtIndex({ index: inputIndex, editorState }),
              owningSessionId,
            ),
          );

          dispatch(
            inSession(resetNextCodeBlockToApplyIndex(), owningSessionId),
          );

          const defaultContextProviders =
            state.config.config.experimental?.defaultContext ?? [];

          // Resolve context providers and construct new history
          const {
            selectedContextItems,
            selectedCode,
            content,
            legacyCommandWithInput,
          } = await resolveEditorContent({
            editorState,
            modifiers,
            ideMessenger: extra.ideMessenger,
            defaultContextProviders,
            availableSlashCommands: state.config.config.slashCommands,
            dispatch,
            getState,
          });

          // symbols for both context items AND selected codeblocks
          const filesForSymbols = [
            ...selectedContextItems
              .filter((item) => item.uri?.type === "file" && item?.uri?.value)
              .map((item) => item.uri!.value),
            ...selectedCode.map((rif) => rif.filepath),
          ];
          void dispatch(updateFileSymbolsFromFiles(filesForSymbols));

          dispatch(
            inSession(
              updateHistoryItemAtIndex({
                index: inputIndex,
                updates: {
                  message: {
                    role: "user",
                    content,
                    id: uuidv4(),
                  },
                  contextItems: selectedContextItems,
                },
              }),
              owningSessionId,
            ),
          );

          unwrapResult(
            await dispatch(
              streamNormalInput({
                sessionId: owningSessionId,
                legacySlashCommandData: legacyCommandWithInput
                  ? {
                      command: legacyCommandWithInput.command,
                      contextItems: selectedContextItems,
                      historyIndex: inputIndex,
                      input: legacyCommandWithInput.input,
                      selectedCode,
                    }
                  : undefined,
              }),
            ),
          );
        },
      }),
    );
  },
);
