# 多会话真并发架构重构设计

> 目标：让 Continue fork（My-Agent-editor）支持"会话1 在后台继续流式生成的同时，
> 切到会话2 独立发消息"，且回答/审批卡/状态条不串会话。
>
> 现状：当前工作区挂着一轮**未提交**的补丁式真并发实现（sessionRuntimes + park/restore），
> 经 6 轮实测仍出新问题（内容碎片、session id 乱跳、tab 错绑）。本设计是**停下补丁、
> 从架构层重新规划**的产物。稳定基线 checkpoint：`3c47a7afc`（最小版，3 个原始问题已验证通过）。

---

## 0. 结论先行

**当前架构无法靠补丁实现真并发。** 原因不是某个 bug，而是三层结构性错配：

1. **后端是单 webview 指针**：`webviewProtocol` 只有一个 listener Map + 一个可变 `_webview` 指针，
   sidebar 与全屏 panel 抢占同一个指针。A 会话的流式响应会被 post 到当前显示的 B webview。
2. **模型 wrapper 是单例 + 全局闭包状态**：`approvedPaths`、`sessionChangedFiles`、
   `activeSessionPermissions`、`activeTurnAbort` 都是单槽；会话隔离靠"本轮 messages 没有
   assistant 消息 ⇒ 认为是新会话 ⇒ 清空所有状态"的启发式。两个流并发时互相清空。
3. **前端状态是单 `state.session`**：tab↔session 绑定完全靠 React effect（`handleSessionChange`）
   隐式维护，任何地方 `newSession()` 都会隐式增删 tab。新 tab 的 `sessionId` 会是 `undefined`
   后被回填，切 tab 时序极易错绑。

Kiro 能保证真并发，是因为它做了三件 Continue 没有的事（本地逆向已证实）：

- 后端 `Map<sessionId, ViewProvider>` 路由（`extension.js:675468-675477`）；
- 所有事件统一带 `sessionId`（`triggerAgentChatEvent` / `triggerOnPermissionRequest`）；
- 前端单 active 会话切换器（`session-manager/main.js` 的 `activeSessionId` + `onSwitchSession`）。

**Kiro 的 sidebar 也是"单 webview 管多会话、按 sessionId 切 active"**，不是多 webview 并发渲染。
所以可借鉴的正确模型是：**后端按 session 隔离 runtime + 前端单 active 切换 + 每会话完整状态容器**。

---

## 1. 现状精确盘点（带证据）

### 1.1 前端 Redux（`gui/src/redux/`）

- `store.ts:26-34`：7 个 slice `{ session, ui, editModeState, config, indexing, tabs, profiles }`。
- `store.ts:36-72`：redux-persist 白名单——`session` 只持久化
  `id,lastSessionId,title,mode,history`；`tabs` 只持久化 `tabs`。IDE 磁盘副本是权威源。
- `sessionSlice.ts:300-339`：`SessionState` 是**单个可见会话**的字段集合：
  - 已尝试隔离（补丁引入）：`sessionRuntimes?: Record<string, SessionRuntime>`、`activeStreamSessionId?`；
  - **仍是全局单例、未隔离**：`symbols`、`isInEdit`、`mainEditorContentTrigger`、
    `newestToolbarPreviewForInput`、`hasReasoningEnabled`、`isPruned`、`contextPercentage`、
    `inlineErrorMessage`、`compactionLoading`。
- `sessionSlice.ts` 有 **45 个 action**、4 个 selector；当前补丁通过
  `streamTarget(state, explicitId?)`（L76-86）+ `selectStreamSessionState`（L1346-1367）
  在前台会话与 parked runtime 之间路由写入。
- `tabsSlice.ts:3-12`：`Tab { id, title, isActive, sessionId? }`；无独立 activeTab 字段；
  `handleSessionChange`（L57-127）四分支维护 tab↔session 绑定。

### 1.2 tab↔session 绑定（风险点）

- `TabBar.tsx:235-245`：监听 `session.id/title` 变化 → `handleSessionChange`（唯一入口）。
- `TabBar.tsx:268-286` `handleNewTab`：`saveCurrentSession` → `newSession()` → `addTab({sessionId: undefined})`，
  sessionId 靠 effect 事后回填。
