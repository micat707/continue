/* eslint-disable @typescript-eslint/naming-convention */
import * as fs from "node:fs";

import { ContextMenuConfig, ILLM, ModelInstaller } from "core";
import { CompletionProvider } from "core/autocomplete/CompletionProvider";
import { ConfigHandler } from "core/config/ConfigHandler";
import { EXTENSION_NAME } from "core/util/constants";
import { Core } from "core/core";
import { walkDirAsync } from "core/indexing/walkDir";
import { isModelInstaller } from "core/llm";
import { NextEditLoggingService } from "core/nextEdit/NextEditLoggingService";
import { startLocalLemonade } from "core/util/lemonadeHelper";
import { startLocalOllama } from "core/util/ollamaHelper";
import {
  getConfigJsonPath,
  getConfigYamlPath,
  setConfigFilePermissions,
} from "core/util/paths";
import * as vscode from "vscode";
import * as YAML from "yaml";

import { convertJsonToYamlConfig } from "../../../packages/config-yaml/dist";

import {
  getAutocompleteStatusBarDescription,
  getAutocompleteStatusBarTitle,
  getNextEditMenuItems,
  getStatusBarStatus,
  getStatusBarStatusFromQuickPickItemLabel,
  handleNextEditToggle,
  isNextEditToggleLabel,
  quickPickStatusText,
  setupStatusBar,
  StatusBarStatus,
} from "./autocomplete/statusBar";
import { ContinueConsoleWebviewViewProvider } from "./ContinueConsoleWebviewViewProvider";
import { ContinueGUIWebviewViewProvider } from "./ContinueGUIWebviewViewProvider";
import { processDiff } from "./diff/processDiff";
import { VerticalDiffManager } from "./diff/vertical/manager";
import EditDecorationManager from "./quickEdit/EditDecorationManager";
import { QuickEdit, QuickEditShowParams } from "./quickEdit/QuickEditQuickPick";
import {
  addCodeToContextFromRange,
  addEntireFileToContext,
  addHighlightedCodeToContext,
} from "./util/addCode";
import { Battery } from "./util/battery";
import { getMetaKeyLabel } from "./util/util";
import { openEditorAndRevealRange } from "./util/vscode";
import { VsCodeIde } from "./VsCodeIde";
import { toggleGUI } from "./chatToggle.js";

import { createDeepAgent } from "deepagents";
import { HumanMessage } from "@langchain/core/messages";
import { ContinueLLMAdapter } from "./deepagents/ContinueLLMAdapter";
import { DeepAgentChatPanel } from "./deepagents/DeepAgentChatPanel";
import { wrapWithDeepAgent } from "./deepagents/DeepAgentLLM";
import { setArtifactPusher } from "./deepagents/artifactBridge";
import {
  setArtifactStoreRoot,
  startArtifactWatcher,
  onArtifactsChanged,
} from "./deepagents/artifactStore";
import {
  createWorkspaceBackend,
  describeRoots,
  pickRootOverride,
} from "./deepagents/workspaceBackend";

// DeepAgent "engine mode" state: when ON, Continue's main chat is driven by the
// DeepAgent loop (using the selected model as its engine). Selector unchanged.
let deepAgentEnabled = false;
/**
 * Optional manual root override. When undefined, DeepAgent's file tools follow
 * `vscode.workspace.workspaceFolders` (every folder in Explorer) automatically.
 */
let deepAgentRoot: string | undefined;

// Status bar = always-visible proof of which engine the main chat will use.
let deepAgentStatusBar: vscode.StatusBarItem | undefined;
let deepAgentLastTurnAt: number | undefined;
let deepAgentWrapped = false;

function updateDeepAgentStatusBar() {
  if (!deepAgentStatusBar) return;
  const hit = deepAgentLastTurnAt
    ? ` · hit ${new Date(deepAgentLastTurnAt).toLocaleTimeString()}`
    : "";
  deepAgentStatusBar.text = deepAgentEnabled
    ? `$(hubot) DeepAgent: ON${hit}`
    : "$(hubot) DeepAgent: OFF";
  deepAgentStatusBar.backgroundColor = deepAgentEnabled
    ? undefined
    : new vscode.ThemeColor("statusBarItem.warningBackground");
  deepAgentStatusBar.tooltip = deepAgentEnabled
    ? `Main chat is routed through DeepAgent (model: ${deepAgentWrapped ? "wrapped" : "NOT wrapped"})\nWorkspace: ${describeRoots(deepAgentRoot)}\nLast turn: ${deepAgentLastTurnAt ? new Date(deepAgentLastTurnAt).toLocaleString() : "none yet"}\nClick to turn OFF`
    : "Main chat uses the model directly (Continue native).\nClick to turn ON DeepAgent";
  deepAgentStatusBar.show();
}

function markDeepAgentTurn() {
  deepAgentLastTurnAt = Date.now();
  updateDeepAgentStatusBar();
}

