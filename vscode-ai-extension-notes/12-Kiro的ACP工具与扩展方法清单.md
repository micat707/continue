---
title: Kiro 的 ACP 工具与扩展方法清单
aliases:
  - Kiro ACP 工具清单
  - Kiro ClientCapabilityTool
  - Kiro _kiro 方法
  - ACP 工具分层
tags:
  - vscode
  - kiro
  - acp
  - acp协议
  - extMethod
  - 工具系统
  - 逆向对照
created: 2026-11-24
related:
  - "[[10-Kiro从Continue到自研的演变对照]]"
  - "[[02-Continue的Agent-Harness实现]]"
  - "[[00-总览-MOC]]"
---

# Kiro 的 ACP 工具与扩展方法清单

> [!abstract] 一句话
> Kiro 1.x 的「工具」要分两层看：**模型可见的工具**（5 个 ClientCapabilityTool + 一批本地内置 + remote MCP）和**底层 ACP 方法**（标准 ACP 方法 + 120 个 `_kiro/*` 私有扩展方法）。ClientCapabilityTool 的精髓是**定义统一、执行按运行面分发**：agent 侧只持有 `method` 字符串，通过 `connection.extMethod(method, params)` 把执行交回客户端。

> [!info] 数据来源
> 新版 Kiro bundle：`D:\soft\Kiro\resources\app\extensions\kiro.kiro-agent\dist\extension.js`（v1.1.294）
> 关键锚点：`Cgd` 数组 @8371798、`ClientCapabilityTool` 类 @8371000、`o0l` 标准方法集 @3094110、`_kiro/*` 全量字符串扫描。
> ACP 官方规范：`agentclientprotocol.com/protocol/v1/tool-calls.md`（工具由 Agent 执行、Client 提供能力）。

---

## 1. 三层工具执行路径（先建立全景）

```text
模型可见的工具定义（id + description + schema，所有运行面一致）
        │
        ├─ ClientCapabilityTool（5 个）── connection.extMethod(method, params) ──> 客户端进程
        │                                      IDE / CLI / Web / Mobile / sandbox 各自实现
        ├─ 本地内置工具 ────────────────────── agent harness 进程直接执行
        │  (str_replace / fs_append / invoke_sub_agent / spec 工具 ...)
        └─ Remote MCP wrapper ─────────────── mcpClient.callTool() ── JSON-RPC tools/call ──> 远端 MCP server
           (remote_web_search / get_learnings ... idPrefix="remote_")
```

> [!note] 判断一个工具属于哪层
> 看源码里的包装类：`Sgd`（ClientCapabilityTool）→ `extMethod`；`z8`（remote MCP，`idPrefix="remote_"`）→ `callTool`；其余 `class extends fr` 且 handle 里直接操作字符串/文件 → 本地内置。

---

## 2. 模型可见、走 ACP 的 ClientCapabilityTool（5 个）

源码里的客户端工具数组（@8371798）：

```js
Cgd = [
  "read_file",
  "web_fetch",
  "execute_bash",
  "execute_pwsh",
  "disclose_context",
];
```

| 工具               | capability  | 作用                                             |
| ------------------ | ----------- | ------------------------------------------------ |
| `read_file`        | `fs_read`   | 读文件                                           |
| `web_fetch`        | `web_fetch` | 抓网页（3 种模式：full / truncated / selective） |
| `execute_bash`     | `shell`     | 执行 bash 命令                                   |
| `execute_pwsh`     | `shell`     | 执行 PowerShell 命令                             |
| `disclose_context` | `skill`     | 加载 skill / steering 上下文                     |

**特征**：模型看到标准工具定义（id + schema + description），agent 侧 `handle()` 统一走 `connection.extMethod(definition.method, {...})`，实际执行在客户端。

> [!tip] 一个关键澄清
> `list_directory`、`fs_write`、`str_replace`、`grep_search`、`file_search` 等虽然也是 `builtin` / `fs_read` / `fs_write` capability，但**不在 `Cgd` 里**——它们是 agent 进程内置的（底层可能用标准 ACP `fs/*` 方法或 `_kiro/fs/*` 扩展方法），不是 `ClientCapabilityTool` 这个包装类。

### 2.1 `ClientCapabilityTool` 的实现骨架（@8371000）

