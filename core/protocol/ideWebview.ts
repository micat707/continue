import { ToIdeFromWebviewOrCoreProtocol } from "./ide";
import { ToWebviewFromIdeOrCoreProtocol } from "./webview";

import {
  AcceptOrRejectDiffPayload,
  AddToChatPayload,
  ApplyState,
  ApplyToFilePayload,
  HighlightedCodePayload,
  MessageContent,
  RangeInFileWithContents,
  SetCodeToEditPayload,
  ShowFilePayload,
} from "../";

export type ToIdeFromWebviewProtocol = ToIdeFromWebviewOrCoreProtocol & {
  openUrl: [string, void];
  applyToFile: [ApplyToFilePayload, void];
  overwriteFile: [{ filepath: string; prevFileContent: string | null }, void];
  showTutorial: [undefined, void];
  showFile: [ShowFilePayload, void];
  toggleDevTools: [undefined, void];
  reloadWindow: [undefined, void];
  focusEditor: [undefined, void];
  toggleFullScreen: [{ newWindow?: boolean } | undefined, void];
  insertAtCursor: [{ text: string }, void];
  copyText: [{ text: string }, void];
  "jetbrains/isOSREnabled": [undefined, boolean];
  "jetbrains/onLoad": [
    undefined,
    {
      windowId: string;
      serverUrl: string;
      workspacePaths: string[];
      vscMachineId: string;
      vscMediaUrl: string;
    },
  ];
  "jetbrains/getColors": [undefined, Record<string, string | null | undefined>];
  "vscode/openMoveRightMarkdown": [undefined, void];
  acceptDiff: [AcceptOrRejectDiffPayload, void];
  rejectDiff: [AcceptOrRejectDiffPayload, void];
  /**
   * Open the VS Code multi-file "Changes" editor (vscode.changes) to review a
   * set of pending file edits, mirroring Kiro's "View changes" action on the
   * review-changes card. `originalContent`/`newContent` for each file are shown
   * as the left/right sides of the diff (read from the apply state, so it works
   * even before the edit is written to disk).
   */
  showChanges: [
    {
      title: string;
      files: {
        filepath: string;
        originalContent?: string;
        newContent?: string;
      }[];
    },
    void,
  ];
  /**
   * Open a single-file side-by-side diff editor (vscode.diff) for one agent
   * edit. Both sides are supplied explicitly from the tool result's unified
   * diff, so no disk read is needed and the comparison stays correct even if
   * the file is edited again afterwards.
   */
  showEditDiff: [
    {
      title: string;
      filepath: string;
      originalContent: string;
      newContent: string;
    },
    void,
  ];
  /** Consolidated list of all files changed in the workspace (one record per
   *  file, multiple edits collapsed) — used for the end-of-session summary. */
  getChangedFiles: [
    {},
    { filepath: string; originalContent?: string; newContent?: string }[],
  ];
  "edit/sendPrompt": [
    {
      prompt: MessageContent;
      range: RangeInFileWithContents;
    },
    string | undefined,
  ];
  "edit/addCurrentSelection": [undefined, void];
  "edit/clearDecorations": [undefined, void];
  "session/share": [{ sessionId: string }, void];
  /**
   * GUI → IDE: the user's decision(s) on a DeepAgent human-in-the-loop
   * interrupt (read/write/edit/delete outside the workspace). `decisions` is a
   * parallel array to the interrupt's `actionRequests`; an unselected item
   * defaults to "reject".
   */
  deepAgentInterruptResponse: [
    {
      /** Matches the `requestId` of the originating `deepAgentInterrupt`. */
      requestId: string;
      decisions: Array<{ id: string; type: "approve" | "reject" }>;
    },
    void,
  ];
  /** GUI → IDE: read the full DeepAgent tool-permission state (3 layers). */
  "deepAgent/permissions/getState": [undefined, DeepAgentPermissionsState];
  /** GUI → IDE: persist one policy layer (global → user settings, workspace → workspace settings). */
  "deepAgent/permissions/updateLayer": [
    {
      layer: "global" | "workspace";
      config: DeepAgentPermissionConfig;
    },
    DeepAgentPermissionsState,
  ];
  /** GUI → IDE: clear the current chat's session permission memory. */
  "deepAgent/permissions/clearSession": [undefined, DeepAgentPermissionsState];
  /**
   * GUI → IDE: open the Continue GUI as a full editor-area tab (the sidebar
   * webview is too narrow for the config pages). `page` is an in-app route
   * like "/config?tab=permissions".
   */
  "deepAgent/openFullScreenConfig": [{ page: string }, void];
};

