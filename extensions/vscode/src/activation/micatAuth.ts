/**
 * MicatCode Authentication Provider
 *
 * Implements VS Code's AuthenticationProvider API to provide
 * MicatCode account login via an in-editor Webview panel.
 *
 * Flow:
 * 1. User clicks "Sign in" → Webview panel opens with login.html
 * 2. User completes login inside the panel (MicatCode account or API Key)
 * 3. Webview posts a message: { type: "login", token } or { type: "apiKey", key }
 * 4. Extension receives the message, validates the credential, creates a session
 * 5. Webview panel closes
 *
 * TODO: Replace mock token validation with real JWT verification:
 * - Send token to https://api.micatcode.com/auth/verify
 * - Validate JWT signature using public key
 * - Check token expiry
 * - Return user info (userId, plan, credits)
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

// ----------------------------------------------------------------
// Constants
// ----------------------------------------------------------------

export const MICAT_AUTH_PROVIDER_ID = "micatcode";
export const MICAT_AUTH_PROVIDER_LABEL = "MicatCode";

// ----------------------------------------------------------------
// User session info
// ----------------------------------------------------------------

export interface MicatSession {
  id: string;
  accessToken: string;
  account: {
    id: string;
    label: string;
  };
  scopes: string[];
  // Extended user info
  plan: "free" | "pro" | "enterprise";
  credits?: {
    used: number;
    total: number;
    resetDate?: string;
  };
}

// ----------------------------------------------------------------
// Token validation
// ----------------------------------------------------------------

async function validateToken(token: string): Promise<MicatSession | null> {
  // TODO: Replace with real backend validation
  // Real implementation:
  // try {
  //   const response = await fetch('https://api.micatcode.com/auth/verify', {
  //     method: 'GET',
  //     headers: { 'Authorization': `Bearer ${token}` }
  //   });
  //   if (!response.ok) return null;
  //   const data = await response.json();
  //   return {
  //     id: data.userId,
  //     accessToken: token,
  //     account: { id: data.userId, label: data.email || data.username },
  //     scopes: ['chat'],
  //     plan: data.plan,
  //     credits: { used: data.creditsUsed, total: data.creditsTotal }
  //   };
  // } catch {
  //   return null;
  // }

  // Mock: accept any token that starts with "mock_token_"
  if (token.startsWith("mock_token_") || token.length > 10) {
    return {
      id: "session_" + Date.now(),
      accessToken: token,
      account: {
        id: "user_demo_001",
        label: "Demo User",
      },
      scopes: ["chat"],
      plan: "pro",
      credits: {
        used: 1500,
        total: 2000,
        resetDate: "10/01",
      },
    };
  }

  return null;
}

// ----------------------------------------------------------------
// Authentication Provider
// ----------------------------------------------------------------

export class MicatAuthProvider
  implements vscode.AuthenticationProvider, vscode.Disposable
{
  private readonly _onDidChangeSessions =
    new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
  readonly onDidChangeSessions = this._onDidChangeSessions.event;

  private _sessions: MicatSession[] = [];
  private readonly _secretKey = "micatcode.auth.sessions";

  constructor(private readonly context: vscode.ExtensionContext) {
    // Load existing sessions from secure storage
    this.loadSessions();
  }

  // ----------------------------------------------------------------
  // VS Code AuthenticationProvider interface
  // ----------------------------------------------------------------

  async getSessions(
    scopes?: readonly string[],
  ): Promise<vscode.AuthenticationSession[]> {
    return this._sessions.filter((s) => {
      if (!scopes || scopes.length === 0) return true;
      return scopes.every((scope) => s.scopes.includes(scope));
    });
  }

  async createSession(
    scopes: readonly string[],
  ): Promise<vscode.AuthenticationSession> {
    // Open login.html in a VS Code Webview panel.
    // The page communicates back via postMessage — no browser or URI callback needed.
    const token = await this._showLoginWebview();
    if (!token) {
      throw new Error("Login cancelled.");
    }

    const session = await validateToken(token);
    if (!session) {
      throw new Error("Invalid token received. Please try again.");
    }

    this._sessions.push(session);
    await this.saveSessions();

    this._onDidChangeSessions.fire({
      added: [session],
      removed: [],
      changed: [],
    });

    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    const idx = this._sessions.findIndex((s) => s.id === sessionId);
    if (idx === -1) return;

    const removed = this._sessions.splice(idx, 1);
    await this.saveSessions();

    this._onDidChangeSessions.fire({
      added: [],
      removed,
      changed: [],
    });
  }

  // ----------------------------------------------------------------
  // Webview login panel
  // ----------------------------------------------------------------

  /**
   * Opens login.html inside a VS Code Webview panel.
   * Returns the credential string (token or API key) on success, or null if cancelled.
   *
   * The Webview page posts one of two messages:
   *   { type: "login",  token:  string }   — MicatCode account OAuth token
   *   { type: "apiKey", apiKey: string }   — direct API key entry
   *   { type: "cancel" }                   — user dismissed the panel
   */
  private _showLoginWebview(): Promise<string | null> {
    return new Promise((resolve) => {
      const panel = vscode.window.createWebviewPanel(
        "micatcodeLogin",
        "Sign in to MicatCode",
        vscode.ViewColumn.One,
        {
          enableScripts: true,
          // Allow the webview to load the local media folder
          localResourceRoots: [
            vscode.Uri.joinPath(this.context.extensionUri, "media"),
          ],
          retainContextWhenHidden: false,
        },
      );

      // Load login.html and rewrite resource URIs to webview-safe URIs
      panel.webview.html = this._buildLoginHtml(panel.webview);
      console.log("MicatCode: login Webview opened");

      let settled = false;
      const settle = (value: string | null) => {
        if (settled) return;
        settled = true;
        panel.dispose();
        resolve(value);
      };

      // Messages from the Webview page
      panel.webview.onDidReceiveMessage(
        async (msg: { type: string; token?: string; apiKey?: string }) => {
          console.log(
            `MicatCode: received login Webview message '${msg.type}'`,
          );
          switch (msg.type) {
            case "login":
              settle(msg.token ?? null);
              break;
            case "apiKey": {
              const key = msg.apiKey ?? null;
              if (key) {
                void vscode.window.showInformationMessage(
                  "请将 API Key 配置到 Continue 的 config.yaml，并为该模型指定 chat role。",
                );
              }
              settle(key);
              break;
            }
            case "cancel":
              settle(null);
              break;
          }
        },
        undefined,
        this.context.subscriptions,
      );

      // User closed the panel manually
      panel.onDidDispose(
        () => settle(null),
        undefined,
        this.context.subscriptions,
      );
    });
  }

  /** Read login.html from disk and replace all src/href with webview URIs. */
  private _buildLoginHtml(webview: vscode.Webview): string {
    const htmlPath = path.join(
      this.context.extensionPath,
      "media",
      "login.html",
    );
    let html = fs.readFileSync(htmlPath, "utf8");

    // Replace asset references so the Webview sandbox can load them
    const mediaUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media"),
    );
    html = html.replace(/(['"])\.?\/?media\//g, `$1${mediaUri}/`);

    // Inject a Content-Security-Policy that allows inline scripts and the
    // media origin, while blocking arbitrary network requests.
    const nonce = getNonce();
    html = html.replace(
      /<head>/i,
      `<head>
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">`,
    );
    html = html.replace(/<script>/i, `<script nonce="${nonce}">`);

    return html;
  }

  // ----------------------------------------------------------------
  // Session persistence
  // ----------------------------------------------------------------

  private async loadSessions(): Promise<void> {
    try {
      const raw = await this.context.secrets.get(this._secretKey);
      if (raw) {
        this._sessions = JSON.parse(raw);
      }
    } catch {
      this._sessions = [];
    }
  }

  private async saveSessions(): Promise<void> {
    await this.context.secrets.store(
      this._secretKey,
      JSON.stringify(this._sessions),
    );
  }

  // ----------------------------------------------------------------
  // Helpers
  // ----------------------------------------------------------------

  getCurrentSession(): MicatSession | undefined {
    return this._sessions[0];
  }

  isSignedIn(): boolean {
    return this._sessions.length > 0;
  }

  dispose(): void {
    this._onDidChangeSessions.dispose();
  }
}

// ----------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/** Register login commands before Continue Core starts optional native services. */
export function registerMicatAuthCommands(
  context: vscode.ExtensionContext,
  authProvider: MicatAuthProvider,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("micatcode.signIn", async () => {
      try {
        const sessions = await authProvider.getSessions(["chat"]);
        if (sessions.length === 0) {
          await authProvider.createSession(["chat"]);
        }
        vscode.window.showInformationMessage("MicatCode: 登录成功！");
        return true;
      } catch (error) {
        vscode.window.showErrorMessage(`MicatCode: 登录失败 - ${error}`);
        throw error;
      }
    }),
    vscode.commands.registerCommand("micatcode.signOut", async () => {
      const sessions = await authProvider.getSessions();
      await Promise.all(
        sessions.map((session) => authProvider.removeSession(session.id)),
      );
      vscode.window.showInformationMessage("MicatCode: 已退出登录。");
    }),
    vscode.commands.registerCommand("micatcode.setApiKey", async () => {
      vscode.window.showInformationMessage(
        "在 Continue 的 config.yaml 中为模型配置 apiKey，并指定 roles: [chat]。",
      );
      await vscode.commands.executeCommand("continue.openConfigPage");
    }),
  );
}

/**
 * Start the authentication surface without loading Continue Core. This must run
 * during extension activation so the native Chat setup command is always
 * available, even while optional indexing or Git services are still starting.
 */
export function initializeMicatAuthentication(
  context: vscode.ExtensionContext,
): MicatAuthProvider {
  const authProvider = new MicatAuthProvider(context);
  context.subscriptions.push(
    vscode.authentication.registerAuthenticationProvider(
      MICAT_AUTH_PROVIDER_ID,
      MICAT_AUTH_PROVIDER_LABEL,
      authProvider,
      { supportsMultipleAccounts: false },
    ),
    authProvider,
  );
  registerMicatAuthCommands(context, authProvider);
  return authProvider;
}