- `TabBar.tsx:294-309` `handleTabClick`：仅当 `targetTab.sessionId` 存在才 `loadSession`；
  否则只 `setActiveTab`（复用当前 session，危险）。
- 所有 thunk 里的 `newSession()`（session.ts:107/153/165/219、edit.ts:110、error.tsx:43、
  History/index.tsx:138）都会隐式驱动 tab 增删。

### 1.3 后端协议与路由（`core/protocol/`, `extensions/vscode/src/`）

- 协议（`core.ts:212-255`, `ideWebview.ts:98-217`）：
  - `llm/streamChat` 的 sessionId **只藏在** `messageOptions.chatSessionId?`（补丁引入，顶层无）；
  - `abort`、`llm/complete`、`chatDescriber/describe`、`deepagentExecuteProgress`、
    `deepAgent/permissions/*`、`getChangedFiles`、`tools/call`、`deepAgentInterruptResponse`
    **都不带 sessionId**。
- `webviewProtocol.ts:13-16,43-49,119`：单 `listeners: Map<type, handler[]>`、单 `_webview` 指针、
  单 `onDidReceiveMessage`；`request()` 响应只在当前 webview 上匹配 `messageId`。
- `ContinueGUIWebviewViewProvider.ts:14,25-36,137` + `commands.ts:286-310,625`：
  sidebar 与全屏 panel 共享 protocol，可见性变化/打开 panel 时抢占 `_webview` 指针。
- `DeepAgentChatPanel.ts:97,123,262-266`：另一条旁路，`static current` 全局单例。

### 1.4 模型 wrapper 与审批（破坏点）

- `commands.ts:112-124` `applyDeepAgentWrap`：wrapper 写回 `config.selectedModelByRole.chat`，**单例**。
- `DeepAgentLLM.ts:145-207` `wrapWithDeepAgent`：
  - 每次调用建一个 adapter/agent（OK）；
  - 但 `approvedPaths/approvedReadPaths/deniedPaths/sessionPolicy` 是闭包状态；
  - `sessionChangedFiles`（L138）、`activeSessionPermissions`（L77）是模块全局；
  - `setActiveTurnAbort(_signal)`（L404）单槽；
  - **L416-426 用"无 assistant 消息即新会话"启发式清空状态**——并发第一破坏点。
  - `streamChat` 里 `chatSessionId = _messageOptions?.chatSessionId`（L392）每次独立捕获（正确，可保留）。
- `ContinueLLMAdapter.ts:86-87,128-130,153`：`currentSessionId` 模块级 last-writer-wins；
  `sessionId` 每 adapter 一个但主链路随单例 wrapper，日志串台。
- `workspaceBackend.ts:1107-1122`：`pendingExecuteRunId` / `activeTurnAbort` 单槽。
- `hitlBridge.ts:39,55-112`：`pending: Map<requestId, ...>` resolve 隔离**合格**，可保留；
  但只有单个 `protocol` 引用，`cancelHitlDecision`（L118-127）`pending.clear()` 会取消所有会话。

---

## 2. 目标架构

采用与 Kiro 对齐的 **"后端按 session 隔离 + 前端单 active 切换"** 模型：

```
┌─────────────────────────────── GUI（单 webview） ───────────────────────────────┐
│  tabs: Tab[] (tabId → sessionId)         sessionStore: Map<sessionId, Session>   │
│  activeSessionId ───────────────────────────► 当前显示的会话（渲染源）           │
│  每个 Session 完整持有：history/isStreaming/toolCalls/applyStates/aborter/草稿... │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │ 所有消息带 sessionId
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│  webviewProtocol: Map<sessionId, { webview?, listeners, pendingRequests }>        │
│  或（保持单 webview）：所有请求/响应 envelope 统一带 sessionId，按 id 分发         │
└───────────────────────────────┬───────────────────────────────────────────────────┘
                                │
┌───────────────────────────────▼───────────────────────────────────────────────────┐
│  后端 session runtime: Map<sessionId, {                                          │
│    agent, modelAdapter, approvedPaths, sessionChangedFiles, activeAbort,          │
│    pendingHitl: Map<requestId,...>, executeRunId                                  │
│  }>                                                                              │
└───────────────────────────────────────────────────────────────────────────────────┘
```

