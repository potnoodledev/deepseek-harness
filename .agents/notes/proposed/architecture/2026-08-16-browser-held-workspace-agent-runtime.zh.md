# Agent Note: Browser-Held Workspace Agent Runtime

Status: proposed

[English](2026-08-16-browser-held-workspace-agent-runtime.md) | 中文

## Problem

产品方向是让工作区完全由浏览器持有：agent 操作的项目文件存于 Origin Private File System（OPFS），没有后端，整个体验都在浏览器中驱动。这个方向与随产品交付的运行时形态相矛盾。`dsh web` 宿主在 Node 进程中运行 agent loop、会话日志、工具注册表、文件系统工具与 LLM 消费方，而浏览器按设计只是表现层（[Web AGENTS.md](../../../../packages/client/AGENTS.md)）；浏览器中不计算任何面向模型的内容。因此，浏览器持有的工作区要求面向模型的 agent 栈在浏览器中执行，而这从未在浏览器中组装或驱动过。

可行性依赖两项未经测量的断言。宿主栈的 Node 表面从未被梳理过——必须迁移的包有依赖，依赖又有自己的依赖。而且该组合从未在浏览器中验证过：挂载 `agent-loop` 加上 `session`、`system-prompt`、`tools`、`tool-fs` 与 `llm`，注册一个浏览器内文件系统提供方与一个脚本化 LLM 适配器，再驱动一个多工具轮次——这条路径从未在 Node 之外运行过。

## Proposal

在浏览器中运行同一套宿主编译 cordis 插件，为被 Node 隔离的各 seam 提供浏览器提供方，并保持面向模型的包不变。浏览器是 agent 栈的一个新执行表面，而不是对其的重写。`spikes/browser-agent/` 下的探针（[组合](../../../../spikes/browser-agent/src/agent.ts)、[构建](../../../../spikes/browser-agent/build.mjs)、[运行器](../../../../spikes/browser-agent/run.mjs)）已经在 headless Chromium 中证明了核心论断：该组合针对浏览器持有的文件系统完成一次完整的先读后写轮次，产出包含两次工具执行的 72 条会话事件日志，并且写出的文件在页面重载后仍保留在 OPFS 中。同一个探针随后通过随产品交付的 `tool-bash`/`bash-local` 栈，在浏览器 `subprocess` 提供方（`spikes/browser-agent/src/browser-subprocess.ts` + `js-shell.ts`）之上针对 OPFS 驱动一次真实的 `bash` 工具调用，并从 OPFS JSONL 持久化并恢复一份会话日志。

### The measured Node surface

整个组合的 Node 表面是四个宿主包中的七处 `node:*` 导入，外加一个隐藏的 Node 全局：

| Import | Package | Browser replacement |
| --- | --- | --- |
| `node:crypto` `randomUUID` | `dsh-agent-loop` | `crypto.randomUUID()` |
| `node:async_hooks` `AsyncLocalStorage` | `dsh-agent` | Promise 恢复式 shim（[探针 shim](../../../../spikes/browser-agent/src/shims/async-hooks.ts)） |
| `node:util/types` `isPromise` | `dsh-agent` | `value instanceof Promise` |
| `node:path` `isAbsolute` | `dsh-session` | POSIX 检查 |
| `node:module` `createRequire` | `dsh-llm` | 构建期版本 define（[探针 shim](../../../../spikes/browser-agent/src/shims/module.ts)） |
| `node:fs` / `node:os` | `dsh-sandbox` roots | 路径同一性桩（本组合中为死代码） |
| `Buffer.byteLength`（全局） | `dsh-tool-fs` `read-render.ts:74` | 正式移植用 `TextEncoder` 字节数修复调用点，而不是用 polyfill |

探针以 `src/shims/*` 提供这些 shim，并在 `src/polyfills.ts` 中加入一行 `Buffer` polyfill；正式移植用仓库内修复替换 shim（每一处都是其所属包中一次小型、可命名的改动），并用调用点修复替换 `Buffer` polyfill。

### Browser providers to build

`packages/` 下按 repo 的包清单为每个 seam 新建一个包：

- `dsh-fs-opfs` —— 基于 `navigator.storage.getDirectory()` 的 `FileSystem` seam。探针的 `src/opfs-fs.ts` 是可用的草稿：全部十二个原语、异步 `prepare()`（OPFS 初始化是异步的），并通过 `createWritable()` 实现原子写入与编辑。草稿中的版本号是内存计数器；正式提供方需要持久化的版本号来源（OPFS 文件元数据或伴随存储），因为观察策略的版本守卫必须跨重载存活。
- `dsh-session-persistence-idb` —— 基于 IndexedDB 的 JSONL 会话日志与附件，保持「模型可见即已记录」规则不变，并让浏览器内回放无需密钥即可工作。
- `dsh-subprocess-wasm` —— shell shim，基于绑定到 OPFS 文件系统的 WASI 或 JS shell 实现 `SubprocessRuntime.spawn`/`spawnTerminal`。`bash` 工具与 `bash-local` 执行器不改动地运行在 `ctx.subprocess` 之上。第一个里程碑交付 JS POSIX 命令子集档次，已在探针（`src/js-shell.ts`）中决定并证明：引号与转义、`;`/`&&`/`||` 顺序执行、整输出 `|` 管道、`>`/`>>`/`2>`/`2>>`/`<` 重定向、`$VAR`/`${VAR}`/`$?` 展开、前导赋值，以及内置命令 `cd pwd echo printf cat ls mkdir rm touch cp mv head tail grep sed wc find true false exit export`；通配符、`$(...)`、后台 `&` 与控制流关键字为记录在案的缺口。WASI bash 仍是 seam 层面的替换方案，而不是独立分支。
- `dsh-credentials-web` / `dsh-settings-web` —— 基于浏览器存储的 API 密钥与设置。浏览器持有的密钥对机器用户可读：对个人工具可接受，绝不可用于共享部署。
- `dsh-agent-in-browser` —— 浏览器入口：运行 agent 栈的 Web Worker（探针运行在页面主线程），外加一个本地适配器，从进程内服务而非宿主向现有 `dsh-client-runtime` 对象层供数，或者在页面内挂载与传输无关的 api-gateway。

