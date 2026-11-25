# Spec Orchestrator 完整对齐计划（基于 Kiro 新版源码实证）

> 来源：`D:\soft\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js`（约 14 MB，字符偏移标注）
> 目标：把 `invoke_sub_agent` 的 `specTask` 从"只做字段校验"升级为可用的 spec 任务编排，按 Kiro 真实机制实现。
> 本计划先于实现；每阶段完成后对照"验收"逐条勾选。
>
> **实现状态（2026-11-20）：4 个阶段 + 意图路由全部完成。**
> 校验：描述 70/70、spec 单测 17/17、意图单测 22/22、typecheck 379=基线、lint 全净。
> 落地要点：
>
> - 意图路由按 Kiro `tFr`/`eFr` 实现（`specIntent.ts`）：本地正则 `T$u` + LLM 分类器（`x$u` prompt）、`finalizeIntent` .7 阈值合并；通过 `wrapModelCall` 命中 taskExecution 时切换 orchestrator system prompt 并收窄工具集。
> - orchestrator prompt 逐字还原 Kiro `N$u = header + P$u + O$u`（含 bugfix 段 `VUr`），工具名用 Kiro 的 `taskList`/`taskGet`/`taskUpdate`。
> - spec 工具全程挂载，但 orchestrator 模式下由 middleware 收窄为 `SPEC_ORCHESTRATOR_TOOLS` 白名单（等价 Kiro 的 TaskOrchestratorPhase 工具集）。
> - `specTaskResolver` 通过注入回调实现（库不依赖扩展侧 specTasks），已接到两个 createDeepAgent 调用点。
> - `.meta.json` 按源码同目录 `<name>.meta.json`。
>   已知差异：Kiro 用独立 fast model（`getFastModelClient("intent-classification")`）做分类，我方复用当前 model——因为本编辑器没有独立 fast-model API。

---

## 一、Kiro 源码实证（已查证）

### 1.1 三个 spec 工具（动态加入 orchestrator 工具集）

| 工具 id       | description（源码 @8199839 / @8201660 / @8203137）                                                                                                                                                                                                                                                                                                                           | schema                                                                                                                                                                                                               |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `task_list`   | "List tasks with optional status filtering.\n\nReads tasks.md and .meta.json on each call to reflect the latest state.\n\nWhen called with status='ready', returns the next task whose dependencies are satisfied.\nWhen called with a concrete status, returns all tasks matching that status.\nWhen called with no filters, returns a summary of task counts."             | `tasksFilePath: string`（"Absolute path to tasks.md."）, `status?: "notStarted"\|"queued"\|"inProgress"\|"completed"\|"ready" \| null`（"Filter tasks by status. Use \"ready\" to get the next dispatchable task."） |
| `task_get`    | "Get detailed information about a specific task including execution history, PBT results, and dependency chain. Use this to inspect failed tasks before deciding on recovery actions."                                                                                                                                                                                       | `tasksFilePath: string`, `taskId: string`（"The ID of the task to inspect."）                                                                                                                                        |
| `task_update` | "Update a task's status with automatic side effects.\n\nReads tasks.md, applies the update, and persists the change.\nCompleting all children of a parent task auto-completes the parent.\nRuns pre/post task execution hooks on in_progress/completed transitions.\n\nWhen status is \"queued\" and no taskId is provided, queues all not-started non-optional leaf tasks." | `tasksFilePath: string`, `taskId?: string\|null`（"The ID of the task to update. Omit to queue all eligible tasks."）, `status: enum(kn)`, `error?: string\|null`（"Error message if the task failed."）             |

工具集分发：`getSpecOrchestratorTools()` / `getTaskOrchestratorTools()` / `getSpecAgentTools()`（@3153971）。抓取的 `kiro_tools.txt` 不含这 3 个工具——它们是 spec workflow 激活时动态加入的，所以**不需要**参与"逐字对齐"校验脚本（那是普通聊天工具集）。

### 1.2 tasks.md 解析与状态持久化（@7334473 / @7320284 / @7336959）

- 任务行正则：`^(\s*)([-*+])\s+\[([ xX\-~])\](\\?\*?)\s+(.+)$`
  - checkbox：`[ ]`=notStarted、`[~]`=queued、`[-]`=inProgress、`[x]`=completed（大小写 X 同义）
  - `*` 或 `\*` 紧跟 checkbox = optional 任务
  - 任务 id = 行文本（如 "1. Implement foo"）；`YGe` 从文本抽 `^\d+(\.\d+)*\.` 数字编号
  - 编号 `1.1` 通过 `G5u` 排序 + 父指针建父子层级；无编号则靠缩进（`Yqi`）