```js
Sgd = class extends fr {
  constructor(t, e, r, n = "client") {
    super({
      id: t.id,
      title: t.title,
      description: t.description,
      schema: t.schema,
      origin: n,
    });
    this.definition = t; // { id, title, description, schema, method }
    this.connection = e; // ACP 连接
    this.sessionId = r;
  }
  async handle({ input: t, state: e, toolUse: r, actionId: n }) {
    this.emitProgress(e, {
      /* ... */
    });
    let l = await this.connection.extMethod(this.definition.method, {
      sessionId: this.sessionId,
      ...t, // 工具参数原样透传
    });
    // 统一解析 l.isError / l.success / l.fileChanges ...
  }
};
```

### 2.2 `extMethod` 接口本身

```js
extMethod(e, r) { return this.request(e, r); }            // e=method 名, r=params
extNotification(e, r) { return this.notify(e, r); }
```

ACP 连接建立时，客户端提供一个 `extMethod` 回调，框架挂通用 handler（@3079377 / @3080833）：

```js
t.extMethod &&
  e[iF]().withHandler({
    handleMessage: async (r) => {
      if (r.kind !== "request" || o0l.has(r.method)) return no; // 标准方法跳过
      const result = await t.extMethod(r.method, r.params); // 交给客户端实现
      await r.responder.respond(result);
      return yes;
    },
  });
```

即：**标准 Set（`o0l`）里的方法走内置实现，其余 method 路由到客户端注入的 `extMethod`**。

