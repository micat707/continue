import { ConfigResult } from "@continuedev/config-yaml";
import type {
  BrowserSerializedContinueConfig,
  ContextItemWithId,
  ContextProviderName,
  IndexingProgressUpdate,
  IndexingStatus,
} from "../index.js";
import type { ProfileDescription } from "../config/ProfileLifecycleManager.js";

export type ToWebviewFromIdeOrCoreProtocol = {
  configUpdate: [
    {
      result: ConfigResult<BrowserSerializedContinueConfig>;
      profileId: string | null;
      profiles: ProfileDescription[];
    },
    void,
  ];
  getDefaultModelTitle: [undefined, string | undefined];
  indexProgress: [IndexingProgressUpdate, void]; // Codebase
  "indexing/statusUpdate": [IndexingStatus, void]; // Docs, etc.
  refreshSubmenuItems: [
    {
      providers: "all" | "dependsOnIndexing" | ContextProviderName[];
    },
    void,
  ];
  didCloseFiles: [{ uris: string[] }, void];
  isContinueInputFocused: [undefined, boolean];
  addContextItem: [
    {
      historyIndex: number;
      item: ContextItemWithId;
    },
    void,
  ];
  setTTSActive: [boolean, void];
  getWebviewHistoryLength: [undefined, number];
  getCurrentSessionId: [undefined, string];
  "jetbrains/setColors": [Record<string, string | null | undefined>, void];
  sessionUpdate: [{ sessionInfo: any | undefined }, void];
  toolCallPartialOutput: [{ toolCallId: string; contextItems: any[] }, void];
  // DeepAgent: live output of a running `execute` command, pushed to the
  // "Run Command" card while the command runs. `chunk` is an INCREMENTAL slice of
  // new (ANSI-stripped) output appended to the card (so the user can scroll back
  // through the command's whole history); `done` + `exitCode` signal completion
  // so the card can flip in place. Keyed by runId so multiple commands (and
  // historical cards) never cross-contaminate the card content.
  deepagentExecuteProgress: [
    { runId: string; chunk?: string; done?: boolean; exitCode?: number | null },
    void,
  ];
};
