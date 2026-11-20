import { configureStore } from "@reduxjs/toolkit";
import { copyOf } from "core/util";
import { vi } from "vitest";
import { MockIdeMessenger } from "../../context/MockIdeMessenger";
import configReducer, {
  INITIAL_CONFIG_SLICE,
} from "../../redux/slices/configSlice";
import editModeStateReducer, {
  INITIAL_EDIT_STATE,
} from "../../redux/slices/editState";
import indexingReducer, {
  INITIAL_INDEXING_STATE,
} from "../../redux/slices/indexingSlice";
import {
  INITIAL_PROFILES_STATE,
  profilesReducer,
} from "../../redux/slices/profilesSlice";
import sessionReducer, {
  INITIAL_SESSION_STATE,
  createSessionData,
} from "../../redux/slices/sessionSlice";
import tabsReducer, { INITIAL_TABS_STATE } from "../../redux/slices/tabsSlice";
import uiReducer, { DEFAULT_UI_SLICE } from "../../redux/slices/uiSlice";
import { RootState } from "../../redux/store";

// TODO remove non-serializable streamAborter, causes headaches
export const getEmptyRootState: () => RootState = () => {
  const withoutSession: Omit<RootState, "session"> = {
    config: INITIAL_CONFIG_SLICE,
    ui: DEFAULT_UI_SLICE,
    editModeState: INITIAL_EDIT_STATE,
    indexing: INITIAL_INDEXING_STATE,
    profiles: INITIAL_PROFILES_STATE,
    tabs: INITIAL_TABS_STATE,
  };
  const withoutSessionCopy = copyOf(withoutSession) as Omit<
    RootState,
    "session"
  >;
  // Each SessionData owns a non-serializable AbortController; rebuild it after
  // the structural copy instead of letting `copyOf` shallow-share it.
  const sessions: Record<string, any> = {};
  for (const [id, data] of Object.entries(INITIAL_SESSION_STATE.sessions)) {
    sessions[id] = {
      ...copyOf(data),
      streamAborter: new AbortController(),
      streamAborters: {},
    };
  }
  return {
    ...withoutSessionCopy,
    session: {
      activeSessionId: INITIAL_SESSION_STATE.activeSessionId,
      isSessionMetadataLoading: false,
      allSessionMetadata: [],
      sessions,
    } as RootState["session"],
  };
};

export const createMockStore = (
  initialState?: Partial<RootState>,
  mockMessenger?: MockIdeMessenger,
): ReturnType<typeof configureStore> & {
  mockIdeMessenger: MockIdeMessenger;
  getActions: () => any[];
  clearActions: () => void;
} => {
  const mockIdeMessenger = mockMessenger ?? new MockIdeMessenger();

  const store = configureStore({
    reducer: {
      session: sessionReducer,
      ui: uiReducer,
      editModeState: editModeStateReducer,
      config: configReducer,
      indexing: indexingReducer,
      tabs: tabsReducer,
      profiles: profilesReducer,
    },
    preloadedState: {
      ...getEmptyRootState(),
      ...initialState,
    },
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: {
          ignoredPaths: ["session.streamAborter", "ui.dialogMessage"],
          ignoredActions: ["ui/setDialogMessage"],
        },
        thunk: {
          extraArgument: {
            ideMessenger: mockIdeMessenger,
          },
        },
      }),
  });

  // Add getActions method for testing
  const actions: any[] = [];
  const originalDispatch = store.dispatch;

  // Override dispatch to track actions and inject ideMessenger
  store.dispatch = vi.fn((action: any) => {
    if (typeof action === "function") {
      // For thunks, provide the extra argument with ideMessenger
      return action(store.dispatch, store.getState, {
        ideMessenger: mockIdeMessenger,
      });
    }
    actions.push(action);
    return originalDispatch(action);
  });

  // Expose mockIdeMessenger so tests can configure it
  return {
    ...store,
    mockIdeMessenger,
    getActions: () => actions,
    clearActions: () => actions.splice(0, actions.length),
  };
};