/** Write a persisted setting without letting a settings failure abort a command. */
async function setDeepAgentSetting(key: string, value: boolean | string) {
  try {
    await vscode.workspace
      .getConfiguration("continue")
      .update(key, value, vscode.ConfigurationTarget.Global);
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    console.warn(
      `[DeepAgent] could not persist ${key}: ${err.message}`,
      "\nSTACK:",
      err.stack,
    );
  }
}

/** Wrap (or unwrap) the selected chat model with DeepAgentLLM per the flag. */
function applyDeepAgentWrap(config: any) {
  const chat = config?.selectedModelByRole?.chat;
  const arr: any[] | undefined = config?.modelsByRole?.chat;

  if (deepAgentEnabled && chat) {
    if (!(chat as any).__deepAgent) {
      const wrapped = wrapWithDeepAgent(chat, deepAgentRoot, markDeepAgentTurn);
      config.selectedModelByRole.chat = wrapped;
      if (arr) {
        const i = arr.findIndex((m) => m.title === chat.title);
        if (i >= 0) arr[i] = wrapped;
      }
      console.log(
        `[DeepAgent] chat model "${chat.title ?? chat.model}" wrapped (workspace=${describeRoots(deepAgentRoot)}) — main chat now uses DeepAgent`,
      );
    }
    deepAgentWrapped = true;
  } else {
    if (chat && (chat as any).__deepAgent) {
      const orig = (chat as any).__original;
      config.selectedModelByRole.chat = orig;
      if (arr) {
        const i = arr.findIndex((m) => (m as any).__deepAgent);
        if (i >= 0) arr[i] = orig;
      }
      console.log(
        "[DeepAgent] chat model restored — main chat uses Continue native",
      );
    }
    deepAgentWrapped = false;
  }
  updateDeepAgentStatusBar();
}

export let fullScreenPanel: vscode.WebviewPanel | undefined;

/**
 * Set inside getCommandsMap (which has the sidebar/extensionContext closure) so
 * other modules (e.g. VsCodeMessenger) can open the full-screen GUI at a route.
 */
export let openFullScreenGUIImpl:
  | ((page?: string) => Promise<void>)
  | undefined;

export function getFullScreenTab() {
  const tabs = vscode.window.tabGroups.all.flatMap((tabGroup) => tabGroup.tabs);
  return tabs.find((tab) =>
    (tab.input as any)?.viewType?.endsWith("continue.continueGUIView"),
  );
}

function focusGUI() {
  const fullScreenTab = getFullScreenTab();
  if (fullScreenTab) {
    // focus fullscreen
    fullScreenPanel?.reveal();
  } else {
    // focus sidebar
    vscode.commands.executeCommand("continue.continueGUIView.focus");
    // vscode.commands.executeCommand("workbench.action.focusAuxiliaryBar");
  }
}

function hideGUI() {
  const fullScreenTab = getFullScreenTab();
  if (fullScreenTab) {
    // focus fullscreen
    fullScreenPanel?.dispose();
  } else {
    // focus sidebar
    vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    // vscode.commands.executeCommand("workbench.action.toggleAuxiliaryBar");
  }
}

function waitForSidebarReady(
  sidebar: ContinueGUIWebviewViewProvider,
  timeout: number,
  interval: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    const startTime = Date.now();

    const checkReadyState = () => {
      if (sidebar.isReady) {
        resolve(true);
      } else if (Date.now() - startTime >= timeout) {
        resolve(false); // Timed out
      } else {
        setTimeout(checkReadyState, interval);
      }
    };

    checkReadyState();
  });
}

