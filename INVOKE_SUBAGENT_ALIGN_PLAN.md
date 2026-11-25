# invoke_sub_agent 完整对齐计划（基于 Kiro 新版源码实证）

## 一、Kiro 源码实证机制

来源：`D:\soft\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js`

| 机制              | Kiro 实现                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 描述生成          | `izu(agents)` 动态拼：`Invoke a specialized agent...` + `registry.getAll().map(a => "- " + a.id + ": " + a.description)`                               |
| schema            | 固定对象 `S1i`：`name`/`prompt`/`explanation`（必填）+ `preset`/`contextFiles`/`specTask`（可选）                                                      |
| contextFiles 结构 | `{path, startLine?, endLine?}[]`，1-indexed inclusive                                                                                                  |
| specTask 结构     | `{taskId, tasksFilePath}`，两者必须同时给（`I1i` refine 校验）                                                                                         |
| 执行              | `handle`：registry.get(name) → 权限审批 → buildContextFileMessages(contextFiles) → preset 配置 → fTt() 启动子代理 → 嵌套深度限制(5) → handoff 文件回传 |
| 内置 agent        | `lzu` 集合：context-gatherer / general-task-execution / custom-agent-creator / spec-task-execution / workflow 系列                                     |

## 二、我方现状（deepagents task）

- 工具名 `task`，schema：`description` / `subagent_type`
- 子代理通过 `SubAgent` 接口定义（`subagents.ts:222`：name/description/systemPrompt/tools/mode），支持 isolated/fork 两种模式
- 描述 `getTaskToolDescription()` 动态列 `${subagentDescriptions}`
- 当前 createDeepAgent 调用**未传 subagents**，只有默认 `general-purpose`

## 三、对齐方案（分 4 阶段）

### 阶段 1：定义 5 个 preset SubAgent（新增能力）

在 `DeepAgentLLM.ts` / `DeepAgentChatPanel.ts` 的 `createDeepAgent({ subagents: [...] })` 注册 Kiro 的 agent（按我方能力裁剪行为，description 逐字取 kiro_tools.txt）：

| Kiro preset              | 我方 SubAgent 定义                                                    | 可行性                  |
| ------------------------ | --------------------------------------------------------------------- | ----------------------- |
| `context-gatherer`       | systemPrompt = Kiro 描述原文（代码探索分析），mode=isolated，只读工具 | ✅ 完全可行             |
| `general-task-execution` | = 现有 general-purpose 改名，全工具                                   | ✅ 完全可行             |
| `custom-agent-creator`   | systemPrompt 指导生成 agent 配置文本（写文件）                        | ✅ 可行（输出配置文档） |
| `introspect`             | 描述 Kiro 自身——我方非 Kiro，改为"回答本项目/编辑器相关问题"          | ⚠️ 空壳风险，降级处理   |
| `semantic_reviewer`      | systemPrompt = 审查 diff 写审查文档 + verdict                         | ✅ 可行                 |

### 阶段 2：task 工具 schema 对齐 Kiro

改 `subagents.ts` 的 `createTaskTool`：

- 工具名 `task` → `invoke_sub_agent`
- schema：`description`→`prompt`、`subagent_type`→`name`，新增 `explanation`/`preset`/`contextFiles`/`specTask`
- func 字段映射：`name`→subagent 查找、`prompt`→任务描述、`explanation`→记录
- **描述**：`getTaskToolDescription()` 改为 Kiro 的 `izu` 格式，agent 列表从传入的 subagents 动态生成（与 Kiro 一致）

### 阶段 3：contextFiles / specTask 能力

- `contextFiles`：在 func 里读取指定文件（含行范围），转成 HumanMessage 注入子代理 prompt 前文（用现有 backend.read）
- `specTask`：我方无 spec 工作流 → schema 保留字段但实现校验（缺 taskId/tasksFilePath 时报错对齐 Kiro 行为），实际不接 spec orchestrator
- `preset`：映射到 SubAgent 的额外 systemPrompt 覆盖（大部分情况可忽略，传了就用）

### 阶段 4：校验与回归

- 校验脚本：新增 invoke_sub_agent 的工具描述 + schema 字段校验（对齐 kiro_tools.txt）
- 用户重新抓包 my_tools.txt 后跑对比，确认 15 个工具全部对齐
- typecheck / lint 回归

## 四、风险与决策点

1. **描述逐字对齐 vs agent 清单动态**：Kiro 描述里的 agent 列表是动态的。要"逐字对齐 kiro_tools.txt"，我方的 agent description 必须与 Kiro 那 5 个逐字相同——这样描述自然一致。若某个 agent（introspect）我方是空壳，描述写了但能力不符 → 模型会误用。建议 introspect 的 description 用 Kiro 原文但 systemPrompt 明确"本编辑器非 Kiro，回答基于当前项目文档"。
2. **specTask**：Kiro 的 spec 体系依赖 tasks.md + spec orchestrator，我方没有。schema 对齐但功能只能做参数校验，不能真正接 spec 流程。
3. **嵌套深度限制**：Kiro 有 5 层限制，deepagents 已有 `FORK_RECURSION_REFUSAL` 防递归，行为接近但不完全相同。
4. **工具名变更影响**：`task` → `invoke_sub_agent` 后，GUI 里所有引用 `task` 的地方（工具卡片、HITL 审批白名单、消息渲染）需同步改。需全局搜索 `task` 硬编码。

## 五、预期结果

- invoke_sub_agent 工具描述与 kiro_tools.txt 逐字一致
- schema 6 字段完全对齐
- 5 个 preset 可被调用（introspect/specTask 有降级）
- 剩余未对齐工具只剩：`create_artifact`/`kiro_powers`/`createHook`/`semantic_rename`/`smart_relocate`/`update_session_information`/`read_code`/`disclose_context`（8 个 Kiro 平台特有）