**核心原则（Kiro 经验）**：归属做成**数据**（每消息/每动作显式带 sessionId），
不靠**全局可变指针**（当前 webview、`activeSessionPermissions`、`activeStreamSessionId`）。

### 两条可选子路径（需在动手前拍板）

- **路径 A（推荐，改动更小）**：保持**单 webview**，但把协议 envelope 全部加 `sessionId`，
  后端用 `Map<sessionId, runtime>` 分发；前端把 `state.session` 换成 `sessionStore[activeSessionId]`。
  Kiro 的 sidebar 正是这种（单 webview + active 切换）。
- **路径 B（改动最大）**：真正多 webview/panel，每会话一个 ViewProvider。
  与 Kiro 的 editor 会话一致，但要重写 `webviewProtocol`、`commands.ts` 的 panel 管理，
  工作量约为路径 A 的 2 倍。

> 本设计以下按**路径 A**估算；路径 B 的增量在 §6 单列。

---

## 3. 分层改造方案（路径 A）

### 阶段 0：回退与基线（0.5 人日）

- `git stash` 或 `git checkout -- <12 files>` 丢弃当前补丁式真并发改动。
- 确认 HEAD = `3c47a7afc`，跑一次三场景回归（审批卡/串话/spurious abort）建立信任基线。

### 阶段 1：协议层——所有消息带 sessionId（2 人日）

文件：`core/protocol/core.ts`、`ideWebview.ts`、`webview.ts`、`core/index.d.ts`。

- 定义统一 envelope：`{ sessionId: string; requestId?: string; payload: ... }`；
- 给 `llm/streamChat`(顶层)、`abort`、`llm/complete`、`chatDescriber/describe`、
  `llm/compileChat`、`deepagentExecuteProgress`、`deepAgent/permissions/*`、
  `getChangedFiles`、`tools/call`、`deepAgentInterruptResponse` 全部补 `sessionId`；
- `deepagentExecuteProgress` 由 `runId` 升级为 `{ sessionId, runId }`；
- `deepAgentInterruptResponse` 回传 `sessionId + requestId`。

### 阶段 2：后端 runtime 按 session 隔离（3 人日）

文件：`DeepAgentLLM.ts`、`ContinueLLMAdapter.ts`、`workspaceBackend.ts`、
`VsCodeMessenger.ts`、`commands.ts`、`webviewProtocol.ts`。

- 建立 `Map<sessionId, SessionRuntimeState>`，把闭包状态迁入：
  `approvedPaths/deniedPaths/sessionPolicy`、`sessionChangedFiles`、`activeSessionPermissions`、
  `activeTurnAbort`、`pendingExecuteRunId`；
- 删除 `DeepAgentLLM.ts:416-426` 的"无 assistant 消息即新会话"启发式；
- `ContinueLLMAdapter.ts` 去掉模块级 `currentSessionId`（日志改为参数传入）；
- `applyDeepAgentWrap` 从"写回单例 model"改为"按 session 取/建 wrapper"；
- `webviewProtocol.ts`：若走路径 A，保留单 listener，但 `request()`/响应按 envelope 的
  `sessionId` 分发；`ContinueGUIWebviewViewProvider` 的指针抢占加 sessionId 校验。

#### 阶段 2 实际实施记录（2026-11-20）

已落地：

- `DeepAgentLLM.ts`：把原 `wrapWithDeepAgent` 的整段闭包（adapter/权限状态/agent/streamChat）
  抽成 `buildSessionRuntime(underlying, rootOverride, sessionId, onInvoke)`；外层
  `wrapWithDeepAgent` 保留为单例 wrapper（core 持有固定引用），按
  `messageOptions.sessionId` 路由到 `Map<sessionId, SessionRuntime>`，首次使用时创建。
  → 每个会话有**独立的 agent + approvedPaths/approvedReadPaths/deniedPaths/sessionPolicy/merged**。
- 删除「本轮无 assistant 消息 ⇒ 清空审批记忆 + changedFiles」启发式（原 L411-427）；
  状态隔离已由 per-session runtime 保证，不再靠首轮猜测。
