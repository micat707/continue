import { ChatMessage, DiffLine, IDE, ILLM, RuleWithSource } from "core";
import { streamDiffLines } from "core/edit/streamDiffLines";
import { pruneLinesFromBottom, pruneLinesFromTop } from "core/llm/countTokens";
import { getMarkdownLanguageTagForFile } from "core/util";
import * as URI from "uri-js";
import * as vscode from "vscode";

import { isFastApplyModel } from "../../apply/utils";
import EditDecorationManager from "../../quickEdit/EditDecorationManager";
import { handleLLMError } from "../../util/errorHandling";
import { VsCodeWebviewProtocol } from "../../webviewProtocol";

import { myersDiff } from "core/diff/myers";
import { ApplyAbortManager } from "core/edit/applyAbortManager";
import { EDIT_MODE_STREAM_ID } from "core/edit/constants";
import { stripImages } from "core/util/messageContent";
import { getLastNPathParts } from "core/util/uri";
import { editOutcomeTracker } from "../../extension/EditOutcomeTracker";
import { VerticalDiffHandler, VerticalDiffHandlerOptions } from "./handler";
import { getFirstChangedLine } from "./util";

// Max time an apply stream is allowed to run before the watchdog forces a
// terminal "failed" state. Keep in sync with the GUI-side request timeout in
// handleApplyStateUpdate.ts (APPLY_TIMEOUT_MS) so the two safety nets agree.
const STREAM_DIFF_TIMEOUT_MS = 120_000;

export interface VerticalDiffCodeLens {
  start: number;
  numRed: number;
  numGreen: number;
}

export class VerticalDiffManager {
  public refreshCodeLens: () => void = () => {};

  private fileUriToHandler: Map<string, VerticalDiffHandler> = new Map();
  fileUriToCodeLens: Map<string, VerticalDiffCodeLens[]> = new Map();

  private userChangeListener: vscode.Disposable | undefined;

  logDiffs: DiffLine[] | undefined;

  constructor(
    private readonly webviewProtocol: VsCodeWebviewProtocol,
    private readonly editDecorationManager: EditDecorationManager,
    private readonly ide: IDE,
  ) {
    this.userChangeListener = undefined;
  }

  createVerticalDiffHandler(
    fileUri: string,
    startLine: number,
    endLine: number,
    options: VerticalDiffHandlerOptions,
    editor?: vscode.TextEditor,
  ): VerticalDiffHandler | undefined {
    if (this.fileUriToHandler.has(fileUri)) {
      this.fileUriToHandler.get(fileUri)?.clear(false);
      this.fileUriToHandler.delete(fileUri);
    }
    // Prefer the caller-resolved editor for the TARGET file. Relying on
    // activeTextEditor alone breaks whenever focus is elsewhere (e.g. the
    // Continue sidebar webview is focused), which made handler creation
    // return undefined and left the apply state hanging on "streaming"
    // forever with no terminal updateApplyState.
    const resolvedEditor =
      editor && URI.equal(editor.document.uri.toString(), fileUri)
        ? editor
        : vscode.window.activeTextEditor;
    if (
      resolvedEditor &&
      URI.equal(resolvedEditor.document.uri.toString(), fileUri)
    ) {
      const handler = new VerticalDiffHandler(
        startLine,
        endLine,
        resolvedEditor,
        this.fileUriToCodeLens,
        this.clearForfileUri.bind(this),
        this.refreshCodeLens,
        options,
      );
      this.fileUriToHandler.set(fileUri, handler);
      return handler;
    } else {
      return undefined;
    }
  }

  getHandlerForFile(fileUri: string) {
    return this.fileUriToHandler.get(fileUri);
  }

  getStreamIdForFile(fileUri: string): string | undefined {
    return this.fileUriToHandler.get(fileUri)?.streamId;
  }

  // Creates a listener for document changes by user.
  private enableDocumentChangeListener(): vscode.Disposable | undefined {
    if (this.userChangeListener) {
      //Only create one listener per file
      return;
    }

    this.userChangeListener = vscode.workspace.onDidChangeTextDocument(
      (event) => {
        // Check if there is an active handler for the affected file
        const fileUri = event.document.uri.toString();
        const handler = this.getHandlerForFile(fileUri);
        if (handler) {
          // Skip changes written by the handler's own streaming apply — they
          // are already reflected in its bookkeeping. This global listener is
          // shared by all files, so with concurrent applies file A finishing
          // re-enables it while file B is still streaming; without this guard
          // file B's own edits were processed as user edits, double-shifting
          // decorations and crashing with "Illegal argument: line must be
          // non-negative" (apply stuck at "Applying").
          if (handler.isStreaming) {
            return;
          }
          // If there is an active diff for that file, handle the document change
          try {
            this.handleDocumentChange(event, handler);
          } catch (e) {
            // One malformed change must never kill the event chain — a throw
            // here used to leave the apply state machine stuck.
            console.error(
              "[continue] Failed to track document change for open diff",
              e,
            );
          }
        }
      },
    );
  }

