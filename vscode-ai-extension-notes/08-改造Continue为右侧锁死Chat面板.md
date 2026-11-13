---
title: 改造 Continue 为右侧锁死 Chat 面板
aliases:
  - 右侧锁死 Chat 面板
  - 锁死辅助栏
  - Continue 面板移到右侧
  - DISABLE_NATIVE_CHAT
tags:
  - vscode
  - fork
  - workbench
  - continue
  - webview
  - 复现记录
created: 2026-10-27
related:
  - "[[01-实现一个类Continue的带界面插件]]"
  - "[[02-Continue如何实现VSCode钩子与接口]]"
  - "[[03-VSCode-Webview-API]]"
  - "[[04-VSCode-Chat-Participant-API]]"
---

# 改造 Continue 为右侧锁死 Chat 面板

> [!abstract] 一句话
> 目标:在自己的 **VS Code OSS fork** 里,①禁用原生 Chat 视图;②把 Continue 扩展的 webview 面板从左侧活动栏挪到**右侧辅助栏(Secondary Side Bar)**;③把这个面板**锁死**——拖不走、右键不能移动、命令/API 也移不动。Continue 的 GUI / Agent-Harness / provider **一行业务代码都不用改**,因为"面板显示在哪"和"面板里跑什么"是两件独立的事。

> [!info] 这份文档的用途
> 升级 Continue 或 VS Code 到新版本后,用它快速**重新定位改动点并复现**。所有改动都走**源码**(`src/vs/**` 与扩展 `package.json`),**绝不改打包产物** `workbench.desktop.main.js`(一重新编译就被覆盖,且混淆符号/字节偏移无法长期维护)。

---

## 0. 环境与仓库

| 角色                             | 路径                                                           |
| -------------------------------- | -------------------------------------------------------------- |
| VS Code OSS fork(workbench 源码) | `d:\soft\Kiro_back\My-Agent-editor\vscode`                     |
| Continue 扩展工程                | `d:\soft\Kiro_back\My-Agent-editor\continue\extensions\vscode` |

> [!warning] 为什么这套只在 fork 里成立
> 用 `contributes.viewsContainers.secondarySidebar` 作为贡献 key(直接落右侧)依赖本 fork 的扩展点处理器 `viewsExtensionPoint.ts` 支持三种 key(`activitybar`/`panel`/`secondarySidebar`)。标准发行版 VS Code 的扩展点只认 `activitybar`/`panel`,换标准 VS Code 不成立。

---

## 1. 改动总览(升级后按这张表逐项复现)

| #   | 文件                                                           | 改什么                                                              | 必要性         | 备注                                              |
| --- | -------------------------------------------------------------- | ------------------------------------------------------------------- | -------------- | ------------------------------------------------- |
| A   | `vscode` · `chat/browser/chatParticipant.contribution.ts`      | 用 `DISABLE_NATIVE_CHAT` 开关跳过原生 chat 视图 `registerViews`     | 禁用原生 chat  | 容器注册保留,`hideIfEmpty` 让空容器永不渲染       |
| B   | `continue` · `extensions/vscode/package.json`                  | `continue` 容器 `activitybar` → `secondarySidebar`                  | 面板落右侧     | **唯一的扩展侧改动**;provider/GUI/views 不动      |
| C   | `vscode` · `workbench/common/views.ts`                         | 新增 `CHAT_LOCKED_VIEW_CONTAINER_ID` + `isLockedToAuxiliaryBar()`   | 锁死(集中常量) | 其余三处统一引用它,避免 id 字符串散落             |
| D   | `vscode` · `services/views/browser/viewDescriptorService.ts`   | `moveViewContainerToLocation` 开头加锁定守卫                        | 锁死(**核心**) | 单点覆盖拖拽 / 右键菜单 / 命令 / API 所有移动入口 |
| E   | `vscode` · `browser/parts/compositeBar.ts`                     | `canDrop` 对锁定容器返回 `false`                                    | 锁死(UX)       | 拖拽时不显示可放下的高亮                          |
| F   | `vscode` · `browser/parts/paneCompositeBar.ts`                 | `getContextMenuActionsForComposite` 对锁定容器直接返回              | 锁死(UX)       | 右键菜单不出现 "Move To / Reset Location"         |
| G   | `vscode` · `browser/parts/auxiliarybar/auxiliaryBarActions.ts` | 用 `SHOW_AUXILIARYBAR_CLOSE_BUTTON = false` 跳过标题栏 X 的菜单注册 | 防误关         | 移除右上角 X,避免用户误点隐藏面板(见 §5.1)        |