- `activeSessionPermissions` 升级为 `sessionPermissionHandles: Map<sessionId, handle>`，
  新增 `getSessionPermissionHandle(sessionId?)`；全局 `impl` 退化为「最近使用会话」指针，
  供单页权限面板兼容。`buildPermissionsState(sessionId?)` / clearSession / getState 均可按会话寻址。
- `sessionChangedFiles` 升级为 `changedFilesBySession: Map<sessionId, Set>`；
  `getSessionChangedFiles(sessionId?)` 按 session 返回（GUI `SessionChangesSummary` 已传 sessionId）。
- `ContinueLLMAdapter.ts`：删除模块级 `currentSessionId`（「最近 adapter 覆盖所有 raw 日志 sid」的
  串台根因）；raw logger 不再伪造 sid，按会话归因交给实例级 `logApiJson(this.sessionId)`；
  顺带删除一处孤立无副作用的 `"sessionId:", this.sessionId` 表达式。

未改（有意取舍，非遗漏）：

- `workspaceBackend.ts` 的 `activeTurnAbort` / `pendingExecuteRunId` / `liveExecuteText` 仍为模块级单槽。
  理由：`execute` 工具依赖单一 `agentTerminal`，架构上本就顺序执行，两个 execute 无法真正并发；
  分片这些变量需要改 `runCommand` 签名并把 sessionId 贯穿 backend 工具链（阶段 4 工具链适配的范畴），
  当前收益低于风险。并发 execute 的 abort/runId 串扰列为已知限制。
- `webviewProtocol.ts` / `ContinueGUIWebviewViewProvider.ts` 未改。理由：单 webview 下 `request()`
  的响应已按每次请求唯一的 `messageId` 精确匹配（天然隔离），push 类 `deepagentExecuteProgress`
  已在阶段 1 加 `sessionId?` 字段、GUI 侧按 `runId` 匹配卡片。指针抢占的 sessionId 校验放到阶段 3
  单 webview 多流分发时一并处理更合适。

验证：三包 typecheck 无新增错误（core 154 / gui 517 / extensions 381，均为基线）；
esbuild 在本 IDE 沙箱受 junction "untrusted mount point" 限制，需用户本地终端构建。

### 阶段 3：前端 sessionStore 重构（4 人日）—— 实施记录（2026-11-20）

> 对应下方「阶段 3 原计划」。采用「wrapper reducer」方案达成设计目标，
> 同时把高风险面降到可控：

- `sessionSlice.ts`：
  - `SessionData` = 原 `SessionState` 的全部每会话字段；新增 `createSessionData(id)`。
  - 顶层 `SessionState = { sessions: Record<id, SessionData>; activeSessionId; isSessionMetadataLoading; allSessionMetadata }`。
  - **内层 `createSlice` 的 40+ reducer 全部零改动**（继续操作扁平 SessionData）；新增导出 `sessionReducer` wrapper：
    每个 action 按 `action.meta.sessionId`（由 `inSession(action, id)` 注入）路由到 `sessions[id]`，
    缺省落 `activeSessionId`。`newSession`/metadata action 特殊处理 activeSessionId 与全局字段同步。
  - 新增 `selectActiveSession(state)` / `selectSessionById(state, id)` / `inSession(action, id)`。
  - `selectIsGatheringContext` 重定义为基于 RootState 的版本（inner selector 类型不兼容）。
- **全量读取点改造**：56 个文件的 `state.session.<field>` → `selectActiveSession(state).<field>`
  （脚本批处理 + 逐个人工核对复杂形态：链式可选访问、整体解构、测试断言）。
- **后台 chunk 隔离**：`streamNormalInput` 的所有会话状态写入用 `inSession(..., owningSessionId)` 包装，
  后台会话的 chunk 写入自己的 `sessions[id].history`，不再串进当前显示会话。
- `loadSession` 优先用内存缓存 `sessions[id]`（有 history/正在流式时）而非磁盘，切回能看到后台流结果。
- `persist`：version 1→2，migration "2" 把旧扁平 session 转成 sessions map；
  `sessionAborterTransform` 写盘剥离 / 读盘重建 AbortController。
- 验证：三包 typecheck 无新增错误（core 154 / extensions 381 / gui **509**，低于基线 517）。

已知限制（非遗漏，属阶段 4 工具链适配范畴）：

