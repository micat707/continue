# create_artifact GUI 面板 / read_code tree-sitter 对齐计划（Kiro 源码实证）

> 源码：`D:\soft\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js`
> 我方：`continue/`（core + extensions/vscode + gui）
> 目标：与 Kiro 行为一致——read_code 用真 tree-sitter 精确解析；create_artifact 有 GUI 面板渲染 + `kiro-artifact://` 内联预览。
>
> **实现状态（2026-11-20）：全部完成。**
>
> - read_code：符号解析改为注入式 `symbolResolver`（调用点 `require("core/util/treeSitter").getSymbolsForFile`），按 Kiro 语义分组输出（class/function + signature + line + implementation），1MB 拒绝、64KB 截断、selector 查实现、目录递归；无 resolver 时降级正则。
> - create_artifact：运行时返回 `kiro-artifact://<id>`；经 `artifactBridge` 推送 `artifactPush` 协议；GUI 新增 artifactsSlice + 独立侧边 ArtifactPanel（列表 + 全屏查看 ArtifactView，按 kind 分派 markdown/mermaid/svg/html/code/image/pdf-office）+ InputToolbar 入口按钮 + StyledMarkdownPreview 内联预览（同时识别 kiro-artifact:// 与 micat-artifact://）。
> - 磁盘 store（后续按 Kiro 补齐）：`artifactStore.ts` 以 `globalStorageUri/artifacts` 为根，按会话分目录，落盘 payload + `manifest.json`，读取时过滤 stale 项，per-session 写锁，watcher 跨窗口同步；`artifactList` / `artifactDelete` / `artifactPushBulk` 全链路接线完成，GUI redux 只作为磁盘状态的投影。
> - 校验：描述 103/103、spec 17/17、intent 22/22、artifact store 运行时生命周期验证通过（create/list/delete）；扩展 typecheck 379=基线、GUI tsc 509=基线且 artifact 相关文件无新增错误；全量 `npm run esbuild` 被当前环境的 `node_modules/core` untrusted mount point 阻断（与本次改动无关）。
> - 注意：GUI 由用户 vite watch 热更新（未手动 build）；tree-sitter wasm 在 `extensions/vscode/out/tree-sitter-wasms` 需构建脚本就位。

---

## 一、Kiro 源码实证

### 1.1 read_code（ToolReadCode `d6e`，@10781981）

- 工具 id `read_code`，tags `[READ, BUILTIN]`，schema `path`/`selector`/`language`(default auto)/`explanation`。
- 阈值：`WMs=64e3`（输出 64KB 截断提示），`Fin=1e6`（>1MB 直接拒绝："File too large to read"）。描述里写 <10k chars 返回全文，源码 `processFile` 据此分支。
- **真 tree-sitter**：`getParser()` → `pjt(language)`（web-tree-sitter），`detectLanguage` 按扩展名映射（`VMs` 表，默认 python）。
- `extractSignatures(content, lang)`：递归遍历 AST（`thp` 最大深度），按节点类型提取符号，产出 `{type, name, signature, line, className, parentClass, implementation}`：
  - 类族 `ehp` / `class_declaration` → `class/enum/namespace/interface/struct/trait/abstract class`，`signature="class Foo"`，递归子类
  - 属性箭头函数 / `method_definition` / `accessor` → `function`，`signature` = 节点首行
  - `lexical_declaration`（const/let 箭头函数，仅顶层）→ `function`
  - 函数族 `Zfp`（function_definition 等）→ `function`，兼容 C declarator
  - 模糊匹配 symbol name → `findImplementation` 展开完整实现
- `processFile(path, selector)`：小文件全文；大文件无 selector → `formatSymbols` 列表；有 selector → 模糊查找 → 实现；目录 → 遍历代码文件提取签名。

**结论**：Kiro 用真 AST + 符号类型白名单 + 递归遍历。我方要"一致"必须用 tree-sitter，不是正则。

### 1.2 create_artifact（@10826336 等）

- 会话级 artifact manifest + 文件落盘；URI `kiro-artifact://<id>`。
- kind 分支：`TEXT_ARTIFACT_KINDS = markdown/svg/mermaid/html/code`（内联文本），image/pdf/office 用 sourcePath 文件。
- 约束：`maxArtifactFileSize=12MB`、缩略图 `256KB`、支持在 artifact panel 与编辑器 tab 打开。
- GUI 侧：feature flag `agentArtifacts`；聊天消息里 markdown image `![title](kiro-artifact://id)` 被识别为内联预览；artifact panel 全尺寸渲染。