- 元数据：`.meta.json`（`tasks.md` → `tasks.meta.json`），结构 `{ pbtResults:{}, executionHistory:{} }`；`executionHistory[taskId]` 最多保留 10 条（@7336959 `saveMetadata`）
- 状态写回（file lock 下）：按 `startLine` 替换 checkbox 字符，`fs.writeTextFile` 持久化
- 完成校验：`validateTaskStatusChange` 拒绝"有未完成非可选子任务时标记父任务 completed"
- DAG（`TaskDAG` @7334473）：
  - `getReadyTasks()`：有 wave 信息时 = leafOrder 中非 optional、状态 notStarted/queued、**所有依赖任务均 completed**；无 wave 时退化为"第一个未完成任务"（顺序执行）
  - `updateNodeStatus()`：`completed` 时 `propagateParentCompletion()` 递归——所有子任务 completed/optional 则父任务自动 completed
  - `H5u = "## Task Dependency Graph"`：解析 wave 依赖图，给节点写 `waveId`/`dependencies`

### 1.3 specTask 服务端处理（@6428586 / @6409379）

- `BFr(t,e) = `${tasksFilePath}\0${taskId}`` 作为任务唯一键
- `mTt/g1i`：按 executionId 存 pending instructions 的 Map（WeakMap）
- `woe(t,e)`：`taskIdentityPresent` + 脱敏后的 taskId/tasksFilePath，注入子代理上下文
- `f1i(t)`：`pendingCount` + 最多 5 条 `pendingTaskIdentities`
- `specOnly` agent：仅当 `agentWorkflowType === SpecGeneration` 可调用，否则报错 "can only be invoked by the spec orchestrator"（@6428586）
- `ATt.handle`：先 `buildContextFileMessages(contextFiles)`，再按 preset 配置启动子代理，嵌套深度限制 5

### 1.4 orchestrator system prompt（@5936387 / @5940405）

- `P$u()` = "Run All Tasks Mode / **ORCHESTRATOR MODE**"：
  1. `taskList(tasksFilePath)` 取 counts → 2. `taskUpdate(status='queued')` 不带 taskId 批量排队 →
  2. 循环：`taskList(status='ready')` → 逐个 `taskUpdate(in_progress)`（**与 invoke_sub_agent 不能同一条消息**）→ 并行最多 5 个 `invoke_sub_agent(name='spec-task-execution')` 带 `specTask{taskId,tasksFilePath}` → 成功后 `taskUpdate(completed)` → 失败则停止上报。
     规则：orchestrator **不写码/不跑测试**，只读文件、改状态、派子代理、报进度；检查用户 stop/cancel 意图。
- `O$u` = single-task 版：先 `taskGet` → `taskUpdate(in_progress)` → `invoke_sub_agent(spec-task-execution)` → `taskUpdate(completed)`。
- `N$u()` = "Task Execution Orchestrator" = `P$u() + O$u`，挂在图节点 `QIt`（TaskOrchestratorPhase）。

### 1.5 spec-task-execution agent（@5927416）

prompt 要点：

- 全工具可写代码/跑测试/执行命令
- **MUST NOT call `taskUpdate`**——状态转换由 orchestrator 负责
- 开始前**必须**读 requirements.md / design.md / tasks.md，读 `.config` 判断 bugfix spec
- 有子任务先做子任务
- 失败则回报 orchestrator，不自行改状态

---

## 二、我方现状

- `invoke_sub_agent` 工具已与 Kiro 逐字对齐（name/prompt/explanation + preset/contextFiles/specTask 六字段，描述/字段描述全对齐，校验脚本 70/70）
- `specTask` 目前只在 `runTask` 里做"taskId + tasksFilePath 必须同时给"的校验，然后记入 metadata，**没有真正任务编排**
- 5 个 preset 中**没有** `spec-task-execution`
- 没有任何 `task_list`/`task_get`/`task_update` 工具
- 没有任何 `.kiro/specs/` 或 tasks.md 解析
- 校验脚本 `test-tool-descriptions.js` 校验的是普通聊天工具集，`task_list` 等动态工具不在其中

---

## 三、对齐方案（分 4 阶段）

### 阶段 1：spec 核心库 `specTasks.ts`（新增）

在 `continue/extensions/vscode/src/deepagents/` 新建 `specTasks.ts`，实现（全部对齐 1.2）：