/** ---- DeepAgent tool-permission protocol payloads ---- */

export type DeepAgentPermissionAction = "allow" | "ask" | "deny";

export interface DeepAgentPermissionRule {
  tool: string;
  action: DeepAgentPermissionAction;
}

export interface DeepAgentPermissionConfig {
  trustedDirs?: string[];
  trustRules?: DeepAgentPermissionRule[];
  untrustRules?: DeepAgentPermissionRule[];
  /** Programs/command patterns that auto-run via `execute` without the card. */
  executeAllowlist?: string[];
}

export interface DeepAgentPermissionMergedRule extends DeepAgentPermissionRule {
  /** Which layer currently provides the effective action. */
  source: "global" | "workspace" | "session";
}

export interface DeepAgentPermissionsState {
  global: DeepAgentPermissionConfig;
  workspace: DeepAgentPermissionConfig;
  /** Session memory: all-tools grants, read-only subtree grants, denials. */
  session: {
    approved: string[];
    readApproved: string[];
    denied: string[];
  };
  merged: {
    trustRules: DeepAgentPermissionMergedRule[];
    untrustRules: DeepAgentPermissionMergedRule[];
    trustedDirs: string[];
    executeAllowlist: string[];
  };
  workspaceFolders: string[];
}

export type ToWebviewFromIdeProtocol = ToWebviewFromIdeOrCoreProtocol & {
  setInactive: [undefined, void];
  newSessionWithPrompt: [{ prompt: string }, void];
  userInput: [{ input: string }, void];
  focusContinueInput: [undefined, void];
  focusContinueInputWithoutClear: [undefined, void];
  focusContinueInputWithNewSession: [undefined, void];
  highlightedCode: [HighlightedCodePayload, void];
  setCodeToEdit: [SetCodeToEditPayload, void];
  navigateTo: [{ path: string; toggle?: boolean }, void];
  addModel: [undefined, void];

  focusContinueSessionId: [{ sessionId: string | undefined }, void];
  newSession: [undefined, void];
  setTheme: [{ theme: any }, void];
  setColors: [{ [key: string]: string }, void];
  "jetbrains/editorInsetRefresh": [undefined, void];
  "jetbrains/isOSREnabled": [boolean, void];
  setupApiKey: [undefined, void];
  setupLocalConfig: [undefined, void];
  incrementFtc: [undefined, void];
  openOnboardingCard: [undefined, void];
  applyCodeFromChat: [undefined, void];
  updateApplyState: [ApplyState, void];
  exitEditMode: [undefined, void];
  focusEdit: [undefined, void];
  addToChat: [AddToChatPayload, void];
  /**
   * IDE → GUI: a DeepAgent tool call that needs the user's approval before it
   * runs (read/write/edit/delete outside the workspace). `request` is the raw
   * HITL payload (actionRequests + reviewConfigs); the GUI renders a
   * ReviewChangesCard and replies via `deepAgentInterruptResponse`.
   */
  deepAgentInterrupt: [
    {
      /** Unique id for this pending approval; echoed back by the GUI so the
       * IDE can resolve the exact waiting request even across sessions. */
      requestId: string;
      request: {
        actionRequests?: Array<{
          name?: string;
          args?: Record<string, unknown>;
        }>;
        reviewConfigs?: unknown;
      };
    },
    void,
  ];
};
