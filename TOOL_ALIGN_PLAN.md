# 工具描述与 schema 对齐计划（基于 Kiro 新版本 kiro_tools.txt）

## 背景与现状

- 对齐基准：`D:\soft\Kiro_back\.kiro\compare\kiro_tools.txt`（在用新版 `D:\soft\Kiro` 的抓包）
- 工具级 description：14 个已逐字一致（脚本 43 passed）
- 参数级 description：29 处双方共有字段已逐字一致
- 剩余差异：全部是「字段存在性」——Kiro 有、我方缺（或反之）的 schema 字段

## 探查结论（本次核查）

| 待加字段                          | 我方是否已有底层能力                                | 结论                                     |
| --------------------------------- | --------------------------------------------------- | ---------------------------------------- |
| `list_directory.explanation`      | 纯展示字段                                          | ✅ 可直接加                              |
| `delete_file.explanation`         | 纯展示字段                                          | ✅ 可直接加                              |
| `file_search.explanation`         | 纯展示字段                                          | ✅ 可直接加                              |
| `grep_search.explanation`         | 纯展示字段（描述文本已提及）                        | ✅ 可直接加                              |
| `get_process_output.lines`        | 我方已 `slice(-20000)` 截断，加行数参数即可         | ✅ 可实现能力                            |
| `read_file.offset` / `limit`      | 已有 `start_line/end_line` + 转换函数 `fs.ts:81-95` | ✅ 可加别名字段                          |
| `execute_pwsh.description`        | 纯展示字段                                          | ✅ 可直接加                              |
| `execute_pwsh.run_in_background`  | 有 `control_pwsh_process` 承担后台                  | ✅ 可加字段 + 转发                       |
| `file_search.excludePattern`      | backend `glob()` 签名仅 `(pattern, path)`           | ⚠️ 可加字段，但需改 backend 才能真正过滤 |
| `file_search.includeIgnoredFiles` | 同上                                                | ⚠️ 可加字段，但需改 backend              |

## 执行步骤

### 步骤 1：纯展示字段（低风险，先做）

在 `fs.ts` 对应 schema 加 `explanation`（描述逐字取 kiro_tools.txt）：

1. `list_directory.explanation` — `createLsTool` schema (`fs.ts:1302`)
2. `delete_file.explanation` — `createDeleteTool` schema (`fs.ts:2023`)
3. `file_search.explanation` — `createGlobTool` schema (`fs.ts:2094`)
4. `grep_search.explanation` — `createGrepTool` schema (`fs.ts:2185`)
5. `execute_pwsh.description` — `createExecuteTool` schema (`fs.ts:2346`)

### 步骤 2：可读行范围字段

6. `read_file.offset` / `limit` — `createReadFileTool` schema (`fs.ts:1552`)，复用已有 `normalizeReadPagination` 把 offset/limit 转成内部 start_line/end_line

### 步骤 3：进程输出行数

7. `get_process_output.lines` — `workspaceBackend.ts` schema + `getBackgroundProcessOutput` 增加行数截断参数

### 步骤 4：后台执行字段

8. `execute_pwsh.run_in_background` — `fs.ts` schema + func 转发到后台进程逻辑

### 步骤 5：file_search 过滤字段（需 backend 支持）

9. `file_search.excludePattern` / `includeIgnoredFiles`
   - 先加 schema 字段（描述对齐）
   - 评估 backend `glob()` 扩展成本；若成本高，保留字段但注释说明「schema 对齐、能力待 backend 支持」

### 步骤 6：校验

- 扩展 `test-tool-descriptions.js` 覆盖新增字段
- 跑校验脚本，确保新增字段描述逐字一致
- 跑 core + extensions typecheck，确认无新增错误

## 明确保留的差异化字段（不对齐）

| 字段                                                         | 原因                             |
| ------------------------------------------------------------ | -------------------------------- |
| `web_search.maxResults/includeRawContent/timeout`            | 双搜索后端（Tavily+Bing）必需    |
| `execute_pwsh.ignoreWarning/warning/skipPruning/explanation` | 我方内容裁剪/警告机制            |
| `read_file.start_line/end_line/explanation/skipPruning`      | 等价能力，保留                   |
| `grep_search.path/max_count/output_mode/regex`               | 上游通用能力                     |
| `task` ↔ `invoke_sub_agent`                                 | 两套子代理系统，改描述会误导模型 |

## 实际执行结果（已完成）

- ✅ 步骤1：`list_directory/delete_file/file_search/grep_search.explanation` + `execute_pwsh.description` 已加
- ✅ 步骤2：`read_file.offset/limit` 已加，并在 func 映射到 startLine/endLine（复用 1-based 转换）
- ✅ 步骤3：`get_process_output.lines` 已加，实现"最近 N 行"截断（默认 100）
- ⚠️ 步骤4：`execute_pwsh.run_in_background` **未加** —— fs.ts 的 execute() 是同步模型，无法转发到 VSCode 侧的 `startBackgroundProcess`（两套执行机制，上游库拿不到扩展 API）。强行加字段会误导模型。归入保留差异。
- ✅ 步骤5：`file_search.excludePattern/includeIgnoredFiles` 已加；`excludePattern` 用 micromatch 实现真实过滤，`includeIgnoredFiles=no` 过滤隐藏目录（近似 Kiro 语义）

## 验证结果

- 校验脚本：`53 passed, 0 failed`（此前 43 passed，新增 10 字段全部逐字一致）
- extensions typecheck：379 = 基线，改动文件无新增错误
- deepagents typecheck：因环境缺 @types/node 无法独立运行（非代码问题）；fs.ts 经校验脚本的 esbuild 打包成功加载

## 双方共有字段

从 29 → 39（新增 10 个可对齐字段）

## 保留差异（能力无法安全对齐）

- `execute_pwsh.run_in_background`：执行机制不同，见步骤4
- `web_search` 双后端参数、`skipPruning` 系列、`grep` 扩展参数、`task` 子代理系统：架构差异，见前文

## 模型侧工具名对齐（2026-11-20，按 Kiro 抓包）

Kiro 的 `toolSpecification.name` 使用内部 id（`read_file` / `fs_write` / `file_search` / `grep_search` / `execute_pwsh` / `remote_web_search`），而 `read` / `write` / `glob` / `grep` / `bash` / `web_search` 只是 `displayName`，出现在描述文本和 UI 里。Kiro dispatch 用 `find(id) ?? find(displayName)` 同时接受两种名字。

已按此对齐：

- `ContinueLLMAdapter.toContinueTools()` 不再把 id 改成 displayName；发给模型的 function name 与 `kiro_tools.txt` 完全一致。
- `ContinueLLMAdapter.sanitizeToolCalls()` 保留入站 `displayName -> id` 兼容，等价于 Kiro dispatch 的双名称查找。
- `webSearchTool.ts` 内部工具名由 `web_search` 改为 Kiro 的 `remote_web_search`；模型若按描述文本返回 `web_search`，入站映射回 `remote_web_search`。
- 校验脚本新增 6 项工具名接线断言：描述校验总数从 103 提升到 **109 passed, 0 failed**。
