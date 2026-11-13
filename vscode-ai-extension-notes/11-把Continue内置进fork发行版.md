---
title: 把 Continue 内置进 fork 发行版(下载即带)
aliases:
  - 内置 Continue
  - builtInExtensions
  - 产物内置
  - 开箱自带 Chat
tags:
  - vscode
  - fork
  - continue
  - 发布
  - builtInExtensions
  - 方案
created: 2026-10-27
related:
  - "[[08-改造Continue为右侧锁死Chat面板]]"
  - "[[09-构建与打包脚本速查]]"
  - "[[10-Kiro从Continue到自研的演变对照]]"
---

# 把 Continue 内置进 fork 发行版(下载即带)

> [!abstract] 一句话
> 目标:让打包出的 fork 安装包**开箱自带 Continue**——用户下载即用,无需安装扩展、无需 `--extensionDevelopmentPath`、无需开 Vite。可行,且有现成范本:机器上的 `kiro.kiro-agent` 就是这么内置的。本页是**方案/可行性文档**(探讨阶段,暂不实施),记录机制、路径、风险与待确认项。

> [!warning] 这是发布阶段的工程,别在开发期做
> 内置后每改一次 Continue 都要重打发行版,开发效率极低。开发期继续用 `--extensionDevelopmentPath` + `gui` 的 `npm run dev`(见 [[09-构建与打包脚本速查]])。等功能定型再做内置。

---

## 1. 两种"内置"机制(先分清)

| 机制                                          | 扩展源码/产物在哪                   | 谁来编译                                          | 对 Continue 的适配成本                                                                                      |
| --------------------------------------------- | ----------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **源码内置** `extensions/<name>/`             | 放进 fork 仓库的 `extensions/`      | VS Code 的 gulp `compile-extensions`              | **高**。Continue 是 monorepo + 自有 esbuild + 复杂 prepackage(sqlite、node-pty),塞进 gulp 流程要大改,不推荐 |
| **产物内置** `product.json.builtInExtensions` | Continue 在自己仓库构建成自包含产物 | **各管各的**:Continue 自己构建,VS Code 只负责搬运 | **低(相对)**。Kiro 的做法,首选                                                                              |

> [!important] 结论:走"产物内置"
> Continue 照常在自己仓库 `prepackage` + `package` 出自包含产物,VS Code fork 发行版打包时把成品搬进去,不参与 VS Code 的扩展编译。

---

## 2. fork 现有机制(已核实)

- **`product.json`** 已有字段 `builtInExtensions`(当前 3 条)与 `builtInExtensionsEnabledWithAutoUpdates`。
- **构建脚本** `build/lib/builtInExtensions.ts`:默认按每条 `IExtensionDefinition` 的 `name/version/sha256/repo` **从远端(GitHub release / marketplace)拉取 vsix**;支持 `platformSpecific`(平台专属 vsix,按 `<name>-<osAlias>-<arch>.vsix` 约定解析)。
- 相关脚本:`npm run download-builtin-extensions`(拉取)、`build/lib/builtInExtensionsCG.ts`。

```ts
// build/lib/builtInExtensions.ts(摘要)
interface IExtensionDefinition {
  name;
  version;
  sha256;
  repo;
  platforms?: string[];
  vsix?: string;
  platformSpecific?: { [target: string]: string }; // 关键:平台专属 vsix
  metadata: { id; publisherId; publisherDisplayName };
}
```

> [!note] 这里有个关键矛盾
> 默认 `builtInExtensions` 是**从远端拉 vsix**。但 Continue 是**本地产物**、不在 marketplace/release。所以不能直接照搬远端拉取,要用"本地产物直塞"的变体(见 §4 方式 b)。`platformSpecific` 字段的存在说明这套机制**天生考虑了平台专属扩展**——正好对应 Continue 的 native 模块(见 §5 风险 1)。

---

## 3. 范本:Kiro 内置产物长什么样(已核实)