> [!tip] 哪些**不用改**(升级后不要被带偏)
>
> - **(位置默认)** `getViewContainerLocation` / `getDefaultViewContainerLocation` **不用改**:用 `secondarySidebar` 贡献点后容器注册时就落右侧。
> - **(右侧默认展开)** `workbench.secondarySideBar.defaultVisibility` 默认值已是 `visibleInWorkspace`(定义于 `platform/theme/electron-main/themeMainServiceImpl.ts`),打开 workspace 即自动展开。**空工作区仍隐藏**(见 §6)。
> - **(自定义 composite)** 默认 `ViewPaneContainer` + `mergeViewWithContainerWhenSingleView` 渲染单个 webview 已够用,除非要去标题栏/自定义布局。
> - **(Continue 侧)** webview view 声明、`registerWebviewViewProvider`、React GUI、Agent-Harness、所有 `when` 子句与 `continue.continueGUIView.focus` 命令——**全部不动**。

---

## 2. 核心心智模型

> [!note] 两条互不相干的链路
> **原生 chat 链路**:原生输入框 `@agent` → `IChatAgentService` 路由 → 渲染在原生 chat 视图。由 `chatParticipants` 贡献点驱动。
> **自建 webview 链路**:Continue React UI → `postMessage` → 扩展主进程 → 自己的会话/工具/Harness → `postMessage` 回传 → React 自己渲染。**不经过** `IChatAgentService`。
>
> 两条链路不共享任何东西。所以:①禁用原生 chat 不影响 Continue 的 webview;②`chatParticipants` 的 agent **不会**出现在你的 webview 里(别指望注册 participant 就能在自己面板里用,那是两码事);③把 Continue 面板挪到右侧只改"显示位置",`postMessage` 管道一字未变,Harness 照常工作。

---

## 3. 改动 A — 禁用原生 Chat 视图

**文件**:`vscode/src/vs/workbench/contrib/chat/browser/chatParticipant.contribution.ts`

**关键事实(定位锚点)**:

- 容器注册带 `hideIfEmpty: true` 和 `doNotRegisterOpenCommand: true`。
- 视图描述符 `chatViewDescriptor` 自带 `openCommandActionDescriptor`(含快捷键 `Ctrl+Alt+I`)——所以快捷键是随**视图注册**一起注册的,跳过 `registerViews` 会一并移除(预期行为)。
- 常量来自 `chat.ts`:`ChatViewId = 'workbench.panel.chat.view.copilot'`(`CHAT_PROVIDER_ID='copilot'`),`ChatViewContainerId = 'workbench.panel.chat'`。

**改法**:在文件顶部加开关,把 `registerViews` 调用包进条件里(保留容器注册与 `chatViewDescriptor` 定义本身,方便切回):

```typescript
// 本 fork 为了使用自定义 chat 面板而禁用原生 chat 视图注册。设为 true 时跳过下方 registerViews 调用,
// 容器仍注册但变为空容器(hideIfEmpty 使其永不渲染)。改回 false 即可恢复原生 chat 视图。
const DISABLE_NATIVE_CHAT = true;

// ...(容器注册、chatViewDescriptor 定义保持不动)...

if (!DISABLE_NATIVE_CHAT) {
  Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews(
    [chatViewDescriptor],
    chatViewContainer,
  );
}
```

**为什么安全(残留引用都静默失效)**:跳过后容器成空容器 → `hideIfEmpty` 让它永不渲染;`doNotRegisterOpenCommand` 让它没有打开命令。所有指向 `workbench.panel.chat.view.copilot` / `workbench.panel.chat` 的残留引用:

