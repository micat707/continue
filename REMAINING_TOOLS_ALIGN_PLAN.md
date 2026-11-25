# 剩余 9 个工具对齐计划（基于 Kiro 源码实证 + 抓包基准）

> 基准：`D:\soft\Kiro_back\.kiro\compare\kiro_tools.txt`（23 工具，含全部 9 个的描述/schema）
> 源码：`D:\soft\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js`（字符偏移标注）
> 目标：`read_code`/`create_artifact`/`semantic_rename`/`smart_relocate`/`update_session_information`/`invoke_sub_agent`/`disclose_context`/`kiro_powers`/`createHook` 中**能对齐的对齐**。
> `invoke_sub_agent` 已完成，本计划覆盖其余 8 个。
>
> **用户决策（2026-11-20）与实现状态**：
>
> - `semantic_rename` / `smart_relocate` / `kiro_powers` / `disclose_context`：**先不处理**（强平台依赖，用户决定暂缓）。
> - 已实现并注册 4 个：`read_code`（完整）、`createHook`（完整）、`update_session_information`（部分：title/description/status 落 state+日志，无 GUI 展示）、`create_artifact`（部分：落盘+返回 `micat-artifact://`，无 panel 渲染）。
> - 实现文件：`src/deepagents/kiroExtraTools.ts`；两个 createDeepAgent 调用点已接入。
> - 校验：描述 103/103、spec 17/17、intent 22/22、typecheck 379=基线、lint 全净。
> - 解耦：工具不 import workspaceBackend/vscode，改为注入 `toRealPath` / `workspaceRoot`，使其可在测试环境 bundle。

---

## 一、逐个工具实证与分类

| 工具                         | 源码机制                                                                                                                                           | 我方基础设施                                                                                       | 分类                                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `read_code`                  | @10781981：`HMs` 工具，读 fs + AST 提取符号；tags `[READ, BUILTIN]`；本地计算，无 IDE 往返                                                         | core 有 tree-sitter `getSymbolsForFile`（29 语言）+ `context/getSymbolsForFiles` 协议              | **✅ 可完整对齐**                                                                                                                    |
| `createHook`                 | @8388796：`Vgd` 工具，校验 id、按 trigger/actionType 写 `.kiro/hooks/<id>.json`；纯文件写入                                                        | vscode/src 无执行器；CLI 有 hook 框架但未接工具链；GUI 有 CRUD 页                                  | **✅ 可完整对齐**（写文件即可，执行框架另议）                                                                                        |
| `update_session_information` | @6936179：`BEe` 工具，更新 session 的 title/description/status；轻量状态写入                                                                       | Session 有 `title` + `updateSession` thunk；无 description/status 字段                             | **🟡 部分对齐**：工具描述/schema 逐字齐；title 走现有 updateSession；description/status 存到 agent state + 日志（无 UI 展示层）      |
| `disclose_context`           | 动态工具（源码 @3130853 归为 `skill` tag；description 里的 Available Items 是**动态的**，来自用户项目里的 skills/steering）                        | core 有 `loadSteeringRules`（`.micat/steering`）+ `loadMarkdownSkills`；无 `.kiro/steering` 加载器 | **🟡 部分对齐**：schema 固定（只有 `name`），描述骨架逐字齐但 Available Items 需按我方 skills 动态生成；读取走 core steering/skills  |
| `create_artifact`            | @10826336：`rDs` 工具，注册 artifact 到会话，返回 `kiro-artifact://<id>`，GUI 有 artifact panel 渲染                                               | 无 artifact URI/panel；有 `showVirtualFile` + webview 底座                                         | **🟡 部分对齐**：描述/schema 逐字齐；实现为"保存到会话目录 + 返回 `micat-artifact://<id>` + 尝试 showVirtualFile 打开"；无完整 panel |
| `semantic_rename`            | @3246375：`sRl`，`metaKey:"clientToolSemanticRename"`、`method:"_kiro/tool/semantic_rename"` → **client tool，走 Kiro IDE 的 LSP rename provider** | 无 `executeDocumentRenameProvider`；有 definition/references/documentSymbol                        | **🔴 只能对齐描述/schema**：无法做真正的 LSP 语义重命名；实现降级为"读取+报告不支持"（空壳风险高）                                   |
| `smart_relocate`             | @3248063：`cRl`，同为 **client tool**（`_kiro/tool/smart_relocate`），走 VS Code 文件移动 + import 自动更新                                        | 无对应 client API                                                                                  | **🔴 只能对齐描述/schema**：降级为普通文件移动（fs rename），无 import 自动更新                                                      |
| `kiro_powers`                | @7015224：依赖 `powersManager`、MCP server 工具路由、Power 包（含 skills/steering/MCP）；抓包里 "Currently Installed Powers: None"                 | 无 PowersManager / MCP 路由                                                                        | **🔴 只能对齐描述/schema**：无 power 可管理，返回 list=空；其他 action 明确报告不可用                                                |