---

## 二、我方基础设施（已探查）

### tree-sitter

- `core/util/treeSitter.ts`：`getSymbolsForFile(filepath, contents): Promise<SymbolWithRange[]>`，返回 `{filepath, range:{start,end}, name, type, content}`（`core/index.d.ts:480`）。
- 协议 `context/getSymbolsForFiles`（`core/protocol/core.ts:169`，handler `core/core.ts:553`）；扩展侧可 `core.invoke("context/getSymbolsForFiles", {uris})` 直接拿返回值（`VsCodeExtension.ts:573` 有先例）。
- 依赖就位：`extensions/vscode/package.json:948` `"core":"file:../../core"`；`web-tree-sitter` v0.21.0 / `tree-sitter-wasms` 物理存在；构建脚本把 wasm 拷到 `out/`（`scripts/utils.js:156-180`）。
- **差异**：core 返回的是"符号+range"，与 Kiro 的 `{signature, implementation, className, line}` 字段不同；需要在扩展侧把 core 符号映射成 Kiro 的输出格式。

### GUI artifact

- 消息协议：`core/protocol/webview.ts` 的 `ToWebviewFromIdeOrCoreProtocol` 加 `artifactPush`（扩展→GUI）；GUI 用 `useWebviewListener` 接收（`gui/src/hooks/useWebviewListener.ts`）。
- 扩展推送：`VsCodeWebviewProtocol.send()`（`extensions/vscode/src/webviewProtocol.ts:18-26`）。
- markdown/mermaid/code 组件现成：`StyledMarkdownPreview/index.tsx`（mermaid 在 `MermaidBlock.tsx`）。
- 虚拟文档：`VsCodeExtension.ts:584-601` 已注册 `continue://` provider、`showVirtualFile` 协议可打开文本。
- 内联替换点：`StyledMarkdownPreview/index.tsx:427-436` 的 `img` 渲染器（当前走 `SecureImageComponent` 安全拦截），识别 `micat-artifact://` / `kiro-artifact://` 后按 artifact 状态分派。

---

## 三、用户决策（2026-11-20，已确认）

- **Q1 URL**：运行时改用 `kiro-artifact://<id>`（描述/行为都对齐），GUI 同时识别 `kiro-artifact://` 与 `micat-artifact://` 兼容旧数据。
- **Q2 GUI**：做**完整独立 artifact panel**（侧边/底部 panel dock，列出会话所有 artifact，点击全屏查看），最接近 Kiro；工作量大。同时保留聊天内联预览。
- **Q3 AST**：语义对齐 Kiro（class/function 分组 + signature + line + implementation），不追求字节级相同。

---

## 四、实现方案

### 阶段 1：read_code tree-sitter（扩展侧）

1. `kiroExtraTools.ts` 的 `createReadCodeTool` 注入 `symbolResolver: (uri) => Promise<SymbolWithRange[]>`，由调用点传 `(uri) => coreRef.invoke("context/getSymbolsForFiles", {uris:[uri]})[uri] ?? []`。
2. `extractSignatures` 替换为：用 core 符号按 `type` 映射到 Kiro 类型（function/class/enum/interface…），`signature` 取符号首行、`implementation` 用 `content`、`line` 用 `range.start.line+1`、`className` 从 range 内父 class 符号推断。
3. 保留阈值：`<10000` 全文、`>1e6` 拒绝、selector 模糊匹配 + 展开实现、目录递归。
4. 校验：新脚本 `test-readcode-ast.cjs` 用 fixture 文件断言提取到正确的符号名/类型/行号。

### 阶段 2：create_artifact GUI