- 菜单 `when: view == ...` → 永不匹配,静默隐藏。
- 视图服务 API(`openView`/`getViewWithId`/`getViewLocationById`/`isViewVisible`)→ 视图未注册时返回 `null`/`false`/`undefined`,不抛异常。
- 语音模块 focus 命令(`voiceSessionController.ts` 的 `executeCommand('...focus')`)→ 带 `.catch` 的 fire-and-forget,静默失败。
- 仅两处强制 `as ChatViewPane` 未判空(`chatMoveActions.ts`、`chatActions.ts`),低概率、非启动路径、被命令框架捕获;**本次未修补**,升级后如要更稳可顺手加判空。

> [!tip] 升级后怎么重新定位 A
> 搜 `registerViews([chatViewDescriptor]`;若 `chatViewDescriptor` 被重命名,搜 `ViewsRegistry).registerViews(` 并找带 chat 容器那次调用。

---

## 4. 改动 B — Continue 容器挪到右侧(唯一扩展侧改动)

**文件**:`continue/extensions/vscode/package.json`

```jsonc
"viewsContainers": {
  "secondarySidebar": [            // ← 原来是 "activitybar"
    { "id": "continue", "title": "Continue", "icon": "media/sidebar-icon.png" }
  ],
  "panel": [
    { "id": "continueConsole", "title": "Continue Console", "icon": "$(window)" }
  ]
}
```

> [!important] 容器短 id 与 workbench 常量的契约
> 短 id `continue` → 运行时完整 id `workbench.view.extension.continue`(规则:`workbench.view.extension.<短id>`)。这个完整 id **必须**和改动 C 的 `CHAT_LOCKED_VIEW_CONTAINER_ID` 一致,否则锁定失效。若将来把短 id 改掉,两边一起改。

**不用动的部分(复用 Continue 全部基础设施)**:

- `views.continue[]` 里的 `{ type: "webview", id: "continue.continueGUIView", ... }` 不变。
- `registerWebviewViewProvider("continue.continueGUIView", sidebar, { webviewOptions: { retainContextWhenHidden: true } })`(`VsCodeExtension.ts`)不变。
- `ContinueGUIWebviewViewProvider.viewType = "continue.continueGUIView"` 不变。
- 7 处 `continue.continueGUIView.focus` 调用(`commands.ts` 等)不变——这是**与位置无关**的 view 聚焦命令,挪到右侧后照常生效。Continue 代码里本就有一行注释掉的 `workbench.action.focusAuxiliaryBar`,说明右侧是预期场景。

---

## 5. 改动 C/D/E/F — 锁死面板

### C. 集中常量 + helper

**文件**:`vscode/src/vs/workbench/common/views.ts`(放在 `ViewContainerLocationToString` 之后)

```typescript
export const CHAT_LOCKED_VIEW_CONTAINER_ID =
  "workbench.view.extension.continue";

export function isLockedToAuxiliaryBar(
  viewContainerId: string | undefined,
): boolean {
  return viewContainerId === CHAT_LOCKED_VIEW_CONTAINER_ID;
}
```

> [!tip] 升级后重新定位
> 搜 `isLockedToAuxiliaryBar` 即可找到全部 4 处引用(1 处定义 + D/E/F 各 1 处)。

### D. 核心守卫(覆盖所有移动入口)

**文件**:`vscode/src/vs/workbench/services/views/browser/viewDescriptorService.ts`
**位置**:`moveViewContainerToLocation(...)` 方法开头,`canMoveViews()` 守卫之后。

```typescript
moveViewContainerToLocation(viewContainer: ViewContainer, location: ViewContainerLocation, requestedIndex?: number, reason?: string): void {
	if (!this.canMoveViews()) {
		return;
	}
	// 本 fork:被锁定的 chat 容器固定在右侧辅助栏,禁止任何来源(拖拽/右键菜单/命令/API)移动它。
	if (isLockedToAuxiliaryBar(viewContainer.id)) {
		return;
	}
	// ...原有逻辑...
}
```

记得在该文件顶部 `from '../../../common/views.js'` 的 import 里追加 `isLockedToAuxiliaryBar`。