- 工具续流 thunk（`callToolById` / `streamResponseAfterToolCall` / `handleApplyStateUpdate`）里的
  `selectCurrentToolCalls(getState())` / `getState().session.history` 仍读 active session；
  后台会话正执行工具时，工具续流的状态读写可能落到前台会话。纯文本流式（场景 1/2）已隔离，
  工具调用并发串扰留待阶段 4。
- `streamThunkWrapper` 的 `finally` dispatch `setInactive()` 无 sessionId 上下文，
  后台会话结束时可能把前台会话标为 inactive（UI 显示层面，不影响 chunk 归属）。
- tab↔session 仍依赖 `TabBar` 的 useEffect 隐式回填（在新结构下 working）；
  显式 dispatch 强绑定留待后续优化。

#### 阶段 3 原计划（对照）

文件：`sessionSlice.ts`、`store.ts`、`tabsSlice.ts`、`TabBar.tsx`、所有读 `state.session` 的 selector/组件/thunk。

- 把 `SessionState` 拆成 `SessionData`（每会话完整字段，含 §1.1 那批未隔离字段）
  - 全局 `sessionUi`（`allSessionMetadata` 等）；
- `sessions: Record<sessionId, SessionData>` + `activeSessionId`；
- 提供 `selectActiveSession(state)`，**渲染层/selector/thunk 统一改读它**；
- 移除当前补丁的 `sessionRuntimes`/`activeStreamSessionId`/`streamTarget`/`selectStreamSessionState`
  这套临时机制（它们只是本设计的残缺雏形）；
- tab 系统改造：`Tab { tabId, sessionId }` 强绑定，`sessionId` 在 `newSession` 时确定并立即写入 tab，
  去掉 `handleSessionChange` 的隐式 effect 回填，改为显式 dispatch；
- `handleTabClick` 切 activeSessionId 而非 `loadSession` 全量替换（会话数据已在 store）。

### 阶段 4：审批与工具链适配（2 人日）

文件：`hitlBridge.ts`、`DeepAgentHitlToolbar.tsx`、`callToolById.ts`、
`streamResponseAfterToolCall.ts`、`handleApplyStateUpdate.ts`。

- `hitlBridge` 的 `protocol` 改为按 sessionId 取通道；`cancelHitlDecision` 按 session 取消；
- 工具续流全链路显式带 sessionId（当前补丁已做一半，可保留思路）；
- apply/审批卡的 sessionId 由协议数据驱动，不读"当前显示会话"。

#### 阶段 4 实际实施记录（2026-11-20）

所有新增 `sessionId` 参数均为**可选**，缺省回退 active session —— 现有调用点零改动，
只有流式链路显式传 sid（与阶段3的 `inSession` 策略一致）：

- **工具续流全链路带 sid**：
  - `callToolById` / `streamResponseAfterToolCall` / `streamNormalInput` 的调用点互传 `sessionId`；
  - 这三处 + `handleApplyStateUpdate` 的 session 读改 `selectSessionById(state, sid)`（有 sid 时），
    session 写全部用 `inSession(action, sid)` 包装；
  - `streamResponseAfterToolCall` 的并发去重 key 前缀 sessionId（两会话同 toolCallId 不折叠）；
  - `streamThunkWrapper` arg 兼容函数形态与 `{ run, sessionId }` 形态，finally 的
    `setInactive` / `errorToolCall` / confirmation 扫描改按 owning session 的 history/applyStates 计算；
  - `cancelStream` 的 `setInactive` / `clearDanglingMessages` 按 session stamp。
- **HITL 按 session**：
  - `DeepAgentHitlToolbar` 决策回传 `sessionId`（从 pending 的 owner 取）；
  - `VsCodeMessenger` handler 把 sessionId 传给 `resolveHitlDecision`；
  - `hitlBridge` 的 pending 条目记录 sessionId，`resolveHitlDecision(requestId, decisions, sessionId?)`
    做跨会话校验，`cancelHitlDecision(reason, sessionId?)` 支持按 session 取消（Stop 仍走既有
    per-request AbortSignal 链路，已按 session 隔离）。
- 验证：三包 typecheck 无新增错误（core 154 / extensions 381 / gui 509），lint 0 错误。

已知限制（低优先级，不串话）：