> [!warning] 注意范围
> 这段 handler 是 **Agent→Client 方向**的入站分发，判断依据是 `o0l`（9 个 Agent→Client 标准请求方法）。Client→Agent 方向（`r0l`/`n0l`）走的是另一侧的 `ClientSideConnection` 专属方法，**包括 Kiro 自己扩展的 `unstable_*` 方法**——它们也不走 `extMethod`。完整分类见 [[#3.5 「标准通道」的完整定义与三层方法分类]]。

### 2.3 为什么这样设计

1. **能力在哪就在哪执行**：`read_file` 要访问真实工作区，`execute_pwsh` 要起本地进程，`web_fetch` 要走本机代理（`HTTP_PROXY` 等，官方文档明确写了）。agent harness 是独立进程，够不着。
2. **权限审批在客户端**：标准 ACP 权限请求是 `session/request_permission`，由 Client 弹窗让用户批准。
3. **跨运行面统一**：IDE / CLI / Web / Mobile / cloud sandbox 五种面，同一工具定义、不同客户端实现。

> [!note] 和 ACP 标准的关系
> 官方规范说「Tool calls 由 Agent 执行，Client 提供能力（权限请求、文件系统访问）」。Kiro 的 `ClientCapabilityTool` 是在这个框架内的具体包装：**定义/schema 在 agent 侧，实际动作通过 `extMethod` 扩展方法交回客户端**。这既不是 agent 本地执行，也不是远端 MCP，是第三种路径。

---

## 3. 标准 ACP 客户端能力方法（框架层，非「工具」）

源码里 `o0l` / `i0l` 集合（@3094110）：

| 方法                                                                | 用途                |
| ------------------------------------------------------------------- | ------------------- |
| `session/request_permission`                                        | 权限审批请求        |
| `session/update`                                                    | 工具进度 / 结果上报 |
| `fs/read_text_file` / `fs/write_text_file`                          | 标准文件读写        |
| `terminal/create` / `output` / `release` / `wait_for_exit` / `kill` | 标准终端生命周期    |
| `elicitation/create` / `complete`                                   | 结构化用户输入      |

这些是 ACP 规范的标准方法。Kiro 除 `ClientCapabilityTool` 外，fs / shell 类工具在需要时也会直接用。

---

## 3.5 「标准通道」的完整定义与三层方法分类

> [!important] 核心澄清（最容易搞错的地方）
> **「不在 ACP 官方标准里」≠「走 extMethod」。**
> Kiro 的标准通道里混了两类方法：ACP 官方定义的，和 Kiro 自己加进 ACP 客户端库的私有方法。这两类都走**专属强类型方法**（如 `newSession()`、`unstable_listProviders()`），不走 `extMethod`。只有第三层 `_kiro/*`（120 个业务私有方法）才走 `extMethod` 通用通道。

### 3.5.1 标准通道 = 四个固定 Set（源码 @3093559）

Kiro bundle @2776179 定义所有方法名常量（`bt` = Client→Agent，`io` = Agent→Client），@3093559 把它们分成四个 Set。**落在四个 Set 里的 method 走标准分发；不在里面的才路由到 `extMethod`。**

| Set   | 方向                    | 数量 | 内容                                                                                                                                                                                      |
| ----- | ----------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `r0l` | Client → Agent **请求** | 19   | `initialize`、`authenticate`、`providers/{list,set,disable}`、`session/{new,load,set_mode,set_config_option,prompt,list,delete,fork,resume,close}`、`logout`、`nes_{start,suggest,close}` |
| `n0l` | Client → Agent **通知** | 8    | `session/cancel`、`nes_{accept,reject}`、`document/did{Open,Change,Close,Save,Focus}`                                                                                                     |
| `o0l` | Agent → Client **请求** | 9    | `session/request_permission`、`fs/{read,write}_text_file`、`terminal/{create,output,release,wait_for_exit,kill}`、`elicitation/create`                                                    |
| `i0l` | Agent → Client **通知** | 2    | `session/update`、`elicitation/complete`                                                                                                                                                  |

另有 3 个 MCP 方法（`mcp/{connect,message,disconnect}`）和协议层 `$/cancel_request`。

### 3.5.2 三层方法分类

```text
ACP JSON-RPC 总线
  │
  ├─ 专属强类型方法（class 里有专属方法，参数/响应类型固定）
  │   ├─ 第1层：ACP 官方 25 个 —— newSession() / readTextFile() / createTerminal() ...
  │   └─ 第2层：Kiro 私有 unstable_* —— unstable_forkSession() / unstable_listProviders()
  │              / unstable_startNes() ...（也在 r0l/n0l Set 里，走标准分发）
  │
  └─ extMethod(method, params) 通用通道（字符串 + 任意 params）
      └─ 第3层：_kiro/* 约 120 个 —— spec / hooks / memory / workspace context ...
          （无专属 class 方法，能力可选，按面注册）
```

**第 1 层：ACP 官方 25 个**（`protocol/v1/schema.md` 权威清单）

```
Client→Agent(13): initialize, authenticate, logout, session/cancel, session/close,
  session/delete, session/list, session/load, session/new, session/prompt,
  session/resume, session/set_config_option, session/set_mode
Agent→Client(11): elicitation/create, elicitation/complete, fs/read_text_file,
  fs/write_text_file, session/request_permission, session/update, terminal/create,
  terminal/kill, terminal/output, terminal/release, terminal/wait_for_exit
协议层(1): $/cancel_request
```

**第 2 层：Kiro 私有但走标准分发**（不在 ACP 官方 25 个里，但也在 `r0l`/`n0l` Set 里）

| 方法                                                    | 专属 class 方法（@3096176 `ClientSideConnection`）                                   | 说明                             |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| `providers/list` / `set` / `disable`                    | `unstable_listProviders()` / `unstable_setProvider()` / `unstable_disableProvider()` | LLM provider 配置                |
| `session/fork`                                          | `unstable_forkSession()`                                                             | fork 会话                        |
| `nes/start` / `suggest` / `close` / `accept` / `reject` | `unstable_startNes()` 等                                                             | Next Edit Suggestion（内联补全） |
| `document/did{Open,Change,Close,Save,Focus}`            | —（通知）                                                                            | 文档变更同步                     |
| `mcp/{connect,message,disconnect}`                      | —                                                                                    | MCP 连接管理                     |

注意 `unstable_` 前缀——这是 Kiro 在 ACP 客户端库里**手工扩展**的方法。它们有专属强类型方法和固定的参数/响应结构，全运行面都要实现，所以走标准分发而非 `extMethod`。

**第 3 层：`_kiro/*` 120 个**（见第 4 节）——走 `extMethod`，能力可选、按面注册。

### 3.5.3 为什么第 2 层不走 extMethod

三个判据决定一个方法走"专属方法"还是"extMethod"：

| 判据             | 走专属方法（第1/2层） | 走 extMethod（第3层）             |
| ---------------- | --------------------- | --------------------------------- |
| 全运行面是否都要 | ✅ 是                 | ❌ 可选，某面可不实现             |
| 参数/响应结构    | 固定、强类型          | 任意字符串 + 任意对象             |
| 数量             | 少（几十个）          | 多（120 个）                      |
| 语义性质         | 协议层 / 基础能力     | 业务私有（spec / hooks / memory） |

`extMethod` 的分流代码（Agent→Client 方向入站）：

```js
handleMessage: async (r) => {
  if (r.kind !== "request" || o0l.has(r.method)) return no; // o0l 标准方法跳过
  const result = await t.extMethod(r.method, r.params); // 不在标准 Set 的才走这里
};
```

> [!tip] 判断口诀
> 看源码里的调用形态：`connection.newSession(...)` / `connection.unstable_listProviders(...)` → 专属方法（标准通道）；`connection.extMethod("_kiro/xxx", params)` → 扩展通道。两者都跑在同一条 ACP JSON-RPC 总线上，区别只是"方法名是否在 Set 里 + 有没有专属 class 方法"。

### 3.5.4 为什么工作区当前文件走 extMethod 而不是标准方法

`_kiro/workspace/active_file` 是第 3 层（走 extMethod），不是标准方法，原因有三：

1. **语义是 IDE 专属**：CLI 没有编辑器 tab，Web/Mobile 的"当前文件"定义各异，无法形成跨产品一致语义 → 进不了 ACP 官方标准。
2. **它是 Context Provider 不是 Tool**：注册到 `CurrentlyOpenFilesContextProvider`，在构造 prompt 时自动注入，模型不主动调用（所以也不在 `Cgd` 那 5 个 ClientCapabilityTool 里）。
3. **ACP 预留了扩展通道**：v2 RFD 明确说专门能力走扩展（MCP 或私有 extMethod），不塞进标准方法。

agent 侧统一发请求、按面降级（@9222702 / @4811417）：

```js
// agent 侧：所有面都发同样请求，校验响应格式
function bVd(t, e) {
  let r = "_kiro/workspace/active_file";
  return async () => {
    let n = await t.extMethod(r, { sessionId: e });
    if (_Vd(n)) return n.path; // 校验失败 → undefined
  };
}
// context provider：降级为自然语言，不报错
return s ? `Currently active file: ${s}` : "No file is currently active.";
```

IDE client 侧注册 handler 用 VS Code API（@11916631）：

```js
DZs = {
  method: "_kiro/workspace/active_file",
  handler: async () => {
    let t = Ace(); // loadCurrentFile()
    return t ? { path: t.fsPath } : {};
  },
};
```

| 运行面        | handler 行为             | 模型看到                                   |
| ------------- | ------------------------ | ------------------------------------------ |
| IDE           | VS Code API 返回真实路径 | `Currently active file: /path/x.ts`        |
| Web           | web client 自己实现      | 真实路径                                   |
| CLI / sandbox | 不注册/返回空            | `No file is currently active.`（优雅降级） |

---

## 4. `_kiro/*` 私有扩展方法（约 120 个）

这些走同一个 `extMethod` 通道，**不是模型直接调用的工具**，而是 agent 内部用来访问客户端能力的 RPC。

| 类别                 | 方法                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件系统             | `_kiro/fs/read_file`、`_kiro/fs/write_file`、`_kiro/fs/read_directory`、`_kiro/fs/stat`、`_kiro/fs/delete`                                                                                                                                                                                                                                                                              |
| 搜索                 | `_kiro/search/find_files`、`_kiro/search/text_search`                                                                                                                                                                                                                                                                                                                                   |
| 工具执行             | `_kiro/tool/get_diagnostics`、`_kiro/tool/semantic_rename`、`_kiro/tool/smart_relocate`                                                                                                                                                                                                                                                                                                 |
| 工作区上下文         | `_kiro/workspace/active_file`、`_kiro/workspace/currently_open_files`、`_kiro/code_references`、`_kiro/codeIntelligence`                                                                                                                                                                                                                                                                |
| Spec 工作流          | `_kiro/spec/invoke`、`_kiro/spec/resolveSession`、`_kiro/spec/getTaskStatuses`、`_kiro/spec/phaseCheckpoint`、`_kiro/spec/taskStatusChanged`                                                                                                                                                                                                                                            |
| Workflow             | `_kiro/workflow/{list,load,new,invoke,pause,resume,update,delete,cancel,inspect,run_start,run_complete,node_*,steps_queued,watch_poll,...}`（约 20 个）                                                                                                                                                                                                                                 |
| Hooks                | `_kiro/hooks/{list,executeHook,triggerHook,setEnabled,didChange,cancel,sessionStart}`                                                                                                                                                                                                                                                                                                   |
| 权限 / 策略          | `_kiro/permission/respond`、`_kiro/permissions/{list,explain}`、`_kiro/policy/{check,changed,error,ignore_files_changed}`、`_kiro/governance/state`                                                                                                                                                                                                                                     |
| Memory               | `_kiro/memory/{create,read,get,list,update,delete}`                                                                                                                                                                                                                                                                                                                                     |
| MCP                  | `_kiro/mcp/{status,toggle,resetServer,getPrompt,getResource,elicitation,governance_disabled}`                                                                                                                                                                                                                                                                                           |
| Powers               | `_kiro/powers/{list,refresh,items_changed}`                                                                                                                                                                                                                                                                                                                                             |
| Session              | `_kiro/session/{compact,context,delete,export,history,list,notify,rename}`、`_kiro/sessions/changed`                                                                                                                                                                                                                                                                                    |
| Knowledge / Steering | `_kiro/knowledge`、`_kiro/knowledge/{indexingStarted,indexingCompleted}`、`_kiro/steering/documents_changed`、`_kiro/progressive_context/items_changed`                                                                                                                                                                                                                                 |
| Sandbox              | `_kiro/sandbox/{status,applyConfig}`                                                                                                                                                                                                                                                                                                                                                    |
| Checkpoint           | `_kiro/checkpoint/{revert,revertMultiple}`                                                                                                                                                                                                                                                                                                                                              |
| 用户输入             | `_kiro/userInput`、`_kiro/userInput/respond`                                                                                                                                                                                                                                                                                                                                            |
| 终端配置             | `_kiro/terminal/{shell_type,settings_changed}`                                                                                                                                                                                                                                                                                                                                          |
| Secret               | `_kiro/secret/{get,store,delete}`                                                                                                                                                                                                                                                                                                                                                       |
| 账号 / 认证          | `_kiro/account/getUsage`、`_kiro/auth/getAccessToken`                                                                                                                                                                                                                                                                                                                                   |
| 其他                 | `_kiro/openExternalUrl`、`_kiro/config/template`、`_kiro/configuration/{contribute,state}`、`_kiro/customAgent/{not_found,config_error}`、`_kiro/error/rate_limit`、`_kiro/system/notify`、`_kiro/tools/content_chunk`、`_kiro/tools/didChange`、`_kiro/c2s/view/changed`、`_kiro/sourceProviders/{list,listResources}`、`_kiro/safety/{getProperties,propertiesChanged,statusChanged}` |

---

## 5. Remote MCP wrapper（第三种路径）

新版 bundle @6964081：

```js
z8 = class extends fr {
  static idPrefix = "remote_";
  static serverName = "remote";
  static TOOL_TAG_MAP = {
    web_search: [je.WEB],
    get_learnings: [je.CONTEXT],
    get_learning: [je.CONTEXT],
    create_feedback_learning: [je.CONTEXT],
    delete_learning: [je.CONTEXT],
    get_learnings_for_prompt: [je.CONTEXT],
    get_steering_files: [je.CONTEXT],
    searchMemories: [je.CONTEXT]
  };
  constructor(e, r) {
    let n = z8.jsonSchemaToZod(e.inputSchema),   // spec 来自 MCP tools/list，原样转换
        s = _P(`${z8.idPrefix}${e.name}`);        // remote_web_search
    super({ id: s, description: e.description || `Remote tool: ${e.name}`,
            schema: n, tags: z8.TOOL_TAG_MAP[e.name], displayName: `remote/${e.name}` });
  }
  async handle({ input, ... }) {
    // 策略/权限审批 → mcpClient.callTool(this.toolSpec.name, input, operationId)
  }
}
```

最终 wire 格式（JSON-RPC `tools/call`）：

```json
{
  "jsonrpc": "2.0",
  "id": "web_search_<actionId>",
  "method": "tools/call",
  "profileArn": "arn:aws:codewhisperer:…",
  "params": {
    "name": "web_search",
    "arguments": { "query": "<模型给的 query>" }
  }
}
```

> [!important] `remote_web_search` 只有 `query` 一个参数
> 结果条数 / 是否返回原文 / 超时**不在 wire 上**，全部由 Kiro 的 remote MCP server 内部固定。新旧 bundle 里 `includeRawContent`、`tavily`、`search_depth`、`num_results` 全是 0 命中。

---

## 6. 运行面（surface）与本地可见性

bundle @1575029 / @3609056：

```js
q0o = ["kiro-web", "kiro-ide", "kiro-cli"]; // 三种 client
// 按运行面切换系统提示词：client === "kiro-cli" ? CLI_SHELL_PROMPT : ...
// 执行目标：case "local" → { kind: "local" }; case "remote" → { kind: "cloud-sandbox" }
```

monorepo workspace 结构（bundle 内嵌 package.json，@2615013）：

```text
packages/acp-type-covenant / kiro-agent / kiro-client / kiro-context-providers
kiro-sandbox-proxy / kiro-tui(CLI) / @amzn/kiro-runtime-service-typescript-client
@amzn/kiro-web-portal-service-bearer-typescript-client
```

| 运行面            | 本地可见？  | 能看到的                                                                                      |
| ----------------- | ----------- | --------------------------------------------------------------------------------------------- |
| **IDE**           | ✅ 完整     | agent + IDE client 的 `extMethod` 实现、`_kiro/*` 方法注册、fs/search/terminal 全链路         |
| **CLI**           | ❌ 只有痕迹 | `"kiro-cli"` 标识、CLI 专用系统提示词、monorepo 里的 `kiro-tui` 包名                          |
| **Web / Mobile**  | ❌ 只有痕迹 | `"kiro-web"` 标识、Web 专用提示词、`environment === "sandbox"` 分支                           |
| **cloud sandbox** | ⚠️ 部分     | `kind: "local" / "cloud-sandbox"` 路由逻辑、`executedHere / relayed` 判定、sandbox proxy 包名 |

本地安装的两个目录（`D:\soft\Kiro` / `D:\soft\Kiro_back`）都只有 VS Code fork + `kiro.kiro-agent` 扩展；其它面的 client 实现在独立产物里。

---

## 7. 附带发现：死代码残留

新版 bundle 里仍能找到旧版 web_fetch 的 `doFetchRendered()` 实现（@6943463）：

```js
async fetchUrl(e, r, n, s) {
  if (r === "rendered") return this.doFetchRendered(e, a, l);
  let u = await this.webFetchClient.fetchHtml(e);
  ...
}
```

但对外下发的 spec（kiro_tools.txt）enum 只有 `["full","truncated","selective"]`，官方文档也只写 3 种模式——**模型永远传不出 `"rendered"`，这段代码是死代码**。这和顶层 intent classifier 在新版变成死代码是同一类现象：1.0 重构时从模型可见的 spec 层摘掉，但 bundle 里没彻底清理。

---

## 8. 对我们自己改造的启发

> [!tip] 已落地（见 DeepAgent 工具桥）
> 项目里已新增 `acpToolBridge.ts`：`AcpToolDefinition{name, description, schema, method}` + `AcpToolRegistry.dispatch(method, params)` + 按 surface 注册 executor，正是上面 `ClientCapabilityTool` 的同构实现。`web_fetch` 已迁移为「定义统一 + executor 按 surface 注册」形式。

- **定义与执行分离**：工具 schema/描述放一处，执行体按运行面注册。两个调用点（`DeepAgentLLM` / `DeepAgentChatPanel`）已合并为 `createDeepAgentTools({ surface, ... })` 单一入口。
- **统一 dispatch 错误语义**：Kiro 用 `isError` / `success` / `fileChanges` 做统一结果契约；我们的 `AcpToolResult` 目前只有 `content` + `isError`，需要时再扩。
- **模型可见参数要克制**：Kiro 的 `remote_web_search` 只给 `query`，其余服务端固定。我们之前把 `maxResults` / `includeRawContent` / `timeout` 暴露给模型且被 zod `.default()` 变成必填，已改回内部常量。