// Copy everything over from extension.ts
const getCommandsMap: (
  ide: VsCodeIde,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  consoleView: ContinueConsoleWebviewViewProvider,
  configHandler: ConfigHandler,
  verticalDiffManager: VerticalDiffManager,
  battery: Battery,
  quickEdit: QuickEdit,
  core: Core,
  editDecorationManager: EditDecorationManager,
) => { [command: string]: (...args: any) => any } = (
  ide,
  extensionContext,
  sidebar,
  consoleView,
  configHandler,
  verticalDiffManager,
  battery,
  quickEdit,
  core,
  editDecorationManager,
) => {
  // Kiro-aligned artifacts: register the GUI pusher so the create_artifact tool
  // (running inside the wrapped-model singleton) can stream artifacts to the
  // sidebar webview for the artifact panel + inline previews.
  setArtifactPusher((payload) => {
    void sidebar.webviewProtocol.send("artifactPush", payload);
  });
  // Kiro-aligned artifact store: disk-backed manifest under globalStorage.
  setArtifactStoreRoot(extensionContext.globalStorageUri.fsPath);
  startArtifactWatcher(extensionContext.subscriptions);
  onArtifactsChanged((sessionId, artifacts) => {
    void sidebar.webviewProtocol.send("artifactPushBulk", {
      sessionId,
      artifacts,
    });
  });

  // DeepAgent engine mode: wrap the selected chat model on every (re)load so the
  // main chat is driven by DeepAgent while the model selector stays unchanged.
  const daConfig = vscode.workspace.getConfiguration("continue");
  deepAgentEnabled = daConfig.get<boolean>("deepAgentMode", true) ?? false;
  // Empty / unset = follow VS Code workspace folders automatically.
  deepAgentRoot = daConfig.get<string>("deepAgentRoot", "") || undefined;
  deepAgentStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  deepAgentStatusBar.command = "continue.toggleDeepAgent";
  extensionContext.subscriptions.push(deepAgentStatusBar);
  extensionContext.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() =>
      updateDeepAgentStatusBar(),
    ),
  );
  configHandler.onConfigUpdate((result) => applyDeepAgentWrap(result.config));
  configHandler
    .loadConfig()
    .then((r) => applyDeepAgentWrap(r?.config))
    .catch(() => {});
  updateDeepAgentStatusBar();

  /**
   * Open the Continue GUI as a full editor-area tab (ViewColumn.One), optionally
   * starting at a specific route (e.g. "/config?tab=permissions"). The route is
   * injected into the webview HTML as `window.initialRoute` (see
   * getSidebarContent) and consumed by the GUI's memory router.
   * Shared by the "continue.openInNewWindow" command and the GUI's
   * "deepAgent/openFullScreenConfig" webview message.
   */
  const openFullScreenGUI = async (page?: string) => {
    focusGUI();

    // Check if full screen is already open by checking open tabs
    const fullScreenTab = getFullScreenTab();

    if (fullScreenTab && fullScreenPanel) {
      // Full screen already open — just navigate it (targeted post bypasses
      // the shared protocol router) and reveal. No reload → instant.
      if (page) {
        fullScreenPanel.webview.postMessage({
          type: "deepAgent/navigate",
          page,
        });
      }
      fullScreenPanel.reveal();
      return;
    }

    // Create the full screen panel FIRST so it shows up immediately; the
    // session bookkeeping below runs without blocking its appearance.
    let panel = vscode.window.createWebviewPanel(
      "continue.continueGUIView",
      "Continue",
      vscode.ViewColumn.One,
      {
        retainContextWhenHidden: true,
        enableScripts: true,
      },
    );
    fullScreenPanel = panel;

    // Add content to the panel
    panel.webview.html = sidebar.getSidebarContent(
      extensionContext,
      panel,
      page,
      undefined,
      true,
    );

    // When panel closes, reset the webview and allow re-creation next time.
    panel.onDidDispose(
      () => {
        fullScreenPanel = undefined;
        sidebar.resetWebviewProtocolWebview();
        vscode.commands.executeCommand("continue.focusContinueInput");
      },
      null,
      extensionContext.subscriptions,
    );

    // Session bookkeeping (non-blocking for the panel's first paint).
    const sessionId = await sidebar.webviewProtocol.request(
      "getCurrentSessionId",
      undefined,
    );
    vscode.commands.executeCommand("continue.newSession");

    const sessionLoader = panel.onDidChangeViewState(() => {
      vscode.commands.executeCommand("continue.newSession");
      if (sessionId) {
        vscode.commands.executeCommand(
          "continue.focusContinueSessionId",
          sessionId,
        );
      }
      panel.reveal();
      sessionLoader.dispose();
    });

    // Keep the shared protocol pointer on the full-screen panel while it is
    // the active editor tab, so its requests/responses are routed correctly.
    // The sidebar takes the pointer back via onDidChangeVisibility.
    panel.onDidChangeViewState(
      ({ webviewPanel }) => {
        if (webviewPanel.active) {
          sidebar.webviewProtocol.webview = webviewPanel.webview;
        }
      },
      null,
      extensionContext.subscriptions,
    );
  };
  openFullScreenGUIImpl = openFullScreenGUI;

  /**
   * Streams an inline edit to the vertical diff manager.
   *
   * This function retrieves the configuration, determines the appropriate model title,
   * increments the FTC count, and then streams an edit to the
   * vertical diff manager.
   *
   * @param  promptName - The key for the prompt in the context menu configuration.
   * @param  fallbackPrompt - The prompt to use if the configured prompt is not available.
   * @param  [range] - Optional. The range to edit if provided.
   * @returns
   */
  async function streamInlineEdit(
    promptName: keyof ContextMenuConfig,
    fallbackPrompt: string,
    range?: vscode.Range,
  ) {
    const { config } = await configHandler.loadConfig();
    if (!config) {
      throw new Error("Config not loaded");
    }

    const llm =
      config.selectedModelByRole.edit ?? config.selectedModelByRole.chat;

    if (!llm) {
      throw new Error("No edit or chat model selected");
    }

    void sidebar.webviewProtocol.request("incrementFtc", undefined);

    await verticalDiffManager.streamEdit({
      input:
        config.experimental?.contextMenuPrompts?.[promptName] ?? fallbackPrompt,
      llm,
      range,
      rulesToInclude: config.rules,
      isApply: false,
    });
  }

  return {
    "continue.acceptDiff": async (
      newFileUri?: string,
      streamId?: string,
      toolCallId?: string,
    ) => {
      void processDiff(
        "accept",
        sidebar,
        ide,
        core,
        verticalDiffManager,
        newFileUri,
        streamId,
        toolCallId,
      );
    },

    "continue.rejectDiff": async (
      newFileUri?: string,
      streamId?: string,
      toolCallId?: string,
    ) => {
      void processDiff(
        "reject",
        sidebar,
        ide,
        core,
        verticalDiffManager,
        newFileUri,
        streamId,
        toolCallId,
      );
    },
    "continue.acceptVerticalDiffBlock": (fileUri?: string, index?: number) => {
      verticalDiffManager.acceptRejectVerticalDiffBlock(true, fileUri, index);
    },
    "continue.rejectVerticalDiffBlock": (fileUri?: string, index?: number) => {
      verticalDiffManager.acceptRejectVerticalDiffBlock(false, fileUri, index);
    },
    "continue.quickFix": async (
      range: vscode.Range,
      diagnosticMessage: string,
    ) => {
      const prompt = `Please explain the cause of this error and how to solve it: ${diagnosticMessage}`;

      addCodeToContextFromRange(range, sidebar.webviewProtocol, prompt);

      vscode.commands.executeCommand("continue.continueGUIView.focus");
    },
    "continue.defaultQuickAction": async (args: QuickEditShowParams) => {
      vscode.commands.executeCommand("continue.focusEdit", args);
    },
    "continue.customQuickActionSendToChat": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      addCodeToContextFromRange(range, sidebar.webviewProtocol, prompt);

      vscode.commands.executeCommand("continue.continueGUIView.focus");
    },
    "continue.customQuickActionStreamInlineEdit": async (
      prompt: string,
      range: vscode.Range,
    ) => {
      streamInlineEdit("docstring", prompt, range);
    },
    "continue.codebaseForceReIndex": async () => {
      core.invoke("index/forceReIndex", undefined);
    },
    "continue.rebuildCodebaseIndex": async () => {
      core.invoke("index/forceReIndex", { shouldClearIndexes: true });
    },
    "continue.docsIndex": async () => {
      core.invoke("context/indexDocs", { reIndex: false });
    },
    "continue.docsReIndex": async () => {
      core.invoke("context/indexDocs", { reIndex: true });
    },
    "continue.focusContinueInput": async () => {
      const isContinueInputFocused = await sidebar.webviewProtocol.request(
        "isContinueInputFocused",
        undefined,
        false,
      );

      // This is a temporary fix—sidebar.webviewProtocol.request is blocking
      // when the GUI hasn't yet been setup and we should instead be
      // immediately throwing an error, or returning a Result object
      focusGUI();
      if (!sidebar.isReady) {
        const isReady = await waitForSidebarReady(sidebar, 5000, 100);
        if (!isReady) {
          return;
        }
      }

      const historyLength = await sidebar.webviewProtocol.request(
        "getWebviewHistoryLength",
        undefined,
        false,
      );

      if (isContinueInputFocused) {
        if (historyLength === 0) {
          hideGUI();
        } else {
          void sidebar.webviewProtocol?.request(
            "focusContinueInputWithNewSession",
            undefined,
            false,
          );
        }
      } else {
        focusGUI();
        sidebar.webviewProtocol?.request(
          "focusContinueInputWithNewSession",
          undefined,
          false,
        );
        void addHighlightedCodeToContext(sidebar.webviewProtocol);
      }
    },
    "continue.focusContinueInputWithoutClear": async () => {
      const isContinueInputFocused = await sidebar.webviewProtocol.request(
        "isContinueInputFocused",
        undefined,
        false,
      );

      // This is a temporary fix—sidebar.webviewProtocol.request is blocking
      // when the GUI hasn't yet been setup and we should instead be
      // immediately throwing an error, or returning a Result object
      focusGUI();
      if (!sidebar.isReady) {
        const isReady = await waitForSidebarReady(sidebar, 5000, 100);
        if (!isReady) {
          return;
        }
      }

      if (isContinueInputFocused) {
        hideGUI();
      } else {
        focusGUI();

        sidebar.webviewProtocol?.request(
          "focusContinueInputWithoutClear",
          undefined,
        );

        void addHighlightedCodeToContext(sidebar.webviewProtocol);
      }
    },
    // QuickEditShowParams are passed from CodeLens, temp fix
    // until we update to new params specific to Edit
    "continue.focusEdit": async (args?: QuickEditShowParams) => {
      focusGUI();
      sidebar.webviewProtocol?.request("focusEdit", undefined);
    },
    "continue.exitEditMode": async () => {
      editDecorationManager.clear();
      void sidebar.webviewProtocol?.request("exitEditMode", undefined);
    },
    "continue.writeCommentsForCode": async () => {
      streamInlineEdit(
        "comment",
        "Write comments for this code. Do not change anything about the code itself.",
      );
    },
    "continue.writeDocstringForCode": async () => {
      void streamInlineEdit(
        "docstring",
        "Write a docstring for this code. Do not change anything about the code itself.",
      );
    },
    "continue.fixCode": async () => {
      streamInlineEdit(
        "fix",
        "Fix this code. If it is already 100% correct, simply rewrite the code.",
      );
    },
    "continue.optimizeCode": async () => {
      streamInlineEdit("optimize", "Optimize this code");
    },
    "continue.fixGrammar": async () => {
      streamInlineEdit(
        "fixGrammar",
        "If there are any grammar or spelling mistakes in this writing, fix them. Do not make other large changes to the writing.",
      );
    },
    "continue.clearConsole": async () => {
      consoleView.clearLog();
    },
    "continue.viewLogs": async () => {
      vscode.commands.executeCommand("workbench.action.toggleDevTools");
    },
    "continue.debugTerminal": async () => {
      const terminalContents = await ide.getTerminalContents();

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      sidebar.webviewProtocol?.request("userInput", {
        input: `I got the following error, can you please help explain how to fix it?\n\n${terminalContents.trim()}`,
      });
    },
    "continue.hideInlineTip": () => {
      vscode.workspace
        .getConfiguration(EXTENSION_NAME)
        .update("showInlineTip", false, vscode.ConfigurationTarget.Global);
    },

    // Commands without keyboard shortcuts
    "continue.addModel": () => {
      vscode.commands.executeCommand("continue.continueGUIView.focus");
      sidebar.webviewProtocol?.request("addModel", undefined);
    },
    "continue.newSession": () => {
      // getSidebarContent re-points the shared protocol (webview + inbound
      // listener) at the most recently created full-screen panel, so a "+"
      // click on the SIDEBAR would otherwise deliver newSession into the
      // full-screen config tab and the new chat would appear there. Re-target
      // the sidebar before sending.
      if (sidebar.webview) {
        sidebar.resetWebviewProtocolWebview();
      }
      sidebar.webviewProtocol?.request("newSession", undefined);
    },

    "continue.newSessionFullScreen": () => {
      // "+" button on the FULL-SCREEN panel's own title bar: route the new
      // session into the full-screen webview instead of the sidebar.
      if (fullScreenPanel) {
        sidebar.webviewProtocol.webview = fullScreenPanel.webview;
        sidebar.webviewProtocol?.request("newSession", undefined);
      } else {
        vscode.commands.executeCommand("continue.newSession");
      }
    },

    "continue.toggleChat": () => {
      toggleGUI();
    },

    "continue.shareSession": async (sessionId: string | undefined) => {
      if (!sessionId) {
        sessionId = await sidebar.webviewProtocol?.request(
          "getCurrentSessionId",
          undefined,
        );
      }
      if (!sessionId) {
        void vscode.window.showErrorMessage(
          "No session ID found. Please start a new session first.",
        );
        return;
      }
      //let user select the destination folder
      const destinationFolder = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        canSelectMany: false,
        openLabel: "Select Destination Folder",
      });
      if (!destinationFolder || destinationFolder.length === 0) {
        return;
      }

      try {
        // despite core.invoke not being async, we still need to await it, because the 'history/share' command is async
        // if not awaited, then errors will not be caught.
        await core.invoke("history/share", {
          id: sessionId,
          outputDir: destinationFolder[0].fsPath,
        });
      } catch (error) {
        const errorMessage = `Failed to save session: ${error instanceof Error ? error.message : String(error)}`;
        void vscode.window.showErrorMessage(errorMessage);
      }
    },
    "continue.viewHistory": () => {
      vscode.commands.executeCommand("continue.navigateTo", "/history", true);
    },
    "continue.focusContinueSessionId": async (
      sessionId: string | undefined,
    ) => {
      if (!sessionId) {
        sessionId = await vscode.window.showInputBox({
          prompt: "Enter the Session ID",
        });
      }
      void sidebar.webviewProtocol?.request("focusContinueSessionId", {
        sessionId,
      });
    },
    "continue.applyCodeFromChat": () => {
      void sidebar.webviewProtocol.request("applyCodeFromChat", undefined);
    },
    "continue.openConfigPage": () => {
      vscode.commands.executeCommand("continue.navigateTo", "/config", false);
    },
    "continue.selectFilesAsContext": async (
      firstUri: vscode.Uri,
      uris: vscode.Uri[],
    ) => {
      if (uris === undefined) {
        throw new Error("No files were selected");
      }

      vscode.commands.executeCommand("continue.continueGUIView.focus");

      for (const uri of uris) {
        // If it's a folder, add the entire folder contents recursively by using walkDir (to ignore ignored files)
        const isDirectory = await vscode.workspace.fs
          .stat(uri)
          ?.then((stat) => stat.type === vscode.FileType.Directory);
        if (isDirectory) {
          for await (const fileUri of walkDirAsync(uri.toString(), ide, {
            source: "vscode continue.selectFilesAsContext command",
          })) {
            await addEntireFileToContext(
              vscode.Uri.parse(fileUri),
              sidebar.webviewProtocol,
              ide.ideUtils,
            );
          }
        } else {
          await addEntireFileToContext(
            uri,
            sidebar.webviewProtocol,
            ide.ideUtils,
          );
        }
      }
    },
    "continue.logAutocompleteOutcome": (
      completionId: string,
      completionProvider: CompletionProvider,
    ) => {
      completionProvider.accept(completionId);
    },
    "continue.logNextEditOutcomeAccept": (
      completionId: string,
      nextEditLoggingService: NextEditLoggingService,
    ) => {
      nextEditLoggingService.accept(completionId);
    },
    "continue.logNextEditOutcomeReject": (
      completionId: string,
      nextEditLoggingService: NextEditLoggingService,
    ) => {
      nextEditLoggingService.reject(completionId);
    },
    "continue.toggleTabAutocompleteEnabled": () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const enabled = config.get("enableTabAutocomplete");
      const pauseOnBattery = config.get<boolean>(
        "pauseTabAutocompleteOnBattery",
      );
      if (!pauseOnBattery || battery.isACConnected()) {
        config.update(
          "enableTabAutocomplete",
          !enabled,
          vscode.ConfigurationTarget.Global,
        );
      } else {
        if (enabled) {
          const paused = getStatusBarStatus() === StatusBarStatus.Paused;
          if (paused) {
            setupStatusBar(StatusBarStatus.Enabled);
          } else {
            config.update(
              "enableTabAutocomplete",
              false,
              vscode.ConfigurationTarget.Global,
            );
          }
        } else {
          setupStatusBar(StatusBarStatus.Paused);
          config.update(
            "enableTabAutocomplete",
            true,
            vscode.ConfigurationTarget.Global,
          );
        }
      }
    },
    "continue.forceAutocomplete": async () => {
      // 1. Explicitly hide any existing suggestion. This clears VS Code's cache for the current position.
      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      // 2. Now trigger a new one. VS Code has no cached suggestion, so it's forced to call our provider.
      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.trigger",
      );
    },

    "continue.openTabAutocompleteConfigMenu": async () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const quickPick = vscode.window.createQuickPick();

      const { config: continueConfig } = await configHandler.loadConfig();
      const autocompleteModels =
        continueConfig?.modelsByRole.autocomplete ?? [];
      const selected =
        continueConfig?.selectedModelByRole?.autocomplete?.title ?? undefined;

      // Toggle between Disabled, Paused, and Enabled
      const pauseOnBattery =
        config.get<boolean>("pauseTabAutocompleteOnBattery") &&
        !battery.isACConnected();
      const currentStatus = getStatusBarStatus();

      let targetStatus: StatusBarStatus | undefined;
      if (pauseOnBattery) {
        // Cycle from Disabled -> Paused -> Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Paused
            ? StatusBarStatus.Enabled
            : currentStatus === StatusBarStatus.Disabled
              ? StatusBarStatus.Paused
              : StatusBarStatus.Disabled;
      } else {
        // Toggle between Disabled and Enabled
        targetStatus =
          currentStatus === StatusBarStatus.Disabled
            ? StatusBarStatus.Enabled
            : StatusBarStatus.Disabled;
      }

      const nextEditEnabled = config.get<boolean>("enableNextEdit") ?? false;

      quickPick.items = [
        {
          label: "$(gear) Open settings",
        },
        {
          label: "$(comment) Open chat",
          description: getMetaKeyLabel() + " + L",
        },
        {
          label: "$(screen-full) Open full screen chat",
          description:
            getMetaKeyLabel() + " + K, " + getMetaKeyLabel() + " + M",
        },
        {
          label: quickPickStatusText(targetStatus),
          description:
            getMetaKeyLabel() + " + K, " + getMetaKeyLabel() + " + A",
        },
        ...getNextEditMenuItems(currentStatus, nextEditEnabled),
        {
          kind: vscode.QuickPickItemKind.Separator,
          label: "Switch model",
        },
        ...autocompleteModels.map((model) => ({
          label: getAutocompleteStatusBarTitle(selected, model),
          description: getAutocompleteStatusBarDescription(selected, model),
        })),
      ];
      quickPick.onDidAccept(() => {
        const selectedOption = quickPick.selectedItems[0].label;
        const targetStatus =
          getStatusBarStatusFromQuickPickItemLabel(selectedOption);

        if (targetStatus !== undefined) {
          setupStatusBar(targetStatus);
          config.update(
            "enableTabAutocomplete",
            targetStatus === StatusBarStatus.Enabled,
            vscode.ConfigurationTarget.Global,
          );
        } else if (isNextEditToggleLabel(selectedOption)) {
          handleNextEditToggle(selectedOption, config);
        } else if (
          autocompleteModels.some((model) => model.title === selectedOption)
        ) {
          if (core.configHandler.currentProfile?.profileDescription.id) {
            core.invoke("config/updateSelectedModel", {
              profileId:
                core.configHandler.currentProfile?.profileDescription.id,
              role: "autocomplete",
              title: selectedOption,
            });
          }
        } else if (selectedOption === "$(comment) Open chat") {
          vscode.commands.executeCommand("continue.focusContinueInput");
        } else if (selectedOption === "$(screen-full) Open full screen chat") {
          vscode.commands.executeCommand("continue.openInNewWindow");
        } else if (selectedOption === "$(gear) Open settings") {
          vscode.commands.executeCommand("continue.navigateTo", "/config");
        }

        quickPick.dispose();
      });
      quickPick.show();
    },
    "continue.navigateTo": (path: string, toggle: boolean) => {
      sidebar.webviewProtocol?.request("navigateTo", { path, toggle });
      focusGUI();
    },
    "continue.startLocalOllama": () => {
      startLocalOllama(ide);
    },
    "continue.startLocalLemonade": () => {
      startLocalLemonade(ide);
    },
    "continue.installModel": async (
      modelName: string,
      llmProvider: ILLM | undefined,
    ) => {
      try {
        if (!isModelInstaller(llmProvider)) {
          const msg = llmProvider
            ? `LLM provider '${llmProvider.providerName}' does not support installing models`
            : "Missing LLM Provider";
          throw new Error(msg);
        }
        await installModelWithProgress(modelName, llmProvider);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        vscode.window.showErrorMessage(
          `Failed to install '${modelName}': ${message}`,
        );
      }
    },
    "continue.convertConfigJsonToConfigYaml": async () => {
      const configJson = fs.readFileSync(getConfigJsonPath(), "utf-8");
      const parsed = JSON.parse(configJson);
      const configYaml = convertJsonToYamlConfig(parsed);

      const configYamlPath = getConfigYamlPath();
      fs.writeFileSync(configYamlPath, YAML.stringify(configYaml));
      setConfigFilePermissions(configYamlPath);

      // Open config.yaml
      await openEditorAndRevealRange(
        vscode.Uri.file(configYamlPath),
        undefined,
        undefined,
        false,
      );

      void vscode.window
        .showInformationMessage(
          "Your config.json has been converted to the new config.yaml format. If you need to switch back to config.json, you can delete or rename config.yaml.",
          "Read the docs",
        )
        .then(async (selection) => {
          if (selection === "Read the docs") {
            await vscode.env.openExternal(
              vscode.Uri.parse("https://docs.continue.dev/yaml-migration"),
            );
          }
        });
    },
    "continue.enterEnterpriseLicenseKey": async () => {
      const licenseKey = await vscode.window.showInputBox({
        prompt: "Enter your enterprise license key",
        password: true,
        ignoreFocusOut: true,
        placeHolder: "License key",
      });

      if (!licenseKey) {
        return;
      }

      try {
        const isValid = core.invoke("mdm/setLicenseKey", {
          licenseKey,
        });

        if (isValid) {
          void vscode.window.showInformationMessage(
            "Enterprise license key successfully validated and saved. Reloading window.",
          );
          await new Promise((resolve) => setTimeout(resolve, 1000));
          await vscode.commands.executeCommand("workbench.action.reloadWindow");
        } else {
          void vscode.window.showErrorMessage(
            "Invalid license key. Please check your license key and try again.",
          );
        }
      } catch (error) {
        void vscode.window.showErrorMessage(
          `Failed to set enterprise license key: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
    "continue.toggleNextEditEnabled": async () => {
      const config = vscode.workspace.getConfiguration(EXTENSION_NAME);
      const tabAutocompleteEnabled = config.get<boolean>(
        "enableTabAutocomplete",
      );

      if (!tabAutocompleteEnabled) {
        vscode.window.showInformationMessage(
          "Please enable tab autocomplete first to use Next Edit",
        );
        return;
      }

      const nextEditEnabled = config.get<boolean>("enableNextEdit") ?? false;

      // updateNextEditState in VsCodeExtension.ts will handle the validation.
      config.update(
        "enableNextEdit",
        !nextEditEnabled,
        vscode.ConfigurationTarget.Global,
      );
    },
    "continue.openInNewWindow": async () => {
      openFullScreenGUI(undefined);
    },
    "continue.forceNextEdit": async () => {
      // This is basically the same logic as forceAutocomplete.
      // I'm writing a new command KV pair here in case we diverge in features.

      await vscode.commands.executeCommand("editor.action.inlineSuggest.hide");

      await vscode.commands.executeCommand(
        "editor.action.inlineSuggest.trigger",
      );
    },

    "continue.deepAgentTest": async () => {
      const { config } = await configHandler.loadConfig();
      if (!config) {
        vscode.window.showErrorMessage("Continue: config not loaded");
        return;
      }
      const llm =
        config.selectedModelByRole?.chat ?? config.modelsByRole?.chat?.[0];
      if (!llm) {
        vscode.window.showErrorMessage("Continue: no chat model selected");
        return;
      }
      const adapter = new ContinueLLMAdapter({ llm });

      const agent = createDeepAgent({
        model: adapter,
        systemPrompt:
          "You are a helpful coding assistant. Use the filesystem tools when needed.",
        backend: () => createWorkspaceBackend(deepAgentRoot),
      });
      const out = vscode.window.createOutputChannel("DeepAgent");
      out.show();
      out.appendLine("Running deep agent...");
      out.appendLine("workspace=" + describeRoots(deepAgentRoot));
      try {
        const result = await agent.invoke({
          messages: [
            new HumanMessage(
              "Use the filesystem tools to list the files at the workspace root " +
                "and read the README (or readme) file if it exists. Then tell me, " +
                "in 3 short bullet points, what this project is about. Be concise.",
            ),
          ],
        });
        out.appendLine(JSON.stringify(result, null, 2));
      } catch (e) {
        out.appendLine("ERROR: " + (e as Error).stack);
      }
    },

    "continue.deepAgentChat": async () => {
      const { config } = await configHandler.loadConfig();
      if (!config) {
        vscode.window.showErrorMessage("Continue: config not loaded");
        return;
      }
      const llm =
        config.selectedModelByRole?.chat ?? config.modelsByRole?.chat?.[0];
      if (!llm) {
        vscode.window.showErrorMessage("Continue: no chat model selected");
        return;
      }
      // No picker: file tools follow the VS Code workspace folders (including
      // any added with "Add Folder to Workspace…").
      DeepAgentChatPanel.createOrShow(llm, deepAgentRoot);
    },

    "continue.toggleDeepAgent": async () => {
      deepAgentEnabled = !deepAgentEnabled;
      if (!deepAgentEnabled) deepAgentLastTurnAt = undefined;
      await setDeepAgentSetting("deepAgentMode", deepAgentEnabled);
      // Reload so the onConfigUpdate listener re-wraps (or restores) the model.
      await configHandler.reloadConfig("DeepAgent mode toggled");
      updateDeepAgentStatusBar();
      vscode.window.showInformationMessage(
        `DeepAgent engine mode: ${deepAgentEnabled ? "ON" : "OFF"} (workspace: ${describeRoots(deepAgentRoot)})`,
      );
    },

    "continue.setDeepAgentRoot": async () => {
      const picked = await pickRootOverride(deepAgentRoot);
      if (!picked) return;
      deepAgentRoot = picked.override;
      await setDeepAgentSetting("deepAgentRoot", deepAgentRoot ?? "");
      await configHandler.reloadConfig("DeepAgent root changed");
      updateDeepAgentStatusBar();
      vscode.window.showInformationMessage(
        `DeepAgent file tools: ${describeRoots(deepAgentRoot)}`,
      );
    },

    "continue.deepAgent.openPermissionsPanel": async () => {
      const { openPermissionsPanel } = await import(
        "./deepagents/permissionsPanel"
      );
      openPermissionsPanel();
    },
  };
};

async function installModelWithProgress(
  modelName: string,
  modelInstaller: ModelInstaller,
) {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Installing model '${modelName}'`,
      cancellable: true,
    },
    async (windowProgress, token) => {
      let currentProgress: number = 0;
      const progressWrapper = (
        details: string,
        worked?: number,
        total?: number,
      ) => {
        let increment = 0;
        if (worked && total) {
          const progressValue = Math.round((worked / total) * 100);
          increment = progressValue - currentProgress;
          currentProgress = progressValue;
        }
        windowProgress.report({ message: details, increment });
      };
      const abortController = new AbortController();
      token.onCancellationRequested(() => {
        console.log(`Pulling ${modelName} model was cancelled`);
        abortController.abort();
      });
      await modelInstaller.installModel(
        modelName,
        abortController.signal,
        progressWrapper,
      );
    },
  );
}

export function registerAllCommands(
  context: vscode.ExtensionContext,
  ide: VsCodeIde,
  extensionContext: vscode.ExtensionContext,
  sidebar: ContinueGUIWebviewViewProvider,
  consoleView: ContinueConsoleWebviewViewProvider,
  configHandler: ConfigHandler,
  verticalDiffManager: VerticalDiffManager,
  battery: Battery,
  quickEdit: QuickEdit,
  core: Core,
  editDecorationManager: EditDecorationManager,
) {
  for (const [command, callback] of Object.entries(
    getCommandsMap(
      ide,
      extensionContext,
      sidebar,
      consoleView,
      configHandler,
      verticalDiffManager,
      battery,
      quickEdit,
      core,
      editDecorationManager,
    ),
  )) {
    context.subscriptions.push(
      vscode.commands.registerCommand(command, callback),
    );
  }
}