- `handleApplyStateUpdate` 中 4 处 `updateToolCallOutput` 未按 sid 包装；这些写入按 toolCallId
  在目标 session history 定位，后台 session 的场景下找不到对应项时 reducer 静默 no-op，
  不会串改别的会话，仅表现为后台 edit 工具输出不实时刷新。
- client-side 工具内部（`assertFileWasRead` / editImpl 等）仍读 active session，
  client 工具多为 edit 工具走 apply 流程，由 ApplyState.sessionId 链路覆盖。

### 阶段 5：持久化与刷新恢复（1.5 人日）

- redux-persist 白名单从"单 session"改为"sessionStore 全量（或活跃 N 个）"；
- 后台流 chunk 定期 `history/save`（节流），避免刷新丢失未 save 内容；
- 迁移脚本 `migrations`（store.ts:74-98）适配新结构。

#### 阶段 5 实际实施记录（2026-11-20）

- **persist / migration**（阶段3已完成）：白名单改为 `sessions/activeSessionId/lastSessionId`，
  version 1→2 migration 把旧扁平 session 转 sessions map，`sessionAborterTransform` 写盘剥离 /
  读盘重建 AbortController。
- **chunk 节流 save**：`session.ts` 新增轻量 `saveSessionById` thunk（只按 id 取会话并
  `history/save`，不生成标题、不刷 metadata）+ 模块级 `throttleChunkSave(sessionId, dispatch)`
  （每会话 3s 最多一次）；`streamNormalInput.ts` 在每次 chunk 写入后调用它，后台/前台流
  均按 owning session 落盘，刷新最多丢一个 3s 窗口。
- **turn-end flush 修正**：`saveCurrentSession` 加可选 `sessionId`（按 id 取会话），
  `streamThunkWrapper` 的成功路径传 `owningSessionId`，修复此前后台会话 turn 结束却保存
  前台会话的缺陷；标题生成/metadata 刷新仍只在 turn 结束做（低频）。
- 验证：三包 typecheck 无新增错误（core 154 / extensions 381 / gui 509），lint 0 错误。

已知限制：节流 save 用会话当前 title（可能是临时标题），正式标题仍由 turn-end 的
`saveCurrentSession` 生成并刷新 metadata（频率低，可接受）。

### 阶段 6：联调与回归（3 人日，含用户实测往返）

- 场景矩阵见 §5；
- 清理所有 `[CONCURRENCY-DBG]` 日志；
- 类型检查 3 包（core/extensions/gui）+ 三原场景回归。

#### 阶段 6 实际实施记录（2026-11-20）

- **清理**：删除 `sessionSlice.newSession` 里遗留的 `console.trace` 诊断日志（全仓已无
  `[CONCURRENCY-DBG]` / `console.trace`）。
- **静态回归审查**（code-explorer 全链路审查）发现并修复 4 个真实 bug：
  1. **P0**：`streamResponse.ts`（首轮发消息入口）的 `streamThunkWrapper` 传裸函数，
     turn 结束的 save/清理作用于"结束时的 active session"——改为捕获入口 sessionId、
     用 `{ sessionId, run }` 对象形式，所有 pre-stream dispatch 用 `inSession` 包装，
     `streamNormalInput` 传 sessionId。
  2. **P0**：`ensureSessionAborter`/`abortStream` 被 wrapper 强制路由到 active session，
     切会话后无法取消后台流、还会误 abort 无关流——改为按 payload 的 sessionId 路由；
     `streamNormalInput` 用 `selectSessionById` 读 aborter；`abortStream` 未命中时 no-op
     （不再 fallback 误 abort legacy slot）。
  3. **P1**：`newSession(payload)` 切到已存在会话时用当前会话残留状态覆盖目标会话
     （掩盖后台流、丢失 aborter、审批卡串会话）——改为直接激活目标 session 自身状态。
  4. **P1**：`streamNormalInput` 构造 LLM 消息用 active session 的 history/mode/id——
     全部改用 owning session。
- 验证：三包 typecheck 无新增错误（core 154 / extensions 381 / gui 509），lint 0 错误。
  72 文件改动（+1100/-471）。

遗留（低风险，不阻塞实测）：