| 导出                                                                      | 作用                                                                                                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SpecStatus = "notStarted"\|"queued"\|"inProgress"\|"completed"\|"ready"` | 状态枚举（对应源码 `kn` + `f6i="ready"`）                                                                                                         |
| `parseTasksFile(content): ParsedTask[]`                                   | 按 `_Qr`/`Yqi`/`G5u` 等价正则解析 checkbox/编号/缩进/optional，返回 `{id,text,status,isOptional,children,content,startLine,endLine,dependencies}` |
| `buildTaskDAG(tasks, graphSection?): TaskDAG`                             | 父指针 + leafOrder + `## Task Dependency Graph` wave 依赖；`getReadyTasks()` / `getExecutionOrder()` / `updateNodeStatus()` + 父任务自动完成传播  |
| `loadTasks(path)`                                                         | 读 tasks.md + 同名 `.meta.json`，每次调用都重读（对齐源码"Reads tasks.md and .meta.json on each call"）                                           |
| `updateTaskStatus(path, taskId, status, error?)`                          | file-lock 下按 startLine 改 checkbox 字符 + 写 `.meta.json`（executionHistory/ lastError），完成后传播父任务                                      |
| `queueAllLeafTasks(path)`                                                 | 排队所有 notStarted 非 optional 叶子任务（status='queued' 且 taskId 省略）                                                                        |

路径处理：接受绝对路径或虚拟挂载路径（复用 `createKiroContextFileResolver` 的 `toRealPath` 逻辑，抽成共享 helper）。

**验收**：用一个包含 `1. / 1.1 / 2.`、optional `*`、`[ ]/[~]/[-]/[x]`、Dependency Graph 的样例 tasks.md，跑 `getReadyTasks()` / `updateNodeStatus` 断言结果符合 1.2 语义。

### 阶段 2：3 个 spec 工具（新增 `specTools.ts`）

用 `deepagents` 的 `tool()` + Zod v4，description/schema 逐字取 1.1。`task_update` 的 `status` 用 `z.enum(["notStarted","queued","inProgress","completed"])`（"ready" 只允许出现在 `task_list.status` 过滤）。三个工具的 func 调用阶段 1 的库函数，返回 JSON.stringify 结构对齐源码：

- `task_list` 无状态 → `{summary:{total,completed,remaining,ready}}`; 有状态 → `{tasks:[{id,text,status,isOptional,lastError}]}`
- `task_get` → `{id,text,status,isOptional,children,metadata:{executionHistory,pbtResult,lastError}}`
- `task_update` → 成功/失败消息 + 自动父任务完成

**验收**：校验脚本新增 3 工具的 description + 字段描述逐字断言（从源码常量硬编码基准，不依赖抓包）。

### 阶段 3：specTask 接线 + `spec-task-execution` agent

1. **`spec-task-execution` agent**：加入 `KIRO_SUBAGENTS`（6 个 preset，但普通聊天描述会变成 6 个——见"决策点"）。systemPrompt 按 1.5 逐条实现。
2. **`specTask` 服务端**（`subagents.ts` 的 `runTask`）：当 `specTask` 传入时：
   - 用 `loadTasks(tasksFilePath)` 取该 `taskId` 的 task + 兄弟信息
   - 把 task.text / content / children / requirements.md / design.md / `.config` 路径拼进 prompt 前文（对齐 `woe`/`f1i` 注入）
   - 校验 `taskId` 存在于 tasks.md（对齐 `Task "${taskId}" not found`）
3. **orchestrator system prompt**：`specOrchestratorPrompt()` 返回 `P$u+O$u` 的中文等价版（保留"机械派发、不写码、最多 5 并发、状态与 invoke 不同消息、stop 意图检查"等全部规则）。

**已定方案（源码实证后确认）**：

- **`specOnly` 过滤（= 隐藏，对齐 Kiro 的本来做法）**：源码 @6195698 `AQe={id:"spec-task-execution",...,specOnly:!0}`；描述构造 @6425750：
  ```js
  let n=e.registry.getAll().filter(a=>(!a.specOnly||r)&&!TQe(a,e.excludeAgentId));
  super({ id:"invoke_sub_agent", description:izu(n,s), ... });
  ```
  普通模式 `r=false` → 过滤掉所有 `specOnly` agent，只剩 5 个 → 正是抓包里的描述；spec 模式 `r=true` → 才包含 `spec-task-execution`。**所以"隐藏"不是我方妥协，而是 Kiro 自己也这么做**。实现：给 `SubAgent` 加 `specOnly?: boolean`，`spec-task-execution` 标 true，描述生成沿用现有的 `.filter(spec.name !== "general-purpose")`，再加 `&& !spec.specOnly`（普通模式）。这样 70/70 校验不退化。
