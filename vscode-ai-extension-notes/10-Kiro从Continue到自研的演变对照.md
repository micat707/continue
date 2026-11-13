---
title: Kiro 从 Continue 到自研的演变对照
aliases:
  - Kiro 演变对照
  - Kiro vs Continue
  - kiro-agent 贡献点演变
  - acpChat 过渡
tags:
  - vscode
  - fork
  - continue
  - kiro
  - 逆向对照
created: 2026-10-27
related:
  - "[[08-改造Continue为右侧锁死Chat面板]]"
  - "[[02-Continue如何实现VSCode钩子与接口]]"
  - "[[01-实现一个类Continue的带界面插件]]"
---

# Kiro 从 Continue 到自研的演变对照

> [!abstract] 一句话
> 对比机器上两个版本的 Kiro 扩展清单(`kiro.kiro-agent/package.json`),可以清楚看到 Kiro **从"打包 Continue 源码当底座"演变到"完全自研、清除 Continue 痕迹"**的路径。这条路和我们自己的改造方向高度重合——我们当前阶段 ≈ Kiro 旧版的中间态,我们笔记里的目标结构 ≈ Kiro 新版。

> [!info] 数据来源(均在工作区外,只能用 shell 读)
>
> - 旧版:`D:\soft\Kiro_back\resources\app\extensions\kiro.kiro-agent\package.json` → **v0.3.401**,含 26 处 `continue`
> - 新版:`D:\soft\Kiro\resources\app\extensions\kiro.kiro-agent\package.json` → **v1.1.294**,**0 处** `continue`
>   两者都是单行压缩 JSON,下面的片段是用正则提取后整理的。

---

## 1. 演变总览

```
【旧版 0.3.401 · 基于 Continue】
  workspaces: packages/continuedev/{core,extension,gui}  ← 直接打包 Continue 源码
  容器短 id : "continue"(title 改成 "Chat")
  webview   : kiroAgent.continueGUIView
  激活事件  : onView:continueGUIView
  灰度开关  : kiroAgent.experiments.acpChat
              ├─ 关 → kiroAgent.continueGUIView(Continue 老 UI)
              └─ 开 → kiroAgent.acpChatView(自研新 UI)
                    │
                    ▼(实验转正,砍掉 Continue)
【新版 1.1.294 · 完全自研】
  workspaces: 无 continuedev/*     ← Continue 源码清零
  容器短 id : "chat"               ← 从 continue 改名
  webview   : kiroAgent.chatView / kiroAgent.standaloneChatView
  激活事件  : 无 onView:continueGUIView
  新增能力  : workflows 容器 / spec-review / session-details 等
```

> [!tip] 和我们自己改造的对应关系
>
> - [[08-改造Continue为右侧锁死Chat面板]] 里我们**保留容器短 id `continue`、复用 Continue GUI** → 对应 **Kiro 旧版 0.3.401 的中间态**。
> - 笔记早期设想的 `chat` 容器 + `myAgent.chatView` / `myAgent.standaloneChatView` → 几乎就是 **Kiro 新版 1.1.294 的结构**(它用 `chat` + `kiroAgent.chatView` / `kiroAgent.standaloneChatView`)。
>   两条路我们都踩在 Kiro 走过的轨迹上:先借 Continue 快速起步,再逐步自研替换。

---

## 2. 逐字段对照

| 字段                       | 旧版 0.3.401(基于 Continue)                                     | 新版 1.1.294(自研)                                           |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `version`                  | 0.3.401                                                         | 1.1.294                                                      |
| `main`                     | `./dist/extension.js`                                           | `./dist/extension.js`(不变)                                  |
| `continue` 出现次数        | 26                                                              | **0**                                                        |
| **workspaces** 含 Continue | `packages/continuedev/core`、`/extension`、`/gui`               | **全部移除**                                                 |
| **容器(activitybar)**      | `continue`(title "Chat")、`kiro`、`powers`                      | `chat`、`kiro`、`workflows`、`powers`                        |
| **chat webview view**      | `kiroAgent.continueGUIView` / `kiroAgent.acpChatView`(实验切换) | `kiroAgent.chatView` / `kiroAgent.standaloneChatView`        |
| **chat 激活事件**          | `onView:continueGUIView`                                        | 已删除                                                       |
| **共享 UI 包**             | `kiro-ui-agent-chat`、`webview-components`、`hook-editor`       | 同左 + `spec-review`、`kiro-ui-session-details`、`workflows` |