> [!note] 已知边界(为什么核心守卫够用)
> `moveViewContainerToLocation` 内部调 `moveViewContainerToLocationWithoutSaving`,后者还有两个**绕过守卫**的内部调用方:`reset()`(行 ~428)和 `onDidChangeLocation` 批量恢复(行 ~644)。但它们都只把容器移回**默认位置**;Continue 容器的默认位置本就是右侧,`default === current` 时不触发实际移动,**对锁定无害**。若将来默认位置变了,需重新评估是否要给 `WithoutSaving` 也加守卫。

### E. 拖拽判定(UX)

**文件**:`vscode/src/vs/workbench/browser/parts/compositeBar.ts`
**位置**:`CompositeDragAndDrop` 类的 `private canDrop(...)`,`dragData.type === 'composite'` 分支最前面。

```typescript
if (dragData.type === "composite") {
  // 本 fork:被锁定的 chat 容器不可被拖走(固定在右侧辅助栏)。
  if (isLockedToAuxiliaryBar(dragData.id)) {
    return false;
  }
  // ...原有逻辑...
}
```

import 追加 `isLockedToAuxiliaryBar`(来自 `../../common/views.js`)。

> [!warning] 曾经的过度约束(别重犯)
> 最初还加过"禁止**任何**容器拖进右侧辅助栏"(`targetContainerLocation === AuxiliaryBar → return false`),这会误伤正常功能(用户本可把 outline 等视图拖到右侧)。已回退。**只锁 chat 自己不可拖走即可**,不要连带封死整个右侧区域。

### F. 右键菜单(UX)

**文件**:`vscode/src/vs/workbench/browser/parts/paneCompositeBar.ts`
**位置**:`private getContextMenuActionsForComposite(compositeId)` 开头。

```typescript
private getContextMenuActionsForComposite(compositeId: string): IAction[] {
	const actions: IAction[] = [new Separator()];
	// 本 fork:被锁定的 chat 容器固定在右侧,不提供 "Move To / Reset Location" 菜单项。
	if (isLockedToAuxiliaryBar(compositeId)) {
		return actions;
	}
	// ...原有逻辑...
}
```

import 追加 `isLockedToAuxiliaryBar`(来自 `../../common/views.js`)。

---

## 5.1 改动 G — 移除辅助栏标题栏的 X(防误关)

**背景**:面板锁死后仍无法阻止用户点标题栏右上角那个 **X** —— 它是辅助栏标题栏的"隐藏辅助栏"按钮,点一下整个右侧(含 Continue 面板)就被隐藏,容易误触。

**文件**:`vscode/src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarActions.ts`
**位置**:`MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {...})` 那段(文件约第 76 行)。

**定位锚点**:搜 `MenuId.AuxiliaryBarTitle`。那个 X 的命令其实是 `ToggleAuxiliaryBarAction.ID`(不是 `closeAuxiliaryBar`),`icon: closeIcon`,`order: 2`,`when: config.workbench.activityBar.location == default`。

> [!note] 它是打包产物里哪段
> 对应混淆版 `oe.appendMenuItem(k.AuxiliaryBarTitle, { command:{ id: g$.ID, icon: oYe }, order:2, when: C.equals("config.workbench.activityBar.location","default") })`。`g$`=`ToggleAuxiliaryBarAction`,`oYe`=`closeIcon`。**务必在源码改,不要改 bundle。**

**改法**:用开关跳过这个菜单项的注册:

```typescript
// 本 fork:Continue 面板锁死常驻右侧辅助栏,移除标题栏右上角的 X(隐藏辅助栏)按钮,
// 避免用户误点关闭面板。设为 false 可恢复原生的关闭按钮。
const SHOW_AUXILIARYBAR_CLOSE_BUTTON = false;
if (SHOW_AUXILIARYBAR_CLOSE_BUTTON) {
  MenuRegistry.appendMenuItem(MenuId.AuxiliaryBarTitle, {
    command: {
      id: ToggleAuxiliaryBarAction.ID,
      title: localize("closeSecondarySideBar", "Hide Secondary Side Bar"),
      icon: closeIcon,
    },
    group: "navigation",
    order: 2,
    when: ContextKeyExpr.equals(
      `config.${LayoutSettings.ACTIVITY_BAR_LOCATION}`,
      ActivityBarPosition.DEFAULT,
    ),
  });
}
```