- `edit.ts` 的 `streamThunkWrapper` 仍用裸函数（edit 是单会话前台场景，无 sessionId 时
  回退 active，行为等同改造前）。
- `selectActiveSession` 对不存在 id 返回新 fallback 对象，异常时序下可能使 createSelector
  memo 失效；正常路径 activeSessionId 总指向已注册 session，不构成确定性重渲染。

---

## 4. 风险清单

| 风险                                                          | 等级 | 缓解                                                        |
| ------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| 前端所有 `state.session` 读取点数量大（45 action + 大量组件） | 高   | 用 `selectActiveSession` 单点收敛；先 grep 全量清单再批量改 |
| redux-persist 结构变更导致老会话数据不兼容                    | 中   | migration + 保留旧 `session` 字段读取兜底                   |
| 后端单例 wrapper 改造影响非并发的单会话路径                   | 高   | `sessionId` 缺省时回退到"默认 runtime"，保证单会话行为不变  |
| 单 webview 下多流响应 postMessage 交错                        | 高   | envelope 带 sessionId + GUI 侧按 id 分发（Kiro 做法）       |
| 无法在此环境做运行时验证                                      | 高   | 每阶段交付后由用户实测；阶段 1-2 后端改动需 esbuild         |

---

## 5. 验收场景矩阵

| #   | 场景                                | 期望                             |
| --- | ----------------------------------- | -------------------------------- |
| 1   | 会话1 流中切会话2，让会话1 后台跑完 | 会话1 完整生成；切回看到完整内容 |
| 2   | 会话1 后台流时，会话2 独立发消息    | 两会话内容/主题独立，不互相出现  |
| 3   | 会话1 审批卡弹出时切会话2           | 审批卡只在会话1 显示             |
| 4   | 会话2 发起新会话不报错              | 无 spurious abort 弹窗           |
| 5   | 两个会话同时后台流                  | 各自 chunk 写各自 history        |
| 6   | 后台流期间刷新页面                  | 已生成内容不丢（节流 save）      |
| 7   | 单会话所有原有功能                  | 无回归                           |

---

## 6. 工作量汇总

| 路径                                      | 前端 | 后端 | 协议 | 联调 | 合计（人日） |
| ----------------------------------------- | ---- | ---- | ---- | ---- | ------------ |
| **路径 A（单 webview + sessionId 路由）** | 4    | 3    | 2    | 4.5  | **~16 人日** |
| 路径 B（多 webview/panel）                | 5    | 5    | 2    | 5    | ~19 人日     |

> 人日为专注开发估算；含用户实测往返的实际日历时间会更长。
> 阶段 0-2（协议+后端 runtime）是"骨架"，做完前 UI 不会改善；需整体验收。

---

## 7. 建议

- 若目标是"稳定可用"：**回退到 `3c47a7afc`**（最小版），不投入本次重构。
- 若目标是"对齐 Kiro 的真并发"：按本设计走**路径 A**，从阶段 0 开始，
  **不要在当前补丁代码上继续叠加**——当前补丁的 sessionRuntimes/streamTarget 是残缺雏形，
  留着只会干扰重构。
- 无论哪种：动手前先把当前 12 个文件的未提交改动 stash 备份，避免丢失可分析材料。

---

## 附：关键文件绝对路径索引

- 前端状态：`gui/src/redux/slices/sessionSlice.ts`、`store.ts`、`slices/tabsSlice.ts`
- tab：`gui/src/components/TabBar/TabBar.tsx`
- 会话持久化：`gui/src/redux/thunks/session.ts`
- 协议：`core/protocol/core.ts`、`ideWebview.ts`、`webview.ts`、`core/index.d.ts`
- 后端路由：`extensions/vscode/src/ContinueGUIWebviewViewProvider.ts`、`webviewProtocol.ts`、`commands.ts`
- wrapper/模型：`extensions/vscode/src/deepagents/DeepAgentLLM.ts`、`ContinueLLMAdapter.ts`、`workspaceBackend.ts`
- 审批：`extensions/vscode/src/deepagents/hitlBridge.ts`、`gui/.../DeepAgentHitlToolbar.tsx`
- Kiro 参考：`D:\soft\Kiro_back\resources\app\extensions\kiro.kiro-agent\dist\extension.js`