路径(发行版产物目录,非源码):
`...\resources\app\extensions\kiro.kiro-agent\`

顶层结构:

| 目录/文件                         | 作用                                                         | 对应 Continue                                   |
| --------------------------------- | ------------------------------------------------------------ | ----------------------------------------------- |
| `dist/`                           | 扩展后端(= `extension.js`)                                   | Continue 的 `out/extension.js` → 发布为 `dist/` |
| `node_modules/`                   | 扩展运行时依赖(含打平的 core 等)                             | prepackage 后的依赖                             |
| `packages/`                       | 内联的 monorepo 包(含 `continuedev/*`、`kiro-ui-agent-chat`) | Continue 的 `core`/`gui` 等                     |
| `bundled-webviews/`               | **GUI 产物**(React 打包结果)                                 | Continue 的 `gui/dist`                          |
| `tree-sitter` / `treesitter-wasm` | native / wasm                                                | Continue 也有 tree-sitter 依赖                  |
| `models/` `extension-resources/`  | 资源                                                         | 按需                                            |
| `package.json`                    | 扩展清单                                                     | 同                                              |

> [!tip] 关键启示
> Kiro 是把**整个 monorepo 打平成一个自包含目录**:后端进 `dist/`,GUI 进 `bundled-webviews/`(它改了名,Continue 默认是 `gui`),依赖和 native 全部内联。这就是"自包含产物"的样子——不依赖任何外部 `npm link` 或兄弟目录。

---

## 4. 产物内置的落地路径(草案,待调查细化)

```
① Continue 仓库:构建自包含产物
   cd continue/extensions/vscode
   npm run prepackage            # 拷 gui/dist、下 sqlite、装对应平台 native 模块
   npm run package               # 打成 continue.vsix(或直接用解包后的目录)
         │
         ▼
② 得到自包含产物(解包 vsix):
   extension/
     ├─ dist(或 out)/extension.js
     ├─ gui/              ← GUI 产物(index.html + assets)
     ├─ node_modules/     ← 运行时依赖
     ├─ bin/ + native     ← sqlite / node-pty 等(平台专属!)
     └─ package.json
         │
         ▼
③ VS Code fork:把产物挂为内置扩展(二选一)
   方式 a(远端拉取,改造大):把 continue.vsix 发布到你能访问的 GitHub release,
          在 product.json.builtInExtensions 加一条(name/version/sha256/repo/
          platformSpecific),构建时 download-builtin-extensions 拉取。
   方式 b(本地直塞,推荐):构建发行版时把②的解包产物直接拷进打包输出的
          resources/app/extensions/<id>/(Kiro 的形态)。需要在 fork 的发行版
          gulp 任务里加一步"拷贝本地 Continue 产物",绕开远端拉取。
         │
         ▼
④ 构建发行版:npm run gulp vscode-win32-x64(或对应平台任务)
   → 安装包自带 Continue;启动即 Production 模式 → webview 走 gui/,
     不连 localhost:5173,无需 Vite。
```

> [!note] 为什么内置后就不空白了
> 内置扩展默认 `extensionMode !== Development` → Continue 的 `ContinueGUIWebviewViewProvider.getSidebarContent()`(约 L82)走**生产分支**,`scriptUri` 指向本地 `gui/` 产物而非 `http://localhost:5173`。这正好根治了开发期用 `--extensionDevelopmentPath` 导致的面板空白(见 [[09-构建与打包脚本速查]])。

---

## 5. 风险与待确认项(调查阶段要逐条坐实)

> [!danger] 风险 1(最高):native 模块的平台/ABI 匹配
> Continue 依赖 `node-pty`、sqlite 等**原生模块**,`prepackage` 按目标平台编译。内置进 fork 发行版时,native 模块的 **os / arch / Electron ABI 必须与 fork 发行版的 Electron 版本一致**,否则运行时崩溃(找不到符号 / ABI 不符)。
>
> - 要确认:fork 用的 Electron 版本(`.yarnrc`/`build` 里的 runtime/target) vs Continue `prepackage` 产出的 native 模块目标。
> - `product.json.builtInExtensions` 的 `platformSpecific` 字段天生支持"每平台一个 vsix",是正解方向。

> [!caution] 待确认 2:product.json 本地产物直塞怎么挂
> `builtInExtensions.ts` 默认远端拉取。方式 b(本地直塞)需要在发行版 gulp 任务里加拷贝步骤,具体挂在哪个 task、输出目录结构,要读 fork 的发行版打包流程确认。

> [!caution] 待确认 3:扩展 id / 激活 / 容器 id 一致性
>
> - 内置后扩展 id、`activationEvents` 在发行版里是否正常激活。
> - 容器短 id 必须与锁死常量 `workbench.view.extension.continue` 一致(见 [[08-改造Continue为右侧锁死Chat面板]]),目前 Continue 容器短 id 是 `continue`,已对上,保持即可。

> [!caution] 待确认 4:GUI 产物目录名
> Kiro 把 GUI 放 `bundled-webviews/` 并相应改了 provider 的路径;Continue 默认 `gui/`。直塞时**保持 Continue 默认 `gui/` 即可**,不必改名(除非 provider 里路径写死了别的)。

> [!caution] 待确认 5:签名 / 体积 / 许可
> native 模块 + models 会让体积变大;发行版若需签名,native 二进制要一并签。Continue 是 Apache-2.0,内置分发需保留 LICENSE/NOTICE(Kiro 产物里就带了 `LICENSE.txt` / `NOTICE`)。

---

## 6. 结论与节奏

> [!summary] 可行性
> **可行,走"产物内置"(§1 机制二),参照 Kiro 形态(§3)。** 核心难点是 native 模块平台匹配(§5 风险 1),这决定成败,其余是工程细节。

> [!todo] 建议节奏
>
> - [x] 开发期:`--extensionDevelopmentPath` + Vite(已掌握)
> - [ ] 功能定型后,派只读调查坐实 §5 的 5 个待确认项:
>   - fork 的 Electron 版本 vs Continue native 目标
>   - `product.json` 本地产物直塞的 gulp 落点
>   - Kiro `kiro.kiro-agent` 产物的 native 模块组织方式(范本)
>   - Continue `package.js`/`prepackage.js` 产物结构 vs 内置所需格式差异
> - [ ] 调查后产出"落地步骤 + 命令 + 风险缓解"实施文档
> - [ ] 实施:先单平台(win32-x64)跑通,再扩展多平台

#vscode #continue #fork #发布 #方案