1. `core/protocol/webview.ts` 加 `artifactPush: [{id,title,kind,content,sourcePath,format,url}, void]`。
2. 扩展侧 `kiroExtraTools.ts` 的 `createArtifactTool` 加 `pushArtifact?: (payload) => void` 依赖；调用点传 `webviewProtocol.send("artifactPush", payload)`。
3. GUI：新增 `gui/src/redux/slices/artifactsSlice.ts`；顶层组件用 `useWebviewListener("artifactPush", ...)` 收入 store。
4. `StyledMarkdownPreview/index.tsx` 的 `img` 渲染器：识别 `kiro-artifact://<id>`/`micat-artifact://<id>`，查 store 里的 artifact，按 kind 分派：
   - markdown → 递归 `<StyledMarkdownPreview source={content}/>`
   - mermaid → `<MermaidBlock chart={content}/>`
   - svg → 内联 `dangerouslySetInnerHTML`（sanitize 后）
   - code/html → `<SyntaxHighlightedPre>` 或 iframe sandbox
   - image → `<img src={file://...}>`
   - pdf/office → 按钮调用扩展 `openFile`
5. URL 统一为 `kiro-artifact://<id>`（Q1 推荐）。
6. 校验：typecheck（GUI 由用户 vite watch，不跑 GUI build）。

### 阶段 3：磁盘 store（后续追加，按 Kiro 实现）

1. 新增 `extensions/vscode/src/deepagents/artifactStore.ts`：
   - root = `extensionContext.globalStorageUri.fsPath/artifacts`。
   - 会话目录 = `<sanitized-sessionId>-<sha256(sessionId).slice(0,8)>`，避免 sessionId 字符注入与哈希碰撞。
   - payload 文件落在会话目录；`manifest.json` 为权威索引；读取 manifest 时校验 payload 文件仍存在，过滤 stale 项。
   - per-session 内存写锁串行化 create/delete；`onDidCreate/onDidChange` watcher 把任意窗口的 manifest 变更推送给 GUI。
   - 导出 `sessionDir` / `createArtifact` / `listArtifacts` / `deleteArtifact` / `deleteSessionArtifacts`。
2. 协议接线：
   - `core/protocol/ide.ts` 增加 `artifactList` / `artifactDelete`。
   - `core/protocol/webview.ts` 增加 `artifactPushBulk`（磁盘重建 / watcher 全量替换）。
   - `commands.ts` 初始化 store root、启动 watcher，并把变更转发为 `artifactPushBulk`。
   - `VsCodeMessenger.ts` 注册 `artifactList` / `artifactDelete` handler。
   - `DeepAgentLLM.ts` / `DeepAgentChatPanel.ts` 注入 `artifactWriter: createArtifact` 与固定 sessionId。
3. GUI：
   - `artifactsSlice` 提供 `setArtifacts` / `removeArtifact`。
   - `ParallelListeners` 监听 `artifactPushBulk`，并在 sessionId 变化时请求 `artifactList` 重建 state。
   - `ArtifactPanel` 删除按钮调用 `artifactDelete`，磁盘 store 是权威源，redux 只做投影，因此不接 redux-persist。

### 阶段 4：回归

- 跑：描述校验、spec 单测、intent 单测、read_code 单测、typecheck、lint。
- 确认已有对齐不退化。

---

## 五、风险

1. core `getSymbolsForFile` 的 wasm 在 `out/`；若用户用 dev 模式（`npm run esbuild` 不跑 utils.js 拷贝）可能缺 wasm → 需要确认 out/tree-sitter-wasms 存在，否则降级到正则。
2. tree-sitter 符号映射不是字节级 Kiro 一致（Q3）；目标是语义一致。
3. GUI 改动由用户 vite watch 热更新，按记忆不需手动 build；改完只提示用户刷新。
4. GUI redux 仍为内存态，但已不是权威源：webview 重载 / session 切换时通过 `artifactList` 从磁盘重建，manifest watcher 通过 `artifactPushBulk` 推送全量替换；已与 Kiro manifest 持久化行为对齐。
5. `SecureImageComponent` 对自定义 scheme 可能有安全拦截；在 img 渲染器里对 artifact scheme 直接分派，绕过通用拦截。

---

## 六、预期

- `read_code` 用真 tree-sitter，符号提取语义与 Kiro 一致（小文件全文/大文件签名/selector 实现/目录递归/1MB 拒绝）。
- `create_artifact` 返回 `kiro-artifact://id`，GUI 聊天内联渲染 markdown/mermaid/svg/code/image，文本类可打开编辑器。
- artifact 落盘到 `globalStorageUri/artifacts/<session>/`，webview 重载后通过 manifest 重建，多窗口 watcher 同步，删除同时移除 manifest 项与 payload 文件。
- 已有 103/103 描述校验等全部不退化；typecheck 379 基线。