  // Listener for user doc changes is disabled during updates to the text document by continue
  public disableDocumentChangeListener() {
    if (this.userChangeListener) {
      this.userChangeListener.dispose();
      this.userChangeListener = undefined;
    }
  }

  private handleDocumentChange(
    event: vscode.TextDocumentChangeEvent,
    handler: VerticalDiffHandler,
  ) {
    // Loop through each change in the event
    event.contentChanges.forEach((change) => {
      // Calculate the number of lines added or removed
      const linesAdded = change.text.split("\n").length - 1;
      const linesDeleted = change.range.end.line - change.range.start.line;
      const lineDelta = linesAdded - linesDeleted;

      // Update the diff handler with the new line delta
      handler.updateLineDelta(
        event.document.uri.toString(),
        change.range.start.line,
        lineDelta,
      );
    });
  }

  clearForfileUri(fileUri: string | undefined, accept: boolean) {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      fileUri = activeEditor.document.uri.toString();
    }

    const handler = this.fileUriToHandler.get(fileUri);
    if (handler) {
      handler.clear(accept);
      this.fileUriToHandler.delete(fileUri);
    }

    this.disableDocumentChangeListener();

    void vscode.commands.executeCommand(
      "setContext",
      "continue.diffVisible",
      false,
    );

    void this.webviewProtocol.request(
      "focusContinueInputWithoutClear",
      undefined,
    );
  }

  async acceptRejectVerticalDiffBlock(
    accept: boolean,
    fileUri?: string,
    index?: number,
  ) {
    if (!fileUri) {
      const activeEditor = vscode.window.activeTextEditor;
      if (!activeEditor) {
        return;
      }
      fileUri = activeEditor.document.uri.toString();
    }

    if (typeof index === "undefined") {
      index = 0;
    }

    const blocks = this.fileUriToCodeLens.get(fileUri);
    const block = blocks?.[index];
    if (!blocks || !block) {
      return;
    }

    const handler = this.getHandlerForFile(fileUri);
    if (!handler) {
      return;
    }

    // Disable listening to file changes while continue makes changes
    this.disableDocumentChangeListener();

    // CodeLens object removed from editorToVerticalDiffCodeLens here
    await handler.acceptRejectBlock(
      accept,
      block.start,
      block.numGreen,
      block.numRed,
    );

    if (blocks.length === 1) {
      this.clearForfileUri(fileUri, true);
    } else {
      // Re-enable listener for user changes to file
      this.enableDocumentChangeListener();
    }

    this.refreshCodeLens();
  }

  async streamDiffLines(
    diffStream: AsyncGenerator<DiffLine>,
    instant: boolean,
    streamId: string,
    toolCallId?: string,
    targetFileUri?: string,
  ) {
    vscode.commands.executeCommand("setContext", "continue.diffVisible", true);

    // Resolve the editor for the TARGET file rather than whatever happens to
    // be active — a focused unrelated file previously made the apply silently
    // no-op, leaving the GUI's apply state stuck on "streaming".
    const editor = targetFileUri
      ? (vscode.window.visibleTextEditors.find((e) =>
          URI.equal(e.document.uri.toString(), targetFileUri),
        ) ??
        (await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(targetFileUri),
        )))
      : vscode.window.activeTextEditor;
    if (!editor) {
      await this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
      });
      return;
    }
    const fileUri = editor.document.uri.toString();
    const startLine = 0;
    const endLine = editor.document.lineCount - 1;

    // Check for existing handlers in the same file the new one will be created in
    const existingHandler = this.getHandlerForFile(fileUri);
    if (existingHandler) {
      existingHandler.clear(false);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    // Create new handler with determined start/end
    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      startLine,
      endLine,
      {
        instant,
        onStatusUpdate: (status, numDiffs, fileContent) =>
          void this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
            fileContent,
            filepath: fileUri,
            toolCallId,
          }),
        streamId,
      },
    );

    if (!diffHandler) {
      console.warn("Issue occurred while creating new vertical diff handler");
      await this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
        filepath: fileUri,
      });
      return;
    }

    if (editor.selection) {
      // Unselect the range
      editor.selection = new vscode.Selection(
        editor.selection.active,
        editor.selection.active,
      );
    }

    vscode.commands.executeCommand(
      "setContext",
      "continue.streamingDiff",
      true,
    );

    let settled = false;
    // Watchdog: if the apply neither completes nor throws (e.g. an editor edit
    // silently stalls), the GUI would hang on "Applying" forever. Force a
    // terminal state so it can recover.
    const watchdog = setTimeout(() => {
      if (settled) {
        return;
      }
      console.error(
        `[continue] Apply stream watchdog tripped (${STREAM_DIFF_TIMEOUT_MS}ms) — marking failed`,
        streamId,
      );
      void this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
        filepath: fileUri,
      });
      this.disableDocumentChangeListener();
    }, STREAM_DIFF_TIMEOUT_MS);

    try {
      this.logDiffs = await diffHandler.run(diffStream);

      // enable a listener for user edits to file while diff is open
      this.enableDocumentChangeListener();
    } catch (e) {
      this.disableDocumentChangeListener();
      const handled = await handleLLMError(e);

      // ALWAYS finalize: a dead stream must reach a terminal state, otherwise
      // the GUI hangs on "Applying". handleLLMError only decides whether to
      // surface the error — it must not swallow the failure and leave the
      // apply state stuck in "streaming" (the previous behavior).
      console.error(
        "[continue] Apply stream failed — marking failed",
        e instanceof Error ? e.message : e,
      );
      await this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
        filepath: fileUri,
        // Pass the underlying failure to the GUI so it can show the user WHY
        // (e.g. HTTP 404 / model-not-found from the apply model) instead of a
        // generic "Edit Failed".
        error: e instanceof Error ? e.message : String(e),
      });

      if (!handled) {
        let message = "Error streaming diffs";
        if (e instanceof Error) {
          message += `: ${e.message}`;
        }
        throw new Error(message);
      }
    } finally {
      settled = true;
      clearTimeout(watchdog);
      vscode.commands.executeCommand(
        "setContext",
        "continue.streamingDiff",
        false,
      );
    }
  }

  async instantApplyDiff(
    oldContent: string,
    newContent: string,
    streamId: string,
    toolCallId?: string,
    targetFileUri?: string,
  ) {
    vscode.commands.executeCommand("setContext", "continue.diffVisible", true);

    // Resolve the editor for the TARGET file (see streamDiffLines note).
    const editor = targetFileUri
      ? (vscode.window.visibleTextEditors.find((e) =>
          URI.equal(e.document.uri.toString(), targetFileUri),
        ) ??
        (await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(targetFileUri),
        )))
      : vscode.window.activeTextEditor;
    if (!editor) {
      await this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
      });
      return;
    }

    const fileUri = editor.document.uri.toString();

    const myersDiffs = myersDiff(oldContent, newContent);

    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      0,
      editor.document.lineCount - 1,
      {
        instant: true,
        onStatusUpdate: (status, numDiffs, fileContent) =>
          void this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
            fileContent,
            filepath: fileUri,
            toolCallId,
          }),
        streamId,
      },
      editor,
    );

    if (!diffHandler) {
      console.warn(
        `[continue] instantApplyDiff — failed to create diff handler for ${fileUri}`,
      );
      // ALWAYS finalize: without a terminal state the GUI apply status stays
      // on "streaming" forever and the agent turn hangs with no feedback.
      await this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
        filepath: fileUri,
        error: "Failed to create diff handler for the target editor",
      });
      return;
    }
    console.log(`[continue] instantApplyDiff — applying diff to ${fileUri}`);

    await diffHandler.reapplyWithMyersDiff(myersDiffs);
    console.log(
      `[continue] instantApplyDiff — diffs written (${myersDiffs.length} hunks)`,
    );

    const scrollToLine = getFirstChangedLine(myersDiffs, 0) ?? 0;
    const range = new vscode.Range(scrollToLine, 0, scrollToLine, 0);
    editor.revealRange(range, vscode.TextEditorRevealType.Default);

    this.enableDocumentChangeListener();

    await this.webviewProtocol.request("updateApplyState", {
      streamId,
      status: "done",
      numDiffs: this.fileUriToCodeLens.get(fileUri)?.length ?? 0,
      fileContent: editor.document.getText(),
      filepath: fileUri,
      toolCallId,
    });
    console.log(
      `[continue] instantApplyDiff — done state acked by webview (${fileUri})`,
    );
  }

  async streamEdit({
    input,
    llm,
    streamId,
    quickEdit,
    range,
    newCode,
    toolCallId,
    rulesToInclude,
    isApply,
  }: {
    input: string;
    llm: ILLM;
    streamId?: string;
    quickEdit?: string;
    range?: vscode.Range;
    newCode?: string;
    toolCallId?: string;
    rulesToInclude: undefined | RuleWithSource[];
    isApply: boolean;
  }): Promise<string | undefined> {
    void vscode.commands.executeCommand(
      "setContext",
      "continue.diffVisible",
      true,
    );

    let editor = vscode.window.activeTextEditor;

    if (!editor) {
      return undefined;
    }

    const fileUri = editor.document.uri.toString();

    let startLine, endLine: number;

    if (range) {
      startLine = range.start.line;
      endLine = range.end.line;
    } else {
      startLine = editor.selection.start.line;
      endLine = editor.selection.end.line;
    }

    // Check for existing handlers in the same file the new one will be created in
    const existingHandler = this.getHandlerForFile(fileUri);

    if (existingHandler) {
      if (quickEdit) {
        // Previous diff was a quickEdit
        // Check if user has highlighted a range
        let rangeBool =
          startLine !== endLine ||
          editor.selection.start.character !== editor.selection.end.character;

        // Check if the range is different from the previous range
        let newRangeBool =
          startLine !== existingHandler.range.start.line ||
          endLine !== existingHandler.range.end.line;

        if (!rangeBool || !newRangeBool) {
          // User did not highlight a new range -> use start/end from the previous quickEdit
          startLine = existingHandler.range.start.line;
          endLine = existingHandler.range.end.line;
        }
      }

      // Clear the previous handler
      // This allows the user to edit above the changed area,
      // but extra delta was added for each line generated by Continue
      // Before adding this back, we need to distinguish between human and Continue
      // let effectiveLineDelta =
      //   existingHandler.getLineDeltaBeforeLine(startLine);
      // startLine += effectiveLineDelta;
      // endLine += effectiveLineDelta;

      await existingHandler.clear(false);
    }

    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    // Create new handler with determined start/end
    const diffHandler = this.createVerticalDiffHandler(
      fileUri,
      startLine,
      endLine,
      {
        instant: isFastApplyModel(llm),
        input,
        onStatusUpdate: (status, numDiffs, fileContent) =>
          streamId &&
          void this.webviewProtocol.request("updateApplyState", {
            streamId,
            status,
            numDiffs,
            fileContent,
            filepath: fileUri,
            toolCallId,
          }),
        streamId,
      },
    );

    if (!diffHandler) {
      console.warn("Issue occurred while creating new vertical diff handler");
      return undefined;
    }

    let selectedRange = diffHandler.range;

    // Only if the selection is empty, use exact prefix/suffix instead of by line
    if (selectedRange.isEmpty) {
      selectedRange = new vscode.Range(
        editor.selection.start.with(undefined, 0),
        editor.selection.end.with(undefined, Number.MAX_SAFE_INTEGER),
      );
    }

    const rangeContent = editor.document.getText(selectedRange);
    const prefix = pruneLinesFromTop(
      editor.document.getText(
        new vscode.Range(new vscode.Position(0, 0), selectedRange.start),
      ),
      llm.contextLength / 4,
      llm.model,
    );
    const suffix = pruneLinesFromBottom(
      editor.document.getText(
        new vscode.Range(
          selectedRange.end,
          new vscode.Position(editor.document.lineCount, 0),
        ),
      ),
      llm.contextLength / 4,
      llm.model,
    );

    let overridePrompt: ChatMessage[] | undefined;
    if (llm.promptTemplates?.apply) {
      const filepath = getLastNPathParts(fileUri, 1);
      const rendered = llm.renderPromptTemplate(llm.promptTemplates.apply, [], {
        original_code: rangeContent,
        new_code: newCode ?? "",
        filepath,
      });
      overridePrompt =
        typeof rendered === "string"
          ? [{ role: "user", content: rendered }]
          : rendered;
    }

    if (editor.selection) {
      // Unselect the range
      editor.selection = new vscode.Selection(
        editor.selection.active,
        editor.selection.active,
      );
    }

    void vscode.commands.executeCommand(
      "setContext",
      "continue.streamingDiff",
      true,
    );

    this.editDecorationManager.clear();

    const abortManager = ApplyAbortManager.getInstance();
    const abortController = abortManager.get(fileUri);

    let settled = false;
    // Watchdog: if the edit neither completes nor throws (e.g. the LLM stream
    // silently stalls), the GUI would hang on "Applying" forever. Same safety
    // net as streamDiffLines.
    const watchdog = setTimeout(() => {
      if (settled || !streamId) {
        return;
      }
      console.error(
        `[continue] Edit stream watchdog tripped (${STREAM_DIFF_TIMEOUT_MS}ms) — marking failed`,
        streamId,
      );
      void this.webviewProtocol.request("updateApplyState", {
        streamId,
        status: "failed",
        toolCallId,
        filepath: fileUri,
      });
      this.disableDocumentChangeListener();
    }, STREAM_DIFF_TIMEOUT_MS);

    try {
      const streamedLines: string[] = [];

      async function* recordedStream() {
        const stream = streamDiffLines(
          {
            highlighted: rangeContent,
            prefix,
            suffix,
            input,
            language: getMarkdownLanguageTagForFile(fileUri),
            type: isApply ? "apply" : "edit",
            newCode: newCode ?? "",
            includeRulesInSystemMessage: !!rulesToInclude && !isApply,
            modelTitle: llm.title ?? llm.model,
          },
          llm,
          abortController,
          overridePrompt,
          rulesToInclude,
        );

        for await (const line of stream) {
          if (line.type === "new" || line.type === "same") {
            streamedLines.push(line.line);
          }
          yield line;
        }
      }

      this.logDiffs = await diffHandler.run(recordedStream());

      // enable a listener for user edits to file while diff is open
      this.enableDocumentChangeListener();

      if (abortController.signal.aborted) {
        void vscode.commands.executeCommand("continue.rejectDiff");
      }

      const fileAfterEdit = `${prefix}${streamedLines.join("\n")}${suffix}`;
      await this.trackEditInteraction({
        model: llm,
        filepath: fileUri,
        prompt: input,
        fileAfterEdit,
      });

      return fileAfterEdit;
    } catch (e) {
      this.disableDocumentChangeListener();
      const handled = await handleLLMError(e);

      // ALWAYS finalize: a dead stream must reach a terminal state, otherwise
      // the GUI hangs on "Applying" forever. handleLLMError only decides
      // whether to surface the error — it must not swallow the failure and
      // leave the apply state stuck in "streaming" (the previous behavior).
      // Same safety net as streamDiffLines.
      console.error(
        "[continue] Edit stream failed — marking failed",
        e instanceof Error ? e.message : e,
      );
      if (streamId) {
        await this.webviewProtocol.request("updateApplyState", {
          streamId,
          status: "failed",
          toolCallId,
          filepath: fileUri,
        });
      }

      if (!handled) {
        let message = "Error streaming edit diffs";
        if (e instanceof Error) {
          message += `: ${e.message}`;
        }
        throw new Error(message);
      }
    } finally {
      settled = true;
      clearTimeout(watchdog);
      void vscode.commands.executeCommand(
        "setContext",
        "continue.streamingDiff",
        false,
      );
    }
  }

  async trackEditInteraction({
    model,
    filepath,
    prompt,
    fileAfterEdit,
  }: {
    model: ILLM;
    filepath: string;
    prompt: string;
    fileAfterEdit: string | undefined;
  }) {
    // Get previous code content for outcome tracking
    const previousCode = await this.ide.readFile(filepath);
    const newCode = fileAfterEdit ?? "";
    const previousCodeLines = previousCode.split("\n").length;
    const newCodeLines = newCode.split("\n").length;
    const lineChange = newCodeLines - previousCodeLines;

    // Store pending edit data for outcome tracking
    editOutcomeTracker.trackEditInteraction({
      streamId: EDIT_MODE_STREAM_ID,
      timestamp: new Date().toISOString(),
      modelProvider: model.underlyingProviderName,
      modelName: model.title ?? "",
      modelTitle: model.title ?? "",
      prompt: stripImages(prompt),
      completion: newCode,
      previousCode,
      newCode,
      filepath: filepath,
      previousCodeLines,
      newCodeLines,
      lineChange,
    });
  }
}