> [!caution] 已知副作用(全局性)
> 这个 X 是**辅助栏全局**的关闭按钮,不是 Continue 专属。移除后,辅助栏里**无论显示哪个容器**,标题栏都不再有 X。对"Continue 锁死常驻右侧"的产品意图这可接受;若将来辅助栏还要放别的可关闭视图,需改成在 `when` 里加"当前激活容器是否为 Continue"的判断(更复杂),而非全局移除。

> [!tip] 命名风格
> 这里用 `SHOW_... = false`(默认不显示),语义顺(`if (SHOW)` 直读)。注意它与 `DISABLE_NATIVE_CHAT = true` 是两种开关风格(一个正逻辑、一个双重否定),功能无差,统一与否看偏好。

---

## 6. 验证清单

**静态(已做)**:对改动文件做 `tsc --noEmit`(走 `src/tsconfig.json`),改动的 4 个 workbench 文件无类型/导入/未用变量错误。

> 注意:裸 `tsc` 跑 VS Code 的 tsconfig 会报大量 `Cannot find module 'electron'` / `Cannot find namespace 'Electron'` 之类**环境噪音**,与本改动无关(正式构建走 gulp)。只需确认报错里**不含**你改的文件名。

**运行时(需人工跑开发版确认)**:

1. 启动 fork 开发版(Windows:仓库根 `.\scripts\code.bat`),**打开一个文件夹(workspace)**。
2. ✅ Continue 面板出现在**右侧辅助栏**,启动即展开。
3. ✅ 拖拽面板标签 → 拖不动 / 不显示可放下高亮。
4. ✅ 右键面板图标 → **没有** "Move To" / "Reset Location"。
5. ✅ 原生 Chat 视图**不出现**(左侧/右侧都没有 chat 图标,`Ctrl+Alt+I` 无原生 chat)。
6. ✅ 面板里 Continue GUI 正常,发一条消息确认 `postMessage` 链路与 Harness 工作。
7. ✅ 面板标题栏右上角**没有 X(隐藏辅助栏)按钮** → 用户无法误点关闭(改动 G)。

> [!caution] 空工作区的例外
> `visibleInWorkspace` 语义是"打开 workspace 时展开";**空窗口(没打开文件夹)右侧仍隐藏**。若要求"任何情况首启都展开",需改 `layout.ts` 中 `AUXILIARYBAR_DEFAULT_VISIBILITY` 的消费 switch(`WorkbenchState.EMPTY` 分支),或改默认值策略。本次未做。

---

## 7. 升级 Continue / VS Code 后的复现流程

> [!summary] 推荐顺序
>
> 1. **先合并上游**,再按 §1 的表逐项套用。
> 2. **A**:搜 `registerViews([chatViewDescriptor]`,确认开关仍包住它。
> 3. **B**:确认 `package.json` 的 `continue` 容器仍在 `secondarySidebar`(上游若重排 `viewsContainers` 可能被覆盖)。
> 4. **C**:确认 `isLockedToAuxiliaryBar` 的常量值仍等于 `workbench.view.extension.<当前短id>`。
> 5. **D/E/F**:搜 `isLockedToAuxiliaryBar` 的 3 处引用是否还在;若 `moveViewContainerToLocation` / `canDrop` / `getContextMenuActionsForComposite` 被上游改名或重构,按本文"位置"描述重新落点。
> 6. **G**:搜 `SHOW_AUXILIARYBAR_CLOSE_BUTTON` 确认开关仍包住 `MenuId.AuxiliaryBarTitle` 的 X 注册;若上游重构了那段菜单项,按 §5.1 的锚点重新落点。
> 7. 跑 §6 的运行时清单做回归。

> [!danger] 红线
>
> - 永远不要改 `workbench.desktop.main.js`(打包产物)。
> - 不要用字节偏移 / 混淆符号(`tF`/`mj`/`hj`/`@xxxxxxx`)作为定位依据——它们每次构建都会变。
> - 锁定逻辑只针对 chat 容器 id,**不要**扩大到"封死整个右侧辅助栏"(见 §5-E 的教训)。