按设计舍弃：真实子进程（LSP、Codex/Claude Code subagent、E2B）、终端会话、原生操作系统对话框以及宿主沙箱栈——浏览器本身就是沙箱，权限预设映射到现有的审批 UI。由于 OPFS 按源隔离，因此构造上就是单用户、单标签。

### Deployment facts already forced by the spike

在 headless Chromium 默认的临时存储后端下，OPFS 写入对同源兄弟页面不可见；改用磁盘型浏览器配置后它们才具备持久性。因此浏览器工作区部署要求持久化配置，而这本来就是现实的形态。这是浏览器存储的属性，而不是提供方缺陷——同一页面通过新句柄可以立即读到自己的写入。

## Alternatives considered

**让 agent 留在后端，把浏览器当作文件真源，把工作区同步到瘦执行器。** 已否决：它仍然需要后端，而这被产品方向排除；它还把持久性问题从浏览器存储移到一个同步协议。若 shell shim 无法达到可接受的保真度，它会保留为回退方案，因为真正的执行器可以运行真正的 `bash`。

**立即移植完整的 WASI bash。** 对第一个里程碑已否决：它是体积最大也最脆弱的选项，而 seam 并不要求它。`ctx.subprocess` 边界把保真度决策局限在一个提供方内；先交付 JS 命令子集，WASI bash 可以在不动 agent 栈的前提下替换该提供方。

**为探针使用内存文件系统提供方。** 第一个迭代接受，随后替换：OPFS 提供方证明了 `FileSystem` seam 运行在真实浏览器存储之上，并验证了 Map 无法验证的持久性论断。内存提供方已从探针删除。

**依赖浏览器默认的临时存储承载 OPFS。** 通过测量否决：同源兄弟页面看不到这些源私有写入。持久化配置的要求已记录在上文。

**为 `AsyncLocalStorage` 使用完整的 zone 风格上下文传播层。** 已推迟：Promise 恢复式 shim 对探针运行的顺序单 agent 驱动链是正确的，但支持并发 agent 的正式移植需要真正的上下文传播，而那本身是一个独立的包决策。

**从一开始就把 agent 放进 Web Worker。** 推迟到正式移植：探针运行在页面主线程以减少活动部件。Worker 属于 `dsh-agent-in-browser` 提案的一部分（同步 OPFS 访问句柄与响应式 UI 线程）。

## Acceptance criteria

- 探针在干净检出下通过 `spikes/browser-agent/` 内的 `node build.mjs && node run.mjs` 保持可运行，两页探针（agent 轮次，随后重载页面读取同一源的 OPFS）在无真实 API 密钥时通过。
- `packages/` 下存在 `dsh-fs-opfs` 提供方包，具备完整的 `FileSystem` seam、持久化版本号来源，并按仓库门禁达到每个文件 100% 覆盖率。
- 会话日志在浏览器中写入并回放：录制的会话在无密钥条件下从 IndexedDB/OPFS 重建，与宿主的回放输出一致。
- 现有 Web GUI 的对象层驱动页内 agent（本地适配器或页内网关），使用 OPFS 持有的工作区，不依赖宿主连接。
- 写出的工作区文件在持久化浏览器配置下经过页面重载后仍保留。
- `dsh-tool-fs` 中的 `Buffer.byteLength` 调用点用 `TextEncoder` 字节数修复，探针中的每一处 `node:*` shim 都由其所属包中的仓库内修复替换。
- 在第一个里程碑交付前，记录 shell shim 决策（JS 命令子集 vs WASI bash）及其对常见命令集的覆盖范围。

## Risks

- **Shell shim 保真度是决定进度的未知量。** JS POSIX 子集会丢失模型可能依赖的真实命令边界情况；WASI bash 构建是庞大而脆弱的依赖。seam 把风险局限在一个提供方内，但产品承诺取决于所选档次。
- **API 密钥存于浏览器存储。** 它们对机器用户可读，也能被浏览器开发者工具导出。这把部署限定在个人、单用户场景；共享部署需要不同的凭据方案，而这不在本方向的设计范围内。
- **DeepSeek API 的浏览器 CORS 未经验证。** 提供方针对可配置的 base URL 调用 `fetch`；`api.deepseek.com` 的 CORS 策略决定密钥在浏览器内的路径能否原样工作，还是需要代理（那会重新引入后端）。
- **`AsyncLocalStorage` shim 在并发下会错误归因。** 两个 agent 的轮次在同一页面上交错会互相覆写共享存储。正式移植在支持并发会话前必须先交付真正的上下文传播。
- **宿主能力被舍弃。** LSP、Codex/Claude Code subagent、终端、E2B 与原生对话框无法移植；产品预期不能假设浏览器表面包含它们。
- **浏览器存储的持久性依赖配置。** 探针证明了持久化配置；新的临时配置会丢失工作区。部署必须持有该配置。