分类原则：**只把"有真实能力承接"的工具做成可用实现**；纯平台依赖的三个工具（semantic_rename/smart_relocate/kiro_powers）若注册空壳会误导模型，倾向**只对齐描述/schema 文本作为基准记录，不注册到运行工具集**（除非用户明确要求空壳占位）。

---

## 二、实现方案

统一在 `continue/extensions/vscode/src/deepagents/` 新增 `kiroExtraTools.ts`，导出 `createKiroExtraTools(deps)`，每个工具用 `tool(fn, {name, description, schema})`，description/schema 逐字取 kiro_tools.txt。

### 2.1 `read_code`（完整实现）

- schema：`path`(必)、`selector`(nullable)、`language`(default "auto")、`explanation`(必)
- 实现：
  - `<10k` 字符 → 返回全文
  - `≥10k` + 无 selector → 通过 core tree-sitter `getSymbolsForFile` 提取所有符号签名
  - `≥10k` + selector → 模糊匹配符号名（支持 `Class.method`），返回该符号实现
  - 目录 → 遍历代码文件提取签名
- 依赖：core `getSymbolsForFile` 通过 `context/getSymbolsForFiles` 协议调用，或直接 import `core/util/treeSitter`（需处理 vscode 扩展能否 require core 的 wasm 路径）；先尝试协议，失败降级到简单正则符号提取

### 2.2 `createHook`（完整实现）

- schema 10 字段逐字
- 实现：校验 id（`/^[a-zA-Z0-9_-]+$/`）→ 校验 trigger enum → 根据 actionType 组装 JSON → 写到 `workspaceRoot/.kiro/hooks/<id>.json`（用 `kiroPathToReal` 解析）→ 返回成功消息
- 不实现 hook 执行（那是独立系统），但写出的文件与 Kiro 格式完全一致

### 2.3 `update_session_information`（部分）

- schema 3 字段逐字（`title`≤100、`description`≤500、`status` enum）
- 实现：title 通过现有 `updateSession` 协议更新 session title；description/status 存到 agent state `sessionInformation` + 控制台日志
- 描述/schema 逐字；没有 UI 展示 description/status（见"风险"）

### 2.4 `disclose_context`（部分）

- description 骨架逐字，但底部 `**Available Items**` 段落按我方 `.micat/steering/*.md` + skills 动态生成（源文本格式 `• name: "x" - <description>`）
- schema：`name`(必) 逐字
- 实现：从 `.micat/steering` 和 core skills 里找匹配 name 的文件，读取全文返回；找不到返回明确错误
- 描述无法与 kiro_tools.txt 逐字比对（因为 Available Items 本就是动态的），校验脚本只校验 schema 和描述骨架

### 2.5 `create_artifact`（部分）

- schema 6 字段逐字；description 含 `kiro-artifact://<id>` 文本逐字
- 实现：把 content 写到会话临时目录；`sourcePath` 则复制文件；返回 `artifact id` + `micat-artifact://<id>` URL（Kiro 是 kiro-artifact://，我方协议不同但行为对齐）
- 不实现 panel 渲染（见"风险"）

### 2.6 三个平台依赖工具

- `semantic_rename`/`smart_relocate`/`kiro_powers`：**仅在计划/校验脚本里记录其逐字描述/schema 作为对齐基准**，不注册到运行工具集；避免空壳误导模型
- 如果用户明确要求占位，可按同样方式注册（描述/schema 逐字），func 返回"当前编辑器不支持此工具"——但默认不做

---

## 三、校验

- 扩展 `test-tool-descriptions.js`：新增对本批工具的 description/schema 逐字校验（基准从 kiro_tools.txt 解析）
- 对 `disclose_context` 只校验 schema + 描述骨架（去掉动态 Available Items 段）
- `create_artifact` 描述里的 `kiro-artifact://` 保持逐字，实现返回 `micat-artifact://`（差异记录）
- 跑全套：描述校验、spec 单测、意图单测、typecheck（379 基线）、lint

---

## 四、风险与取舍

1. **描述逐字 vs 实现降级**：`semantic_rename` 等工具如果注册空壳，模型会以为能重命名符号，实际不能——比没有更糟。默认不注册。
2. **disclose_context 描述动态**：kiro_tools.txt 里的 Available Items 是用户项目特定的（示例里是一个数据分析项目），不可能逐字对齐；只对齐骨架和 schema。
3. **artifact 协议差异**：Kiro 的 `kiro-artifact://` 是其私有协议；我方用 `micat-artifact://`，描述文本保留 Kiro 原文（工具描述对齐优先），实际返回值不同——如果要求返回值也对齐，需在本编辑器注册 URI handler。
4. **update_session_information UI**：description/status 无 GUI 展示，只能落到 state/日志；如果要求完整 UI，需改 GUI（按记忆，GUI 由用户 vite watch 热更新，改完不用 build）。

---

## 五、预期结果

- 5 个工具有真实能力承接（read_code / createHook 完整；update_session_information / disclose_context / create_artifact 部分）
- 3 个平台依赖工具不注册空壳，只留基准记录
- 已对齐的 70 项描述校验 + 新增项全过；typecheck 无新增错误
- 不破坏已有的 invoke_sub_agent / spec orchestrator 对齐
