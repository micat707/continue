import type {
  DocumentSymbol,
  FileStatsMap,
  FileType,
  IDE,
  IdeInfo,
  IdeSettings,
  IndexTag,
  Location,
  Problem,
  Range,
  RangeInFile,
  SignatureHelp,
  TerminalOptions,
  Thread,
} from "../";
export interface GetGhTokenArgs {
  force?: boolean;
}

export type ToIdeFromWebviewOrCoreProtocol = {
  // Methods from IDE type
  getIdeInfo: [undefined, IdeInfo];
  getWorkspaceDirs: [undefined, string[]];
  writeFile: [{ path: string; contents: string }, void];
  removeFile: [{ path: string }, void];
  createDirectory: [{ path: string }, void];
  showVirtualFile: [{ name: string; content: string }, void];
  openFile: [{ path: string }, void];
  // Ask the user where to save the given content, write it to disk, and open
  // the file in the editor. Returns the saved file path, or undefined if the
  // user dismissed the save dialog.
  exportSession: [{ name: string; content: string }, string | undefined];
  openUrl: [string, void];
  runCommand: [{ command: string; options?: TerminalOptions }, void];
  // Reveal/focus the DeepAgent's shared integrated terminal so the user can
  // watch the real command output live (Run Command card's terminal icon).
  showAgentTerminal: [{}, void];
  getSearchResults: [{ query: string; maxResults?: number }, string];
  getFileResults: [{ pattern: string; maxResults?: number }, string[]];
  subprocess: [{ command: string; cwd?: string }, [string, string]];
  saveFile: [{ filepath: string }, void];
  fileExists: [{ filepath: string }, boolean];
  readFile: [{ filepath: string }, string];
  // Kiro-aligned artifact store (disk-backed, per-session manifest).
  /** List artifacts for a session; rebuilds GUI state after webview reload. */
  artifactList: [
    { sessionId?: string },
    Array<{
      id: string;
      title: string;
      kind: string;
      content: string;
      filePath: string;
      format?: string;
      url: string;
      sessionId?: string;
      createdAt: string;
    }>,
  ];
  /** Dismiss (delete) an artifact from the store. */
  artifactDelete: [{ id: string; sessionId?: string }, void];
  // MicatCode: the GUI (webview) has no Node access, so the extension host
  // resolves the environment for us (Kiro-style context blocks).
  micatGetPaths: [
    undefined,
    {
      platform: string;
      shell: string;
      homeDirUri: string;
      globalSteeringDirUri: string;
      /** fsPath of the first workspace folder, if any */
      workspaceRoot?: string;
      /** Ready-made Kiro-style blocks (shell-aware, built by the extension host) */
      systemInformationBlock: string;
      platformCommandGuidelinesBlock: string;
      currentDateTimeBlock: string;
    },
  ];
  /** Kiro-style session-start file tree snapshot (pre-formatted XML string) */
  micatGetFileTree: [undefined, string];
  getProblems: [{ filepath: string }, Problem[]];
  getOpenFiles: [undefined, string[]];
  getCurrentFile: [
    undefined,
    (
      | undefined
      | {
          isUntitled: boolean;
          path: string;
          contents: string;
        }
    ),
  ];
  getPinnedFiles: [undefined, string[]];
  showLines: [{ filepath: string; startLine: number; endLine: number }, void];
  readRangeInFile: [{ filepath: string; range: Range }, string];
  getDiff: [{ includeUnstaged: boolean }, string[]];
  getTerminalContents: [undefined, string];
  getDebugLocals: [{ threadIndex: number }, string];
  getTopLevelCallStackSources: [
    { threadIndex: number; stackDepth: number },
    string[],
  ];
  getAvailableThreads: [undefined, Thread[]];
  isTelemetryEnabled: [undefined, boolean];
  isWorkspaceRemote: [undefined, boolean];
  getUniqueId: [undefined, string];
  getTags: [string, IndexTag[]];
  readSecrets: [{ keys: string[] }, Record<string, string>];
  writeSecrets: [{ secrets: Record<string, string> }, void];
  // end methods from IDE type

  getIdeSettings: [undefined, IdeSettings];

  // Git
  getBranch: [{ dir: string }, string];
  getRepoName: [{ dir: string }, string | undefined];

  showToast: [
    Parameters<IDE["showToast"]>,
    Awaited<ReturnType<IDE["showToast"]>>,
  ];
  getGitRootPath: [{ dir: string }, string | undefined];
  listDir: [{ dir: string }, [string, FileType][]];
  getFileStats: [{ files: string[] }, FileStatsMap];

  gotoDefinition: [{ location: Location }, RangeInFile[]];
  gotoTypeDefinition: [{ location: Location }, RangeInFile[]];
  getSignatureHelp: [{ location: Location }, SignatureHelp | null];
  getReferences: [{ location: Location }, RangeInFile[]];
  getDocumentSymbols: [{ textDocumentIdentifier: string }, DocumentSymbol[]];

  reportError: [any, void];
  closeSidebar: [undefined, void];
};

export type ToWebviewOrCoreFromIdeProtocol = {
  didChangeActiveTextEditor: [{ filepath: string }, void];
};
