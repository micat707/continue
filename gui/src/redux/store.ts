import {
  combineReducers,
  configureStore,
  ThunkDispatch,
  UnknownAction,
} from "@reduxjs/toolkit";
import { createLogger } from "redux-logger";
import {
  createMigrate,
  MigrationManifest,
  persistReducer,
  persistStore,
} from "redux-persist";
import { createFilter } from "redux-persist-transform-filter";
import autoMergeLevel2 from "redux-persist/lib/stateReconciler/autoMergeLevel2";
import storage from "redux-persist/lib/storage";
import { IdeMessenger, IIdeMessenger } from "../context/IdeMessenger";
import configReducer from "./slices/configSlice";
import editModeStateReducer from "./slices/editState";
import indexingReducer from "./slices/indexingSlice";
import { profilesReducer } from "./slices/profilesSlice";
import sessionReducer, { createSessionData } from "./slices/sessionSlice";
import { NEW_SESSION_TITLE } from "core/util/constants";
import tabsReducer from "./slices/tabsSlice";
import uiReducer from "./slices/uiSlice";

const rootReducer = combineReducers({
  session: sessionReducer,
  ui: uiReducer,
  editModeState: editModeStateReducer,
  config: configReducer,
  indexing: indexingReducer,
  tabs: tabsReducer,
  profiles: profilesReducer,
});

const saveSubsetFilters = [
  createFilter("session", [
    // Multi-session store: persist only serializable, authoritative fields.
    // `sessions` histories keep the live view intact across webview reloads;
    // AbortControllers are stripped by `sessionAborterTransform` below.
    "sessions",
    "activeSessionId",
    "lastSessionId",
  ]),
  createFilter("editModeState", [
    "returnToMode",
    "lastNonEditSessionWasEmpty",
    "codeToEdit",
  ]),
  createFilter("config", []),
  createFilter("ui", [
    "toolSettings",
    "toolGroupSettings",
    "ruleSettings",
    "reasoningSettings",
  ]),
  createFilter("indexing", []),
  createFilter("tabs", ["tabs"]),
  createFilter("profiles", ["preferencesByProfileId", "selectedProfileId"]),
];

/**
 * AbortControllers are class instances that survive JSON round-trips as `{}`.
 * Strip them to storage and rebuild fresh ones on rehydrate so a restored chat
 * can still be stopped.
 */
const sessionAborterTransform = {
  in: (state: any) => {
    if (!state?.session?.sessions) return state;
    const sessions: Record<string, any> = {};
    for (const [id, data] of Object.entries(state.session.sessions) as any) {
      const { streamAborter, streamAborters, ...rest } = data as any;
      sessions[id] = rest;
    }
    return { ...state, session: { ...state.session, sessions } };
  },
  out: (state: any) => {
    if (!state?.session?.sessions) return state;
    const sessions: Record<string, any> = {};
    for (const [id, data] of Object.entries(state.session.sessions) as any) {
      sessions[id] = {
        ...(data as any),
        streamAborter: new AbortController(),
        streamAborters: {},
      };
    }
    return { ...state, session: { ...state.session, sessions } };
  },
};

const migrations: MigrationManifest = {
  // v2: state.session changed from a flat session object to a multi-session
  // store ({ sessions, activeSessionId, ... }). Old persisted flat fields are
  // incompatible; drop them and let initialState/loadLastSession rebuild.
  "2": (state) => {
    const old = state as any;
    const prevSession = old?.session ?? {};
    const id: string = prevSession.id || "";
    const activeId = id || "migrated-session";
    return {
      ...old,
      session: {
        sessions: {
          [activeId]: {
            ...createSessionData(activeId),
            title: prevSession.title ?? NEW_SESSION_TITLE,
            history: prevSession.history ?? [],
            mode: prevSession.mode ?? "agent",
            lastSessionId: prevSession.lastSessionId,
          },
        },
        activeSessionId: activeId,
        lastSessionId: prevSession.lastSessionId,
        isSessionMetadataLoading: false,
        allSessionMetadata: [],
      },
    };
  },
  "0": (state) => {
    const oldState = state as any;

    return {
      config: {
        defaultModelTitle: oldState?.state?.defaultModelTitle ?? undefined,
      },
      session: {
        id: oldState?.state?.sessionId ?? "",
      },
      tabs: {
        tabs: [
          {
            id:
              Date.now().toString(36) + Math.random().toString(36).substring(2),
            title: "Chat 1",
            isActive: true,
          },
        ],
      },
      _persist: oldState?._persist,
    };
  },
};

const persistConfig = {
  version: 2,
  key: "root",
  storage,
  transforms: [...saveSubsetFilters, sessionAborterTransform as any],
  stateReconciler: autoMergeLevel2,
  migrate: createMigrate(migrations, { debug: false }),
};

const persistedReducer = persistReducer<ReturnType<typeof rootReducer>>(
  persistConfig,
  rootReducer,
);

export function setupStore(options: { ideMessenger?: IIdeMessenger }) {
  const ideMessenger = options.ideMessenger ?? new IdeMessenger();

  const logger = createLogger({
    // Customize logger options if needed
    collapsed: true, // Collapse console groups by default
    timestamp: false, // Remove timestamps from log
    diff: true, // Show diff between states
  });

  return configureStore({
    // persistedReducer causes type errors with async thunks
    reducer: persistedReducer as unknown as typeof rootReducer,
    // reducer: rootReducer,
    middleware: (getDefaultMiddleware) =>
      getDefaultMiddleware({
        serializableCheck: false,
        thunk: {
          extraArgument: {
            ideMessenger,
          },
        },
      }),
    // This can be uncommented to get detailed Redux logs
    // .concat(logger),
  });
}

export type ThunkExtrasType = { ideMessenger: IIdeMessenger };

export type ThunkApiType = {
  state: RootState;
  extra: ThunkExtrasType;
};

export type AppThunkDispatch = ThunkDispatch<
  RootState,
  ThunkExtrasType,
  UnknownAction
>;

export const store = setupStore({});

export type RootState = ReturnType<typeof rootReducer>;

export type AppDispatch = typeof store.dispatch;

export const persistor = persistStore(store);
