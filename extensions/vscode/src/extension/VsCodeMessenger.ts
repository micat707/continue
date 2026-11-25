import { ConfigHandler } from "core/config/ConfigHandler";
import { DataLogger } from "core/data/log";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import {
  FromCoreProtocol,
  FromWebviewProtocol,
  ToCoreProtocol,
} from "core/protocol";
import { ToWebviewFromCoreProtocol } from "core/protocol/coreWebview";
import { ToIdeFromWebviewOrCoreProtocol } from "core/protocol/ide";
import { ToIdeFromCoreProtocol } from "core/protocol/ideCore";
import { InProcessMessenger, Message } from "core/protocol/messenger";
import {
  CORE_TO_WEBVIEW_PASS_THROUGH,
  WEBVIEW_TO_CORE_PASS_THROUGH,
} from "core/protocol/passThrough";
import { stripImages } from "core/util/messageContent";
import * as vscode from "vscode";

import { ApplyManager } from "../apply";
import { VerticalDiffManager } from "../diff/vertical/manager";
import { addCurrentSelectionToEdit } from "../quickEdit/AddCurrentSelection";
import EditDecorationManager from "../quickEdit/EditDecorationManager";
import { handleLLMError } from "../util/errorHandling";
import { buildMicatFileTree } from "../util/micatFileTree";
import { showTutorial } from "../util/tutorial";
import { getExtensionUri } from "../util/vscode";
import { VsCodeIde } from "../VsCodeIde";
import { VsCodeWebviewProtocol } from "../webviewProtocol";
import { resolveHitlDecision, setHitlProtocol } from "../deepagents/hitlBridge";
import {
  resolveUserInput,
  setUserInputProtocol,
} from "../deepagents/userInputTool";
import { setExecuteProgressProtocol } from "../deepagents/executeProgressBridge";
import { listArtifacts, deleteArtifact } from "../deepagents/artifactStore";
import {
  getSessionChangedFiles,
  getSessionPermissionHandle,
} from "../deepagents/DeepAgentLLM";
import {
  currentDateTimeHint,
  detectShellAsync,
  getCachedSessionFileTree,
  getWorkspaceLayout,
  openFileAncestorDirs,
  setSessionFileTreeCache,
  platformCommandGuidelines,
  prewarmShellDetection,
  showAgentTerminal,
  systemInformationHint,
} from "../deepagents/workspaceBackend";
import { openFullScreenGUIImpl } from "../commands";
import {
  buildPermissionsState,
  updatePermissionsLayer,
} from "../deepagents/permissionsPanel";

import { VsCodeExtension } from "./VsCodeExtension";

/**
 * Map a DeepAgent virtual path (`/Folder/a.txt`, as shown on the outcome cards)
 * to its real disk path so diff views can open the actual file. Mirrors
 * DeepAgentChatPanel's resolveRealPath, but without a root override.
 */
function resolveAgentRealPath(virtualPath: string): string | undefined {
  const raw = (virtualPath ?? "").trim().replace(/\\/g, "/");
  if (!raw.startsWith("/")) return undefined;
  try {
    const { mounts, singleRoot } = getWorkspaceLayout();
    const parts = raw.split("/").filter(Boolean);
    let mount = mounts[0];
    let rest = parts;
    if (!singleRoot) {
      const found = mounts.find((m) => m.name === parts[0]);
      if (!found) return undefined;
      mount = found;
      rest = parts.slice(1);
    }
    if (!mount) return undefined;
    return vscode.Uri.joinPath(vscode.Uri.file(mount.realPath), ...rest).fsPath;
  } catch {
    return undefined;
  }
}

type ToIdeOrWebviewFromCoreProtocol = ToIdeFromCoreProtocol &
  ToWebviewFromCoreProtocol;

/**
 * A shared messenger class between Core and Webview
 * so we don't have to rewrite some of the handlers
 */
export class VsCodeMessenger {
  onWebview<T extends keyof FromWebviewProtocol>(
    messageType: T,
    handler: (
      message: Message<FromWebviewProtocol[T][0]>,
    ) => Promise<FromWebviewProtocol[T][1]> | FromWebviewProtocol[T][1],
  ): void {
    void this.webviewProtocol.on(messageType, handler);
  }

  onCore<T extends keyof ToIdeOrWebviewFromCoreProtocol>(
    messageType: T,
    handler: (
      message: Message<ToIdeOrWebviewFromCoreProtocol[T][0]>,
    ) =>
      | Promise<ToIdeOrWebviewFromCoreProtocol[T][1]>
      | ToIdeOrWebviewFromCoreProtocol[T][1],
  ): void {
    this.inProcessMessenger.externalOn(messageType, handler);
  }

