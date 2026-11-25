/**
 * PermissionsPanel
 * ---------------
 * A standalone VS Code Webview for editing the DeepAgent tool-permission policy
 * (the global / workspace / session layers). This is the UI counterpart of the
 * three-layer model in `permissions.ts` + `permissionStore.ts`: it shows the
 * merged "effective" preview and lets the user edit the global / workspace
 * layers (persisted via VS Code settings) and clear the session memory.
 *
 * It deliberately reuses the same inline-HTML webview pattern as
 * `DeepAgentChatPanel` so it does not depend on the React GUI build pipeline.
 */

import * as vscode from "vscode";
import type { DeepAgentPermissionsState } from "core/protocol/ideWebview";
import {
  mergeRules,
  type LayerKey,
  type PermissionAction,
  type PermissionConfig,
} from "./permissions";
import { loadGlobalConfig, loadWorkspaceConfig } from "./permissionStore";
import { getWorkspaceFolders } from "./workspaceBackend";
import { getSessionPermissionHandle } from "./DeepAgentLLM";
import { getExtensionUri, getNonce } from "../util/vscode";

const SETTING_KEY = "deepAgent.permissions";

const EMPTY_CONFIG: PermissionConfig = {
  trustedDirs: [],
  trustRules: [],
  untrustRules: [],
  executeAllowlist: [],
};

function serializeMerged(m: ReturnType<typeof mergeRules>) {
  const toArr = (
    rules: Map<string, PermissionAction>,
    sources: Map<string, LayerKey>,
  ) => {
    const out: Array<{
      tool: string;
      action: PermissionAction;
      source: LayerKey;
    }> = [];
    const keys = new Set([...rules.keys(), ...sources.keys()]);
    keys.forEach((k) => {
      out.push({
        tool: k,
        action: (rules.get(k) ?? "ask") as PermissionAction,
        source: (sources.get(k) ?? "global") as LayerKey,
      });
    });
    return out;
  };
  return {
    trustRules: toArr(m.trustRules, m.trustSources),
    untrustRules: toArr(m.untrustRules, m.untrustSources),
    trustedDirs: m.trustedDirs,
    executeAllowlist: m.executeAllowlist,
  };
}

/**
 * Build the full three-layer permission state shared by both UIs (the inline
 * GUI settings section and the standalone webview panel).
 */
export function buildPermissionsState(
  sessionId?: string,
): DeepAgentPermissionsState {
  const globalCfg = loadGlobalConfig();
  const wsCfg = loadWorkspaceConfig();
  const handle = getSessionPermissionHandle(sessionId);
  const sessionPolicy = handle?.getSessionPolicy() ?? EMPTY_CONFIG;
  const merged = mergeRules(globalCfg, wsCfg, sessionPolicy);
  return {
    global: globalCfg,
    workspace: wsCfg ?? EMPTY_CONFIG,
    session: handle?.getMemory() ?? {
      approved: [],
      readApproved: [],
      denied: [],
    },
    merged: serializeMerged(merged),
    workspaceFolders: getWorkspaceFolders().map((f) => f.path),
  };
}

/**
 * Persist one policy layer: "global" → user settings, "workspace" → workspace
 * settings. Returns the refreshed state so callers can re-render immediately.
 */
export async function updatePermissionsLayer(
  layer: "global" | "workspace",
  config: PermissionConfig,
): Promise<DeepAgentPermissionsState> {
  const target =
    layer === "workspace"
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
  await vscode.workspace
    .getConfiguration("continue")
    .update(SETTING_KEY, config, target);
  return buildPermissionsState();
}

export class PermissionsPanel {
  public static current?: PermissionsPanel;