---

## 3. 关键片段(逆向提取)

### 3.1 旧版:continue 容器下的 webview(灰度中间态)

```jsonc
"viewsContainers": {
  "activitybar": [
    { "id": "continue", "title": "Chat", "icon": "" },   // ← 容器短 id 仍是 continue
    { "id": "kiro", "title": "Kiro", "icon": "./packages/kiricons/src/kiro.svg" },
    { "id": "powers", "title": "Powers", "icon": "$(powers)" }
  ],
  "panel": [ { "id": "kiroDevPanel", "title": "ACP Debug", "icon": "$(debug)" } ]
}

// continue 容器里挂两个 webview,用实验开关切换新旧 UI:
"continue": [
  { "type": "webview", "id": "kiroAgent.continueGUIView", "name": "", "visibility": "visible",
    "when": "!kiroAgent.experiments.acpChat" },     // 开关关 → Continue 老 UI
  { "type": "webview", "id": "kiroAgent.acpChatView", "name": "", "visibility": "visible",
    "when": "kiroAgent.experiments.acpChat" }        // 开关开 → 自研新 UI
]
```

> [!note] 这个 `when: experiments.acpChat` 是教科书级的迁移手法
> 同一个容器里放新旧两个 webview,用一个实验 context key 控制显示哪个。灰度期间两套并存、可随时回退;实验转正后删掉老的、砍掉开关。**我们若要从"复用 Continue GUI"过渡到"自研 UI",可以照搬这个 `when` 开关模式**,避免一刀切。

### 3.2 新版:chat 容器 + 自研 webview

```jsonc
"viewsContainers": {
  "activitybar": [
    { "id": "chat", "title": "Chat", "icon": "./packages/kiricons/src/kiro.svg" },  // ← 改名为 chat
    { "id": "kiro", "title": "Kiro", "icon": "./packages/kiricons/src/kiro.svg" },
    { "id": "workflows", "title": "Workflows", "icon": "$(list-tree)" },
    { "id": "powers", "title": "Powers", "icon": "$(powers)" }
  ],
  "panel": [ { "id": "kiroDevPanel", "title": "ACP Debug", "icon": "$(debug)" } ]
}

// 自研 chat 相关 view id(Continue 痕迹清零):
// kiroAgent.chatView / kiroAgent.standaloneChatView
// kiroAgent.standaloneSessionDetailsView / kiroAgent.standaloneRecipeDetailView
```

---

## 4. 对我们改造的启示

> [!summary] 三条可直接借鉴
>
> 1. **容器 id 保留 `continue` 可快速起步**(旧版做法),但最终自研时会改名为 `chat`(新版做法)。我们 [[08-改造Continue为右侧锁死Chat面板]] 现在走的是前者,心里要清楚这只是过渡态。
> 2. **用 `when: <实验 context key>` 在同一容器里并存新旧 webview**(§3.1),是从"复用 Continue GUI"平滑过渡到"自研 UI"的标准手法,支持随时回退。
> 3. **命令/view 统一加 `kiroAgent.` 前缀,但底层可暂时保留 Continue 的 context key**(如旧版 `continue.quickEditHistoryFocused`),逐步替换。

> [!caution] 两个差异点,别照抄
>
> - Kiro(新旧版)的 chat 容器都放在 **`activitybar`(左侧)**;我们的需求是 **`secondarySidebar`(右侧)+ 锁死**,这是我们独有的,见 [[08-改造Continue为右侧锁死Chat面板]]。
> - Kiro 是完整产品(含 specs / hooks / steering / mcp / workflows 等一大套),我们只需 chat 面板,不必照搬它那一堆容器和 view。

> [!danger] 来源与合规提醒
> 以上均为对本机已安装产物的**清单(package.json)**做结构性观察,用于理解"基于 Continue 改造"的通用做法。仅作架构参考,不复制其具体实现代码。

#vscode #continue #kiro #逆向对照
