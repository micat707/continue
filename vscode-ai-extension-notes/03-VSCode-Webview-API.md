---
title: VS Code Webview API
aliases:
  - Webview API
  - WebviewView
  - WebviewPanel
tags:
  - vscode
  - extension
  - webview
  - api
created: 2026-10-09
related:
  - "[[实现一个类 Continue 的带界面 VS Code 插件]]"
  - "[[Continue 如何实现 VS Code 的钩子与接口]]"
---

# VS Code Webview API

> [!abstract] 一句话
> Webview 是 VS Code 里的「内嵌浏览器」——一个运行在隔离沙箱里的 `<iframe>`，让你用 HTML/CSS/JS 画任意自定义界面。扩展（Node 侧）和 Webview（浏览器侧）**不共享内存**，只能通过 `postMessage` 异步通信。

---

## 1. 两种形态

| 类型             | 创建方式                             | 位置                      | 典型用途                   |
| ---------------- | ------------------------------------ | ------------------------- | -------------------------- |
| **WebviewView**  | `window.registerWebviewViewProvider` | 侧边栏 / 面板里的一块视图 | 常驻面板（如聊天侧边栏）   |
| **WebviewPanel** | `window.createWebviewPanel`          | 编辑器区的一个 Tab        | 独立页面（如设置页、预览） |

> [!note]
> Continue 的聊天界面是 **WebviewView**（常驻侧边栏），"全屏/新窗口"模式则会用到 **WebviewPanel**。两者的 `webview` 对象 API 基本一致。

---

## 2. 关键隔离模型

```mermaid
flowchart LR
    subgraph Ext[扩展进程 Node.js]
      P["WebviewViewProvider / Panel"]
    end
    subgraph WV["Webview 沙箱 (iframe/浏览器)"]
      H["你的 HTML + JS"]
    end
    P -->|webview.postMessage| H
    H -->|acquireVsCodeApi().postMessage| P
    P -. onDidReceiveMessage .- H
```

> [!important] 三条铁律
>
> 1. Webview 里**不能**直接 `require`/`import` Node 模块，也不能直接访问文件系统——要通过消息请扩展侧代办。
> 2. 本地资源（图片、脚本）必须用 `webview.asWebviewUri(...)` 转换成特殊 URI 才能加载。
> 3. 默认启用 CSP，脚本通常要带 `nonce`。

---

## 3. 最小实现（WebviewView）

### 3.1 package.json 声明

```jsonc
"contributes": {
  "viewsContainers": {
    "activitybar": [{ "id": "myAgent", "title": "My Agent", "icon": "media/icon.svg" }]
  },
  "views": {
    "myAgent": [{ "type": "webview", "id": "myAgent.chatView", "name": "Chat" }]
  }
}
```

### 3.2 实现 Provider

```ts
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "myAgent.chatView";
  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView) {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "gui")],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((msg) => {
      /* 处理界面消息 */
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "gui/assets/index.js"),
    );
    const nonce = getNonce();
    return /* html */ `<!DOCTYPE html>
      <html><body>
        <div id="root"></div>
        <script>const vscode = acquireVsCodeApi();</script>
        <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
      </body></html>`;
  }
}
```

### 3.3 注册

```ts
context.subscriptions.push(
  vscode.window.registerWebviewViewProvider(
    ChatViewProvider.viewType,
    provider,
    { webviewOptions: { retainContextWhenHidden: true } }, // 隐藏时不销毁 DOM
  ),
);
```

---

## 4. 通信：`postMessage`

### 4.1 扩展 → Webview

```ts
view.webview.postMessage({ type: "chat/token", text: "你" });
```

### 4.2 Webview → 扩展

```ts
// 前端
const vscode = acquireVsCodeApi();
vscode.postMessage({ type: "chat/send", text: "你好" });
```

### 4.3 请求-响应配对（裸 API 没有，要自己做）

VS Code 的 `postMessage` 是**单向广播**，没有「这条回包对应哪条请求」的概念。常见做法是自己加一个 `messageId`：

```ts
// 发：带上唯一 id
const id = uuidv4();
webview.postMessage({ messageType, data, messageId: id });
// 收：按 id 匹配回包
webview.onDidReceiveMessage((msg) => {
  if (msg.messageId === id) resolve(msg.data);
});
```

> [!tip] Continue 的做法
> `webviewProtocol.ts` 的 `VsCodeWebviewProtocol` 就是这套封装：`send/on/request` + `messageId`，还额外支持**流式**（检测 `Symbol.asyncIterator`，逐 token `respond({done:false,...})`）。见 [[Continue 如何实现 VS Code 的钩子与接口#5 通信接口：三层两条总线]]。

---

## 5. 状态保持

| 选项                               | 效果                                           |
| ---------------------------------- | ---------------------------------------------- |
| `retainContextWhenHidden: true`    | 视图隐藏时保留整个 DOM/JS 状态（省心但吃内存） |
| `vscode.setState()` / `getState()` | 轻量持久化少量状态，视图重建后可恢复           |

> [!warning] > `retainContextWhenHidden` 开着会一直占内存。界面重时才用；轻界面优先用 `setState/getState`。

---

## 6. 常见坑

- [ ] **资源 404**：忘了 `asWebviewUri`，或 `localResourceRoots` 没包含该目录。
- [ ] **脚本被 CSP 拦**：缺 `nonce` 或 CSP meta 写错。
- [ ] **消息丢失**：Webview 还没加载完就 `postMessage`。Continue 的 `request()` 用重试循环等待 `this.webview` 就绪。
- [ ] **内存泄漏**：Provider/监听器没 `push` 进 `context.subscriptions`。

---

## 7. 开发期热更新技巧

生产加载打包产物，开发指向 dev server，实现前端热更新：

```ts
const scriptUri = inDev
  ? "http://localhost:5173/src/main.tsx" // Vite dev server
  : webview.asWebviewUri(join(extensionUri, "gui/assets/index.js"));
```

> 这正是 Continue `getSidebarContent` 的做法。

## 相关笔记

- [[实现一个类 Continue 的带界面 VS Code 插件]]
- [[Continue 如何实现 VS Code 的钩子与接口]]
- [[VS Code Chat Participant API]]