  private readonly panel: vscode.WebviewPanel;

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => {
      PermissionsPanel.current = undefined;
    });
  }

  static createOrShow() {
    const column = vscode.ViewColumn.Beside;
    if (PermissionsPanel.current) {
      PermissionsPanel.current.panel.reveal(column);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "deepAgentPermissions",
      "权限设置",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [getExtensionUri()],
      },
    );
    PermissionsPanel.current = new PermissionsPanel(panel);
    panel.webview.html = PermissionsPanel.getHtml(panel.webview);
  }

  private sendState() {
    this.panel.webview.postMessage({
      type: "state",
      ...buildPermissionsState(),
    });
  }

  private async onMessage(msg: any) {
    switch (msg?.type) {
      case "ready":
      case "getState":
        this.sendState();
        break;
      case "updateLayer": {
        const layer = msg.layer === "workspace" ? "workspace" : "global";
        await updatePermissionsLayer(layer, msg.config);
        this.sendState();
        break;
      }
      case "clearSession":
        // Standalone panel has no session context; clear the most recently
        // used session (the one whose memory the panel is displaying).
        getSessionPermissionHandle()?.clear();
        this.sendState();
        break;
    }
  }

  // ---- Webview HTML (inline, vanilla JS; mirrors DeepAgentChatPanel) ----

  private static getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      "style-src 'unsafe-inline'",
      `script-src 'nonce-${nonce}'`,
      "font-src https:",
    ].join("; ");

    return /* html */ `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>权限设置</title>
  <style>
    :root { --bg:#1e1e1e; --panel:#252526; --border:#3c3c3c; --fg:#d4d4d4; --muted:#9a9a9a; --accent:#0e639c; --green:#4ec99b; --orange:#ffb86c; --red:#f48771; }
    * { box-sizing: border-box; }
    html, body { margin:0; height:100%; background:var(--bg); color:var(--fg); font-family: -apple-system, "Segoe UI", system-ui, sans-serif; font-size:13px; }
    #app { display:flex; flex-direction:column; height:100vh; }
    header { padding:12px 16px; border-bottom:1px solid var(--border); font-weight:600; font-size:14px; letter-spacing:.5px; display:flex; justify-content:space-between; align-items:center; }
    header button { background:transparent; color:var(--muted); border:1px solid var(--border); border-radius:4px; padding:3px 10px; cursor:pointer; font-size:12px; }
    header button:hover { color:var(--fg); border-color:#666; }
    .tabs { display:flex; gap:6px; padding:10px 12px 0; border-bottom:1px solid var(--border); }
    .tab { flex:1; white-space:nowrap; text-align:center; padding:7px 6px; background:#2d2d2d; border:1px solid var(--border); border-bottom:none; color:#bbb; border-radius:6px 6px 0 0; cursor:pointer; font-size:12px; transition:background .15s,color .15s; }
    .tab:hover { background:#3a3a3a; color:#fff; }
    .tab.active { background:var(--accent); color:#fff; border-color:var(--accent); font-weight:600; }
    .content { flex:1; overflow:auto; padding:12px 14px; }
    .section { margin-bottom:16px; }
    .section h4 { margin:0 0 8px; color:#eee; }
    table { width:100%; border-collapse:collapse; background:var(--panel); border-radius:6px; overflow:hidden; border:1px solid var(--border); }
    th, td { padding:7px 9px; text-align:left; border-bottom:1px solid var(--border); vertical-align:middle; }
    th { background:#2d2d2d; color:#fff; font-size:12px; }
    tr:last-child td { border-bottom:none; }
    .tool { font-family:Consolas,Monaco,monospace; color:#9cdcfe; font-size:12px; }
    select { background:#3c3c3c; color:#fff; border:1px solid #555; padding:3px 6px; border-radius:3px; }
    select:disabled { opacity:.45; }
    .src { color:var(--muted); font-size:11px; margin-left:6px; }
    .src.global { color:#5cc9ff; } .src.workspace { color:var(--green); } .src.session { color:var(--orange); }
    .btn { padding:5px 10px; border:none; border-radius:4px; margin:4px 2px; cursor:pointer; }
    .btn-primary { background:var(--accent); color:#fff; }
    .btn-default { background:#3c3c3c; color:#ddd; }
    .btn-danger { background:#5a2a2a; color:#f48771; }
    .foot { color:var(--muted); font-size:11px; margin-top:6px; }
    .warn { color:var(--red); margin:8px 0; }
    .preview { background:var(--panel); padding:10px; border-radius:6px; border:1px solid var(--border); margin-bottom:14px; }
    .preview-item { margin:3px 0; }
    .dir-row { display:flex; align-items:center; gap:8px; padding:3px 0; }
    .dir-row button { background:transparent; border:none; color:var(--red); cursor:pointer; }
    .legend b.g { color:#5cc9ff; } .legend b.w { color:var(--green); } .legend b.s { color:var(--orange); }
    .list { background:var(--panel); border:1px solid var(--border); border-radius:6px; padding:8px; max-height:200px; overflow:auto; }
    .list .item { padding:3px 0; color:var(--muted); word-break:break-all; }
  </style>
</head>
<body>
  <div id="app">
    <header>
      <span>DeepAgent 权限设置</span>
      <button onclick="vscode.postMessage({type:'getState'})">刷新</button>
    </header>
    <div class="tabs">
      <div class="tab active" data-layer="global">🌐 全局</div>
      <div class="tab" data-layer="workspace">📁 项目</div>
      <div class="tab" data-layer="session">💬 会话</div>
    </div>
    <div class="content" id="content"></div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let state = null;
    let currentLayer = "global";

    const TOOLS = [
      { tool:"read_file", desc:"读取文件" },
      { tool:"read_files", desc:"批量读取多个文件" },
      { tool:"fs_write", desc:"新建/修改普通文件" },
      { tool:"append_lines", desc:"追加内容到已有文件" },
      { tool:"str_replace", desc:"编辑文件" },
      { tool:"delete_file", desc:"删除文件/文件夹" },
      { tool:"list_directory", desc:"列目录" },
      { tool:"file_search", desc:"搜索文件" },
      { tool:"grep_search", desc:"搜索内容" },
      { tool:"execute_pwsh", desc:"执行命令（任意 shell，不受路径约束）" },
      { tool:"control_pwsh_process", desc:"后台进程管理" },
    ];
    const FILE_TOOLS = ["read_file","read_files","fs_write","append_lines","str_replace","delete_file"];
    // Hard red line: these tools can NEVER be "allow" in ANY scope.
    const NO_ALLOW_TOOLS = ["execute_pwsh"];

    function clone(o){ return JSON.parse(JSON.stringify(o)); }

    function esc(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }

    function actionOptions(tool, scope, value, disabled) {
      const isFile = FILE_TOOLS.indexOf(tool) >= 0;
      // Red line: command execution can never be "allow" in any scope.
      const noAllow = isFile || NO_ALLOW_TOOLS.indexOf(tool) >= 0;
      let opts = "";
      const add = (v, label) => {
        opts += '<option value="'+v+'"'+(value===v?" selected":"")+'>'+label+'</option>';
      };
      if (noAllow) {
        // Red line: untrusted file tools / command execution cannot be "allow".
        add("ask","⚠️ 需要审批");
        add("deny","🚫 禁止");
      } else {
        add("allow","✅ 无需审批");
        add("ask","⚠️ 需要审批");
        add("deny","🚫 禁止");
      }
      return '<select data-tool="'+tool+'" data-scope="'+scope+'"'+(disabled?" disabled":"")+'>'+opts+'</select>';
    }

    function renderRuleTable(scope, layerKey, cfg, mergedRows) {
      // mergedRows: array {tool, action, source}
      const map = {};
      mergedRows.forEach(r => { map[r.tool] = r; });
      let html = '<table><thead><tr><th>工具</th><th>说明</th><th>策略</th><th>来源</th></tr></thead><tbody>';
      TOOLS.forEach(t => {
        const merged = map[t.tool];
        const effective = merged ? merged.action : "ask";
        const source = merged ? merged.source : "global";
        const ownIndex = cfg[scope].findIndex(r => r.tool === t.tool);
        const isOwn = source === layerKey || ownIndex >= 0;
        const value = ownIndex >= 0 ? cfg[scope][ownIndex].action : effective;
        const disabled = !isOwn;
        const srcLabel = isOwn ? "" : '<span class="src '+source+'">'+(source==="global"?"🔵":source==="workspace"?"🟢":"🟠")+' 继承'+(source==="global"?"全局":source==="workspace"?"项目":"会话")+'</span>';
        html += '<tr><td><span class="tool">'+t.tool+'</span></td><td>'+t.desc+'</td><td>'+actionOptions(t.tool, scope, value, disabled)+'</td><td>'+srcLabel+'</td></tr>';
      });
      html += '</tbody></table>';
      if (scope === "untrustRules") {
        html += '<div class="foot">安全红线：非信任目录的文件类工具不可设为「无需审批」。</div>';
      }
      return html;
    }

    function renderTrustedDirs(layerKey, cfg) {
      let html = '<div class="dir-row"><input id="newDir" placeholder="输入绝对路径，如 D:/code/demo" style="flex:1;background:#3c3c3c;color:#fff;border:1px solid #555;padding:4px 6px;border-radius:3px"/>';
      html += '<button class="btn btn-default" onclick="addDir()">添加</button></div>';
      html += '<div style="margin-top:6px">';
      cfg.trustedDirs.forEach((d, i) => {
        html += '<div class="dir-row"><span>'+esc(d)+'</span><button data-deldir="'+i+'">✕</button></div>';
      });
      html += '</div>';
      return html;
    }

    function renderAllowlist(layerKey, cfg) {
      if (!cfg.executeAllowlist) cfg.executeAllowlist = [];
      let html = '<div class="foot" style="margin-bottom:6px">列出可免审批直接执行的程序（如 <b>mvn</b>、<b>tsc</b>、<b>npm run build</b>）。匹配命令的首个程序，且命令不含 shell 元字符（分号、管道、逻辑符、重定向、变量展开、反引号、括号、换行）时才免审批。</div>';
      html += '<div class="dir-row"><input id="newAllow" placeholder="程序名或 /正则/，如 mvn" style="flex:1;background:#3c3c3c;color:#fff;border:1px solid #555;padding:4px 6px;border-radius:3px"/>';
      html += '<button class="btn btn-default" onclick="addAllow()">添加</button></div>';
      html += '<div style="margin-top:6px">';
      if (!cfg.executeAllowlist.length) {
        html += '<div class="item">（空：所有命令都需审批）</div>';
      }
      cfg.executeAllowlist.forEach((d, i) => {
        html += '<div class="dir-row"><span>'+esc(d)+'</span><button data-delallow="'+i+'">✕</button></div>';
      });
      html += '</div>';
      return html;
    }

    function renderLayer(layerKey) {
      const cfg = state[layerKey] || { trustedDirs:[], trustRules:[], untrustRules:[], executeAllowlist:[] };
      if (!cfg.trustedDirs) cfg.trustedDirs = [];
      if (!cfg.trustRules) cfg.trustRules = [];
      if (!cfg.untrustRules) cfg.untrustRules = [];
      if (!cfg.executeAllowlist) cfg.executeAllowlist = [];
      const merged = state.merged;
      let h = '<div class="section"><h4>受信任目录内规则</h4>' + renderRuleTable("trustRules", layerKey, cfg, merged.trustRules) + '</div>';
      h += '<div class="section"><h4>非受信任目录内规则</h4>' + renderRuleTable("untrustRules", layerKey, cfg, merged.untrustRules) + '</div>';
      h += '<div class="section"><h4>受信任目录管理</h4>' + renderTrustedDirs(layerKey, cfg) + '</div>';
      h += '<div class="section"><h4>命令免审批白名单（execute）</h4>' + renderAllowlist(layerKey, cfg) + '</div>';
      h += '<button class="btn btn-primary" data-savelayer="'+layerKey+'">💾 保存本层</button>';
      if (layerKey === "workspace") {
        h += '<div class="foot">项目层写入工作区设置（.vscode/settings.json 或 .code-workspace）。</div>';
      } else {
        h += '<div class="foot">全局层写入用户设置（User settings.json）。</div>';
      }
      return h;
    }

    function renderSession() {
      const s = state.session || { approved: [], denied: [] };
      if (!s.approved) s.approved = [];
      if (!s.denied) s.denied = [];
      let h = '<div class="section"><h4>已批准路径（本次会话，allow）</h4><div class="list">';
      if (!s.approved.length) h += '<div class="item">（无）</div>';
      s.approved.forEach(p => { h += '<div class="item">✅ '+esc(p)+'</div>'; });
      h += '</div></div>';
      h += '<div class="section"><h4>已拒绝路径（本次会话，deny）</h4><div class="list">';
      if (!s.denied.length) h += '<div class="item">（无）</div>';
      s.denied.forEach(p => { h += '<div class="item">🚫 '+esc(p)+'</div>'; });
      h += '</div></div>';
      h += '<button class="btn btn-danger" onclick="clearSession()">清空本次会话记忆</button>';
      h += '<div class="foot">清空后，所有路径重新按全局/项目策略判定（即“强制按新策略重算”）。重启编辑器后本会话记忆自动消失。</div>';
      return h;
    }

    function renderPreview() {
      const m = state.merged;
      let h = '<div class="preview"><div class="legend">合并预览（只读）｜<b class="g">🔵全局</b> <b class="w">🟢项目</b> <b class="s">🟠会话</b></div>';
      h += '<div class="preview-item">受信任目录：工作区文件夹 '+(state.workspaceFolders.length?state.workspaceFolders.map(esc).join("、"):"（无）')+'</div>';
      h += '<div class="preview-item">额外信任目录：'+(m.trustedDirs.length?m.trustedDirs.map(esc).join("、"):"（无）')+'</div>';
      h += '<div class="preview-item">命令免审批白名单：'+(m.executeAllowlist.length?m.executeAllowlist.map(esc).join("、"):"（空：所有命令需审批）')+'</div>';
      h += '<div class="preview-item">兜底：未知工具默认 需要审批</div>';
      h += '</div>';
      return h;
    }

    function render() {
      const content = document.getElementById("content");
      let h = renderPreview();
      if (currentLayer === "session") {
        h += renderSession();
      } else {
        h += renderLayer(currentLayer);
      }
      content.innerHTML = h;
      bindSelects();
    }

    function bindSelects() {
      document.querySelectorAll('select[data-tool]').forEach(sel => {
        sel.addEventListener('change', () => {
          const tool = sel.getAttribute('data-tool');
          const scope = sel.getAttribute('data-scope');
          const arr = currentLayer === "global" ? state.global : state.workspace;
          const target = arr[scope];
          const i = target.findIndex(r => r.tool === tool);
          if (i >= 0) target[i].action = sel.value;
          else target.push({ tool, action: sel.value });
        });
      });
      document.querySelectorAll('button[data-deldir]').forEach(b => {
        b.addEventListener('click', () => {
          const i = parseInt(b.getAttribute('data-deldir'), 10);
          const arr = currentLayer === "global" ? state.global : state.workspace;
          arr.trustedDirs.splice(i, 1);
          render();
        });
      });
      document.querySelectorAll('button[data-delallow]').forEach(b => {
        b.addEventListener('click', () => {
          const i = parseInt(b.getAttribute('data-delallow'), 10);
          const arr = currentLayer === "global" ? state.global : state.workspace;
          if (!arr.executeAllowlist) arr.executeAllowlist = [];
          arr.executeAllowlist.splice(i, 1);
          render();
        });
      });
      document.querySelectorAll('button[data-savelayer]').forEach(b => {
        b.addEventListener('click', () => saveLayer(b.getAttribute('data-savelayer')));
      });
    }

    window.addDir = function() {
      const inp = document.getElementById('newDir');
      const v = inp.value.trim();
      if (!v) return;
      const arr = currentLayer === "global" ? state.global : state.workspace;
      if (!arr.trustedDirs) arr.trustedDirs = [];
      if (arr.trustedDirs.indexOf(v) < 0) arr.trustedDirs.push(v);
      inp.value = "";
      render();
    };

    window.addAllow = function() {
      const inp = document.getElementById('newAllow');
      const v = inp.value.trim();
      if (!v) return;
      const arr = currentLayer === "global" ? state.global : state.workspace;
      if (!arr.executeAllowlist) arr.executeAllowlist = [];
      if (arr.executeAllowlist.indexOf(v) < 0) arr.executeAllowlist.push(v);
      inp.value = "";
      render();
    };

    window.saveLayer = function(layerKey) {
      const cfg = layerKey === "global" ? state.global : state.workspace;
      vscode.postMessage({ type:"updateLayer", layer: layerKey, config: clone(cfg) });
    };

    window.clearSession = function() {
      vscode.postMessage({ type:"clearSession" });
    };

    document.querySelectorAll('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentLayer = tab.getAttribute('data-layer');
        render();
      });
    });

    window.addEventListener('message', (event) => {
      const m = event.data;
      if (m.type === "state") {
        state = m;
        render();
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

/** Open (or reveal) the permissions settings webview. */
export function openPermissionsPanel(): void {
  PermissionsPanel.createOrShow();
}
