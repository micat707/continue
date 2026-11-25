# 按 Kiro 方案实现 run_in_background（background 穿透到执行层）

## Kiro 的实际机制（已核实 extension.js）

Kiro 的 `run_in_background` 不是工具层特判，而是**参数一路穿透到执行层**：

```
工具 executeBash
  → workspace.runBashCommand({ command, cwd, timeout, background: run_in_background })
  → terminal.runCommand(shellCmd, timeout, abortSignal, onTerminalReady, background)
  → host 层根据 background 决定同步等待 or 后台化（POSIX 加 &，Windows 交 terminal 系统）
  → terminalId 通过 onTerminalReady 回调注入进度/输出
```

核心：`runCommand` 的**第 5 个参数就是 `background`**，后台能力是执行 API 原生的。

## 我方的对应改法（等价形态）

### 改动 1：protocol 的 execute options 加 background（向后兼容）

- 文件：`deepagentsjs/libs/deepagents/src/backends/v2/protocol.ts:158-161`
- `execute(command, options?: { cwd?, timeout?, background?: boolean })`
- 其他 backend 忽略新字段，零影响

### 改动 2：createExecuteTool schema 加 run_in_background 并透传

- 文件：`deepagentsjs/libs/deepagents/src/middleware/fs.ts`
- schema 加 `run_in_background`（描述逐字取 kiro_tools.txt）
- func 里 `resolvedBackend.execute(command, { cwd, timeout, background: input.run_in_background === true })`

### 改动 3：WorkspaceRootBackend.execute() 根据 background 分流

- 文件：`continue/extensions/vscode/src/deepagents/workspaceBackend.ts:2370`
- `options.background === true` 时调 `startBackgroundProcess(command, cwd)`
- 把结果转成 ExecuteResponse 结构：`{ output: JSON.stringify({terminalId, isReused, message}), exitCode: 0, truncated: false }`
- 同步时保持原样调 `runCommand(...)`

### 改动 4：校验与回归

- `test-tool-descriptions.js` 的 execute_pwsh PARAM_FIELDS 加 `run_in_background`
- 跑校验脚本（目标 54 passed, 0 failed）
- extensions typecheck 基线 379
- 新增字段描述与 kiro_tools.txt 逐字一致

## 为什么这样和 Kiro 一致

| 维度              | Kiro                          | 本方案                                        |
| ----------------- | ----------------------------- | --------------------------------------------- |
| background 决策层 | 执行 API (`runCommand` 第5参) | 执行 API (`execute()` options.background)     |
| 参数穿透路径      | 工具→workspace→terminal       | 工具→backend.execute()→startBackgroundProcess |
| 工具层是否特判    | 否，只透传布尔                | 否，只透传布尔                                |
| terminalId 回传   | onTerminalReady 回调          | execute() 返回的 output JSON                  |

行为等价：`run_in_background=true` 时后台执行、立即返回、terminalId 可见、可用 `get_process_output` 读。

## 风险与约束

- protocol 接口改动是**可选字段**，其他 backend（node-vfs/modal/deno/daytona/langsmith）不受影响
- `WorkspaceRootBackend.execute()` 是 VSCode 侧特有 backend，改它不影响上游其他 backend
- 后台命令的 abort 语义与同步不同（后台进程不随 turn abort 中止），与现有 control_pwsh_process 一致

## 实际执行结果（已完成）

- ✅ 改动1：`protocol.ts` V2 的 `execute()` options 加 `background?: boolean`（可选字段，向后兼容）
- ✅ 改动2：`fs.ts` 的 `execute_pwsh` schema 加 `run_in_background`（描述逐字对齐），func 透传 `background` 给 `backend.execute()`；同时让长命令警告在 `run_in_background=true` 时跳过
- ✅ 改动3：两个实际 execute backend 都加了 background 分流——`WorkspaceExecBackend.execute()`（单 mount 场景）和 `WorkspaceRootBackend.execute()`（多 mount 场景）。background=true 时调 `startBackgroundProcess`，返回含 terminalId 的 ExecuteResponse。`withApprovedPaths` 代理对 execute 用 Reflect.get 直传，不拦截参数，链路完整
- ✅ 改动4：校验脚本 PARAM_FIELDS 加 `run_in_background`

## 验证结果

- 校验脚本：**54 passed, 0 failed**（此前 53，新增 run_in_background 逐字一致）
- extensions typecheck：**379 = 基线**，改动文件无新增错误
- IDE lint：0 错误