- **orchestrator 激活 = 意图分类动态路由（对齐 Kiro）**：源码 `tFr`（SpecSubIntentDetection，@5935340）：若 `specTaskId` 已设则短路到 `taskExecution`；否则取最后一条 human 文本，用 `getFastModelClient("intent-classification")` 做 `detectLocalIntent` + `detectLLMIntent`，`finalizeIntent` 归类为 `taskExecution`/`specGeneration`。图边 `D$u=c(t=>t.specSubIntent==="taskExecution"?QIt:zIt)`：命中则进 `TaskOrchestratorPhase` 节点（挂 `getTaskOrchestratorTools()`），否则进普通 `Action` 节点（挂 `getSpecOrchestratorTools()`）。**不是全程挂载，也不是手动开关**。实现：在主 agent 的 `beforeAgent`/prompt 阶段做轻量意图判断（关键词 + 快速模型），命中 spec/tasks.md 执行意图时才注入 orchestrator system prompt + 3 个 spec 工具；`specTask` 参数传入视为短路命中。

### 阶段 4：注册 + 校验 + 回归

- 两个 `createDeepAgent` 调用点：注入 3 个 spec 工具（`tools: [...createSpecTools()]`）+ `spec-task-execution` agent（hidden）+ specTask resolver。
- `test-tool-descriptions.js`：新增 spec 工具校验（基准来自源码常量）。
- 新增 `scripts/test-spec-tasks.js`：阶段 1 样例断言。
- 跑：`node scripts/test-tool-descriptions.js`（70 项不退化 + 新增项）、`node scripts/test-spec-tasks.js`、`npm run tsc:check`（对照基线 379）、lint。

---

## 四、风险与取舍

1. **Kiro 的 hook 体系**（`PreTaskExec` / `postTaskExec`）：源码里 `taskUpdate(inProgress)` 会触发 hook、可能 blocked/staged 指令。我方没有 hook 框架 → 阶段 1/2 不实现 hook，只在 `specTask` 注入时做等价的"task 指令暂存"（用 task.content 进 prompt）。影响：PreTaskExec 拦截行为缺失，但任务编排主链路可用。
2. **`.meta.json` 内容（源码实证 @7336959 / @7336988）**：`{ pbtResults:{}, executionHistory:{} }`；`executionHistory[taskId]` 每次执行 append `{executionId, chatSessionId, timestamp}`，最多保留 10 条；`pbtResults[taskId]={status, failingExample, lastRunTimestamp}`；文件锁下写。它**不是"根据项目内容生成"**——项目内容在 `tasks.md`（人/模型写的任务清单），`.meta.json` 只是运行时追加的执行历史与 PBT 结果。源码里它是 `tasks.md` 同目录替换后缀（`izi(t)=t.replace(/\.md$/,".meta.json")`），另有 `~/.kiro/spec-sessions/` 存 featureName→sessionId 映射（`J7i`）。我方阶段 1 按源码：同目录 `<name>.meta.json`，不自建 hash 目录。
3. **PBT（property-based test）结果**：`task_get` 的 `pbtResult` 字段保留在 `.meta.json`，但我方不实现 PBT 执行，只透传空值。
4. **并发 5**：由 orchestrator prompt 指示模型并行调用实现，不做硬性 semaphore（与 Kiro 一致——它也是 prompt 约束 + 服务端 active slot 管理，我方无后者）。
5. **工具集动态性**：3 个 spec 工具若全程挂在普通聊天里，模型可能在非 spec 场景误用。默认方案：只在 `specMode` 启用时加入（见阶段 3 决策点）。

---

## 五、预期结果

- `specTask` 真正可用：orchestrator 读 tasks.md → 排队 → 并行派 `spec-task-execution`（带 task 上下文注入）→ 写回状态 → 父任务自动完成
- 普通 `invoke_sub_agent` 描述/schema 仍逐字对齐 Kiro（hidden agent 方案）
- 3 个 spec 工具 description/schema 按源码常量对齐
- 8 个 Kiro 平台特有工具仍缺失（不在本计划范围）
- 校验：描述脚本 70+ 项全过、spec 单测全过、typecheck 无新增错误