  onWebviewOrCore<T extends keyof ToIdeFromWebviewOrCoreProtocol>(
    messageType: T,
    handler: (
      message: Message<ToIdeFromWebviewOrCoreProtocol[T][0]>,
    ) =>
      | Promise<ToIdeFromWebviewOrCoreProtocol[T][1]>
      | ToIdeFromWebviewOrCoreProtocol[T][1],
  ): void {
    this.onWebview(messageType, handler);
    this.onCore(messageType, handler);
  }

  constructor(
    private readonly inProcessMessenger: InProcessMessenger<
      ToCoreProtocol,
      FromCoreProtocol
    >,
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly ide: VsCodeIde,
    private readonly verticalDiffManagerPromise: Promise<VerticalDiffManager>,
    private readonly configHandlerPromise: Promise<ConfigHandler>,
    private readonly editDecorationManager: EditDecorationManager,
    private readonly context: vscode.ExtensionContext,
    private readonly vsCodeExtension: VsCodeExtension,
  ) {
    // Wire the webview protocol into the HITL bridge so DeepAgentLLM can ask the
    // GUI to render approval cards without importing the protocol directly.
    setHitlProtocol(webviewProtocol);

    // Wire the protocol into the user_input bridge so the `user_input` tool can
    // render its inline question card and wait for the user's answer.
    setUserInputProtocol(webviewProtocol);

    // Wire the same protocol into the execute-progress bridge so the DeepAgent
    // `execute` backend can stream live command output to the GUI's card.
    setExecuteProgressProtocol(webviewProtocol);

    // Warm the shell detection cache in the background so the first chat
    // request's environment blocks don't wait for a powershell.exe spawn.
    prewarmShellDetection();

    // Build marker: makes it obvious in the Extension Host console whether the
    // running bundle includes the micat environment-context handlers.
    console.log(
      "[MicatCode] VsCodeMessenger active (micat env handlers registered)",
    );

    // DeepAgent human-in-the-loop: the GUI's ReviewChangesCard replies here with
    // the user's approve/reject decisions, which unblock the paused agent run.
    this.onWebview(
      "deepAgentInterruptResponse",
      async ({ data: { requestId, decisions, sessionId } }) => {
        resolveHitlDecision(requestId, decisions, sessionId);
      },
    );

    // Kiro-style `user_input`: the inline question card replies here with the
    // selected option / free-form answer, unblocking the paused tool call.
    this.onWebview(
      "userInputResponse",
      async ({
        data: { requestId, answer, subOptions, skipped, sessionId },
      }) => {
        resolveUserInput(
          requestId,
          { answer: answer ?? "", subOptions, skipped },
          sessionId,
        );
      },
    );

    // DeepAgent tool-permission settings: the GUI settings section (权限 tab)
    // reads the three-layer state, persists a layer, or clears session memory.
    // Each handler returns the refreshed state so the UI re-renders in one trip.
    this.onWebview("deepAgent/permissions/getState", async ({ data }) => {
      return buildPermissionsState((data as any)?.sessionId);
    });
    this.onWebview(
      "deepAgent/permissions/updateLayer",
      async ({ data: { layer, config } }) => {
        return updatePermissionsLayer(layer, config);
      },
    );
    this.onWebview("deepAgent/permissions/clearSession", async ({ data }) => {
      const sessionId = (data as any)?.sessionId;
      getSessionPermissionHandle(sessionId)?.clear();
      return buildPermissionsState(sessionId);
    });

    // The sidebar webview is too narrow for the config pages — when the user
    // opens any config route there, bounce it to a full editor-area tab that
    // boots directly on the requested route (via window.initialRoute).
    this.onWebview("deepAgent/openFullScreenConfig", async ({ data }) => {
      await openFullScreenGUIImpl?.(data.page);
    });

    /** WEBVIEW ONLY LISTENERS **/
    this.onWebview("showFile", (msg) => {
      this.ide.openFile(msg.data.filepath);
    });

    this.onWebview("vscode/openMoveRightMarkdown", (msg) => {
      vscode.commands.executeCommand(
        "markdown.showPreview",
        vscode.Uri.joinPath(
          getExtensionUri(),
          "media",
          "move-chat-panel-right.md",
        ),
      );
    });

    this.onWebview("toggleDevTools", (msg) => {
      vscode.commands.executeCommand("continue.viewLogs");
    });

    this.onWebview("reloadWindow", (msg) => {
      vscode.commands.executeCommand("workbench.action.reloadWindow");
    });
    this.onWebview("focusEditor", (msg) => {
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
    });
    this.onWebview("toggleFullScreen", (msg) => {
      vscode.commands.executeCommand("continue.openInNewWindow");
    });

    this.onWebview(
      "acceptDiff",
      async ({ data: { filepath, streamId, toolCallId } }) => {
        await vscode.commands.executeCommand(
          "continue.acceptDiff",
          filepath,
          streamId,
          toolCallId,
        );
      },
    );

    this.onWebview(
      "rejectDiff",
      async ({ data: { filepath, streamId, toolCallId } }) => {
        await vscode.commands.executeCommand(
          "continue.rejectDiff",
          filepath,
          streamId,
          toolCallId,
        );
      },
    );

    /**
     * Open the VS Code multi-file "Changes" editor (vscode.changes) so the user
     * can review every pending file edit at once — Kiro's "View changes" action.
     * Each file becomes a [resource, original, modified] triple; original/new
     * contents (from the apply state) are served through Continue's readonly
     * virtual-document scheme, so the diff is correct even before anything is
     * written to disk.
     */
    this.onWebview("showChanges", async ({ data: { title, files } }) => {
      const resources = files.map((f) => {
        const resourceUri = vscode.Uri.file(f.filepath);
        const originalUri = vscode.Uri.parse(
          `${VsCodeExtension.continueVirtualDocumentScheme}:${encodeURIComponent(
            f.filepath,
          )}?${encodeURIComponent(f.originalContent ?? "")}`,
        );
        const modifiedUri = vscode.Uri.parse(
          `${VsCodeExtension.continueVirtualDocumentScheme}:${encodeURIComponent(
            f.filepath,
          )}?${encodeURIComponent(f.newContent ?? "")}`,
        );
        return [resourceUri, originalUri, modifiedUri] as [
          vscode.Uri,
          vscode.Uri,
          vscode.Uri,
        ];
      });
      await vscode.commands.executeCommand("vscode.changes", title, resources);
    });

    /**
     * Single-file side-by-side diff for an `edit_file` outcome card. The card's
     * diff covers only the CHANGE WINDOW (context + removed + added lines), so
     * showing those fragments verbatim yields a tiny "partial file" diff. When
     * the real file can be resolved on disk we expand the window into a FULL
     * "before" snapshot (splice the window's original lines back into the
     * current file where its modified lines occur) and diff it against the REAL
     * file — proper language mode, line numbers and scrolling. Otherwise fall
     * back to the fragment pair as readonly virtual documents.
     */
    this.onWebview("showEditDiff", async ({ data }) => {
      const { title, filepath, originalContent, newContent } = data;
      const scheme = VsCodeExtension.continueVirtualDocumentScheme;
      const virtualUri = (side: string, content: string) =>
        vscode.Uri.parse(
          `${scheme}:${encodeURIComponent(`${filepath}/${side}`)}?${encodeURIComponent(content)}`,
        );

      let beforeContent = originalContent;
      let rightUri: vscode.Uri | undefined;
      try {
        const real = resolveAgentRealPath(filepath);
        if (real) {
          const doc = await vscode.workspace.openTextDocument(
            vscode.Uri.file(real),
          );
          const norm = (s: string) => s.replace(/\r\n/g, "\n");
          const text = norm(doc.getText());
          const at = text.indexOf(norm(newContent));
          if (at >= 0) {
            beforeContent =
              text.slice(0, at) +
              norm(originalContent) +
              text.slice(at + newContent.length);
          }
          rightUri = doc.uri;
        }
      } catch {
        // File may have been deleted — fall back to the fragment pair.
      }

      await vscode.commands.executeCommand(
        "vscode.diff",
        virtualUri("before", beforeContent),
        rightUri ?? virtualUri("after", newContent),
        title,
        { preview: true },
      );
    });

    this.onWebview("getChangedFiles", async () => ide.getChangedFiles());

    // Files the current DeepAgent session wrote/edited via write_file/edit_file
    // (build artifacts from `execute` are excluded). The GUI renders these as a
    // categorized "session changes" summary after the agent finishes.
    this.onWebview("getSessionChangedFiles", async ({ data }) =>
      getSessionChangedFiles((data as any)?.sessionId),
    );

    this.onWebview("applyToFile", async ({ data }) => {
      const [verticalDiffManager, configHandler] = await Promise.all([
        verticalDiffManagerPromise,
        configHandlerPromise,
      ]);

      const applyManager = new ApplyManager(
        this.ide,
        webviewProtocol,
        verticalDiffManager,
        configHandler,
      );

      await applyManager.applyToFile(data);
    });

    this.onWebview("showTutorial", async (msg) => {
      await showTutorial(this.ide);
    });

    this.onWebview(
      "overwriteFile",
      async ({ data: { prevFileContent, filepath } }) => {
        if (prevFileContent === null) {
          // TODO: Delete the file
          return;
        }

        await this.ide.openFile(filepath);

        // Get active text editor
        const editor = vscode.window.activeTextEditor;

        if (!editor) {
          vscode.window.showErrorMessage("No active editor to apply edits to");
          return;
        }

        editor.edit((builder) =>
          builder.replace(
            new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length),
            ),
            prevFileContent,
          ),
        );
      },
    );

    this.onWebview("insertAtCursor", async (msg) => {
      const editor = vscode.window.activeTextEditor;
      if (editor === undefined || !editor.selection) {
        return;
      }

      editor.edit((editBuilder) => {
        editBuilder.replace(
          new vscode.Range(editor.selection.start, editor.selection.end),
          msg.data.text,
        );
      });
    });
    this.onWebview("edit/addCurrentSelection", async (msg) => {
      const verticalDiffManager = await this.verticalDiffManagerPromise;
      await addCurrentSelectionToEdit({
        args: undefined,
        editDecorationManager,
        webviewProtocol: this.webviewProtocol,
        verticalDiffManager,
      });
    });
    this.onWebview("edit/sendPrompt", async (msg) => {
      const prompt = msg.data.prompt;
      const { start, end } = msg.data.range.range;
      const verticalDiffManager = await verticalDiffManagerPromise;

      const configHandler = await configHandlerPromise;
      const { config } = await configHandler.loadConfig();

      if (!config) {
        throw new Error("Edit: Failed to load config");
      }

      const model =
        config?.selectedModelByRole.edit ?? config?.selectedModelByRole.chat;

      if (!model) {
        throw new Error("No Edit or Chat model selected");
      }

      const fileAfterEdit = await verticalDiffManager.streamEdit({
        input: stripImages(prompt),
        llm: model,
        streamId: EDIT_MODE_STREAM_ID,
        range: new vscode.Range(
          new vscode.Position(start.line, start.character),
          new vscode.Position(end.line, end.character),
        ),
        rulesToInclude: config.rules,
        isApply: false,
      });

      // Log dev data
      await DataLogger.getInstance().logDevData({
        name: "editInteraction",
        data: {
          prompt: stripImages(prompt),
          completion: fileAfterEdit ?? "",
          modelProvider: model.underlyingProviderName,
          modelName: model.title ?? "",
          modelTitle: model.title ?? "",
          filepath: msg.data.range.filepath,
        },
      });

      return fileAfterEdit;
    });

    this.onWebview("edit/clearDecorations", async (msg) => {
      editDecorationManager.clear();
    });

    this.onWebview("session/share", async (msg) => {
      await vscode.commands.executeCommand(
        "continue.shareSession",
        msg.data.sessionId,
      );
    });

    /** PASS THROUGH FROM WEBVIEW TO CORE AND BACK **/
    WEBVIEW_TO_CORE_PASS_THROUGH.forEach((messageType) => {
      this.onWebview(messageType, async (msg) => {
        return await this.inProcessMessenger.externalRequest(
          messageType,
          msg.data,
          msg.messageId,
        );
      });
    });

    /** PASS THROUGH FROM CORE TO WEBVIEW AND BACK **/
    CORE_TO_WEBVIEW_PASS_THROUGH.forEach((messageType) => {
      this.onCore(messageType, async (msg) => {
        return this.webviewProtocol.request(messageType, msg.data);
      });
    });

    /** CORE ONLY LISTENERS **/
    // None right now

    /** BOTH CORE AND WEBVIEW **/
    this.onWebviewOrCore("readRangeInFile", async (msg) => {
      return await vscode.workspace
        .openTextDocument(msg.data.filepath)
        .then((document) => {
          const start = new vscode.Position(0, 0);
          const end = new vscode.Position(5, 0);
          const range = new vscode.Range(start, end);

          const contents = document.getText(range);
          return contents;
        });
    });

    this.onWebviewOrCore("getIdeSettings", async (msg) => {
      return ide.getIdeSettings();
    });
    this.onWebviewOrCore("getDiff", async (msg) => {
      return ide.getDiff(msg.data.includeUnstaged);
    });
    this.onWebviewOrCore("getTerminalContents", async (msg) => {
      return ide.getTerminalContents();
    });
    this.onWebviewOrCore("getDebugLocals", async (msg) => {
      return ide.getDebugLocals(Number(msg.data.threadIndex));
    });
    this.onWebviewOrCore("getAvailableThreads", async (msg) => {
      return ide.getAvailableThreads();
    });
    this.onWebviewOrCore("getTopLevelCallStackSources", async (msg) => {
      return ide.getTopLevelCallStackSources(
        msg.data.threadIndex,
        msg.data.stackDepth,
      );
    });
    this.onWebviewOrCore("getWorkspaceDirs", async (msg) => {
      return ide.getWorkspaceDirs();
    });
    this.onWebviewOrCore("writeFile", async (msg) => {
      return ide.writeFile(msg.data.path, msg.data.contents);
    });
    this.onWebviewOrCore("createDirectory", async (msg) => {
      return ide.createDirectory(msg.data.path);
    });
    this.onWebviewOrCore("removeFile", async (msg) => {
      return ide.removeFile(msg.data.path);
    });
    this.onWebviewOrCore("showVirtualFile", async (msg) => {
      return ide.showVirtualFile(msg.data.name, msg.data.content);
    });
    this.onWebviewOrCore("openFile", async (msg) => {
      return ide.openFile(msg.data.path);
    });
    this.onWebviewOrCore("exportSession", async (msg) => {
      const { name, content } = msg.data;
      const workspaceDirs = await this.ide.getWorkspaceDirs();
      const defaultUri = workspaceDirs[0]
        ? vscode.Uri.joinPath(vscode.Uri.file(workspaceDirs[0]), name)
        : vscode.Uri.file(name);
      const target = await vscode.window.showSaveDialog({
        defaultUri,
        filters: { Markdown: ["md"] },
      });
      if (!target) {
        return undefined;
      }
      await vscode.workspace.fs.writeFile(target, Buffer.from(content, "utf8"));
      await vscode.window.showTextDocument(target, { preview: true });
      return target.fsPath;
    });
    this.onWebviewOrCore("runCommand", async (msg) => {
      await ide.runCommand(msg.data.command);
    });
    this.onWebviewOrCore("showAgentTerminal", async () => {
      showAgentTerminal();
    });
    this.onWebviewOrCore("getSearchResults", async (msg) => {
      return ide.getSearchResults(msg.data.query, msg.data.maxResults);
    });
    this.onWebviewOrCore("getFileResults", async (msg) => {
      return ide.getFileResults(msg.data.pattern, msg.data.maxResults);
    });
    this.onWebviewOrCore("subprocess", async (msg) => {
      return ide.subprocess(msg.data.command, msg.data.cwd);
    });
    this.onWebviewOrCore("getProblems", async (msg) => {
      return ide.getProblems(msg.data.filepath);
    });
    this.onWebviewOrCore("getBranch", async (msg) => {
      const { dir } = msg.data;
      return ide.getBranch(dir);
    });
    this.onWebviewOrCore("getOpenFiles", async (msg) => {
      return ide.getOpenFiles();
    });
    this.onWebviewOrCore("getCurrentFile", async () => {
      return ide.getCurrentFile();
    });
    this.onWebviewOrCore("getPinnedFiles", async (msg) => {
      return ide.getPinnedFiles();
    });
    this.onWebviewOrCore("showLines", async (msg) => {
      const { filepath, startLine, endLine } = msg.data;
      return ide.showLines(filepath, startLine, endLine);
    });
    this.onWebviewOrCore("showToast", (msg) => {
      this.ide.showToast(...msg.data);
    });
    this.onWebviewOrCore("saveFile", async (msg) => {
      return await ide.saveFile(msg.data.filepath);
    });
    this.onWebviewOrCore("readFile", async (msg) => {
      return await ide.readFile(msg.data.filepath);
    });
    this.onWebviewOrCore("openUrl", (msg) => {
      vscode.env.openExternal(vscode.Uri.parse(msg.data));
    });

    this.onWebviewOrCore("fileExists", async (msg) => {
      return await ide.fileExists(msg.data.filepath);
    });

    // Kiro-aligned disk artifact store: GUI requests the session's artifacts
    // (rebuild after webview reload) and dismisses individual artifacts.
    this.onWebviewOrCore("artifactList", async (msg) => {
      return await listArtifacts(msg.data.sessionId);
    });
    this.onWebviewOrCore("artifactDelete", async (msg) => {
      await deleteArtifact(msg.data.id, msg.data.sessionId);
    });

    this.onWebviewOrCore("micatGetPaths", async () => {
      console.log("[MicatCode] micatGetPaths handler reached");
      const os = await import("os");
      const platform = os.platform();
      const shell =
        platform === "win32"
          ? "powershell"
          : (process.env.SHELL?.split("/").pop() ?? "bash");
      const homeDirUri = vscode.Uri.file(os.homedir()).toString();
      const globalSteeringDirUri = vscode.Uri.file(
        os.homedir() + "/.micat/steering",
      ).toString();
      const dirs = await ide.getWorkspaceDirs();
      const workspaceRoot =
        dirs.length > 0 ? vscode.Uri.parse(dirs[0]).fsPath : undefined;
      // Shell-aware Kiro-style blocks shared with the DeepAgent flow
      // (detects PowerShell 5.1/7/cmd/posix and its command quirks).
      // Per-block try/catch: one failing block must not kill the response
      // (the GUI runs a hard timeout on this request).
      let systemInformationBlock = "";
      let platformCommandGuidelinesBlock = "";
      let currentDateTimeBlock = "";
      // Await the SHARED detection (prewarm may still be in flight) - never
      // start a second synchronous spawn on the request path.
      try {
        const detected = await detectShellAsync();
        systemInformationBlock = systemInformationHint(detected).join("\n");
        platformCommandGuidelinesBlock =
          platformCommandGuidelines(detected).join("\n");
      } catch (e) {
        console.warn("[MicatCode] shell detection failed:", e);
      }
      try {
        currentDateTimeBlock = currentDateTimeHint().join("\n");
      } catch (e) {
        console.warn("[MicatCode] currentDateTimeHint failed:", e);
      }
      return {
        platform,
        shell,
        homeDirUri,
        globalSteeringDirUri,
        workspaceRoot,
        systemInformationBlock,
        platformCommandGuidelinesBlock,
        currentDateTimeBlock,
      };
    });

    this.onWebviewOrCore("micatGetFileTree", async () => {
      console.log("[MicatCode] micatGetFileTree handler reached");
      const dirs = await ide.getWorkspaceDirs();
      if (!dirs.length) {
        return "";
      }
      // Reuse DeepAgent's session tree cache if already captured (avoids a
      // second full traversal when both paths are active).
      const rootPath = vscode.Uri.parse(dirs[0]).fsPath;
      const cached = getCachedSessionFileTree(rootPath);
      if (cached) {
        return cached;
      }
      const tree = await buildMicatFileTree(
        vscode.Uri.parse(dirs[0]),
        openFileAncestorDirs(rootPath),
      );
      setSessionFileTreeCache(rootPath, tree);
      return tree;
    });

    this.onWebviewOrCore("gotoDefinition", async (msg) => {
      return await ide.gotoDefinition(msg.data.location);
    });

    this.onWebviewOrCore("getReferences", async (msg) => {
      return await ide.getReferences(msg.data.location);
    });

    this.onWebviewOrCore("getDocumentSymbols", async (msg) => {
      return await ide.getDocumentSymbols(msg.data.textDocumentIdentifier);
    });

    this.onWebviewOrCore("getFileStats", async (msg) => {
      return await ide.getFileStats(msg.data.files);
    });

    this.onWebviewOrCore("getGitRootPath", async (msg) => {
      return await ide.getGitRootPath(msg.data.dir);
    });

    this.onWebviewOrCore("listDir", async (msg) => {
      return await ide.listDir(msg.data.dir);
    });

    this.onWebviewOrCore("getRepoName", async (msg) => {
      return await ide.getRepoName(msg.data.dir);
    });

    this.onWebviewOrCore("getTags", async (msg) => {
      return await ide.getTags(msg.data);
    });

    this.onWebviewOrCore("getIdeInfo", async (msg) => {
      return await ide.getIdeInfo();
    });

    this.onWebviewOrCore("isTelemetryEnabled", async (msg) => {
      return await ide.isTelemetryEnabled();
    });

    this.onWebviewOrCore("getUniqueId", async (msg) => {
      return await ide.getUniqueId();
    });

    this.onWebviewOrCore("reportError", async (msg) => {
      await handleLLMError(msg.data);
    });
  }
}
