# Agent Note: Browser-Held Workspace Agent Runtime

Status: proposed

English | [中文](2026-08-16-browser-held-workspace-agent-runtime.zh.md)

## Problem

The product direction is a workspace held entirely in the browser: the project files the agent works on live in the Origin Private File System (OPFS), there is no backend, and the whole experience is driven from the browser. That direction contradicts the shipped runtime shape. The `dsh web` host runs the agent loop, the session log, the tool registry, the filesystem tools, and the LLM consumers in a Node process, and the browser is presentation-only by design ([Web AGENTS.md](../../../../packages/client/AGENTS.md)); nothing model-visible is computed in the browser. A browser-held workspace therefore requires the model-facing agent stack to execute in a browser, which had never been assembled or driven there.

Feasibility rested on two unmeasured claims. The host stack's Node surface was unmapped — the packages that must move have dependencies, and those dependencies have their own. And the composition could not be exercised in a browser: mounting `agent-loop` plus `session`, `system-prompt`, `tools`, `tool-fs`, and `llm`, registering an in-browser filesystem provider and a scripted LLM adapter, and driving one multi-tool turn had never run outside Node.

## Proposal

Run the same host-side cordis plugins in the browser on top of browser providers for the Node-quarantined seams, keeping the model-facing packages unchanged. The browser is a new execution surface for the agent stack, not a rewrite of it. A spike under `spikes/browser-agent/` ([composition](../../../../spikes/browser-agent/src/agent.ts), [build](../../../../spikes/browser-agent/build.mjs), [runner](../../../../spikes/browser-agent/run.mjs)) already proves the core claim in headless Chromium: the composition completes a full read-then-write turn against a browser-held filesystem, emits a 72-event session log with two tool executions, and the written file survives a page reload in OPFS. The same spike then drives a real `bash` tool call through the shipped `tool-bash`/`bash-local` stack over a browser `subprocess` provider (`spikes/browser-agent/src/browser-subprocess.ts` + `js-shell.ts`) against OPFS, and persists and resumes a session log from OPFS JSONL.

### The measured Node surface

The whole composition's Node surface is seven `node:*` imports across four host packages and one hidden Node global:

| Import | Package | Browser replacement |
| --- | --- | --- |
| `node:crypto` `randomUUID` | `dsh-agent-loop` | `crypto.randomUUID()` |
| `node:async_hooks` `AsyncLocalStorage` | `dsh-agent` | Promise-restore shim ([spike shim](../../../../spikes/browser-agent/src/shims/async-hooks.ts)) |
| `node:util/types` `isPromise` | `dsh-agent` | `value instanceof Promise` |
| `node:path` `isAbsolute` | `dsh-session` | POSIX check |
| `node:module` `createRequire` | `dsh-llm` | build-time version define ([spike shim](../../../../spikes/browser-agent/src/shims/module.ts)) |
| `node:fs` / `node:os` | `dsh-sandbox` roots | path-identity stubs (dead in this composition) |
| `Buffer.byteLength` (global) | `dsh-tool-fs` `read-render.ts:74` | the port fixes the call site with a `TextEncoder` byte count, not a polyfill |

The spike ships these as `src/shims/*` plus a one-line `Buffer` polyfill in `src/polyfills.ts`; the real port replaces the shims with in-repo fixes (each is a small, named change in the owning package) and the `Buffer` polyfill with the call-site fix.

### Browser providers to build

New packages under `packages/`, one per seam, following the repo's package checklist:

- `dsh-fs-opfs` — the `FileSystem` seam over `navigator.storage.getDirectory()`. The spike's `src/opfs-fs.ts` is a working draft: all twelve primitives, async `prepare()` (OPFS init is async), and write/edit through `createWritable()` for atomicity. Versions are an in-memory counter in the draft; the real provider needs a durable version source (OPFS file metadata or a sidecar store) because the observation-policy version guards must survive reloads.
- `dsh-session-persistence-idb` — the JSONL session log and attachments over IndexedDB, keeping the model-visible-equals-logged rule intact and making in-browser replay work keyless.
- `dsh-subprocess-wasm` — the shell shim, implementing `SubprocessRuntime.spawn`/`spawnTerminal` over a WASI or JS shell bound to the OPFS filesystem. The `bash` tool and `bash-local` executor ride `ctx.subprocess` unchanged. The first milestone ships the JS POSIX command-subset tier, decided and proven in the spike (`src/js-shell.ts`): quotes and escapes, `;`/`&&`/`||` sequencing, whole-output `|` pipelines, `>`/`>>`/`2>`/`2>>`/`<` redirection, `$VAR`/`${VAR}`/`$?` expansion, leading assignments, and the built-ins `cd pwd echo printf cat ls mkdir rm touch cp mv head tail grep sed wc find true false exit export`; globbing, `$(...)`, background `&`, and control-flow keywords are documented gaps. WASI bash stays a seam-level replacement, not a separate branch.
- `dsh-credentials-web` / `dsh-settings-web` — the API key and settings over browser storage. Browser-held keys are readable by the machine's user: acceptable for a personal tool, never for a shared deployment.
- `dsh-agent-in-browser` — the browser entry: a Web Worker running the agent stack (the spike runs on the page main thread), plus a local adapter that feeds the existing `dsh-client-runtime` object layer from in-process services instead of the host, or mounts the transport-agnostic api-gateway in-page.

Dropped by design: real subprocesses (LSP, Codex/Claude Code subagents, E2B), terminal sessions, native OS dialogs, and the host sandbox stack — the browser is the sandbox, and permission presets map onto the existing approval UI. Single-user and single-tab by construction, because OPFS is per-origin.

### Deployment facts already forced by the spike

OPFS writes were invisible to a sibling page under headless Chromium's default ephemeral storage backend; a disk-backed browser profile makes them durable. The browser-workspace deployment therefore requires a persistent profile, which is the realistic shape anyway. This is a browser-storage property, not a provider defect — the same page reads its own writes through a fresh handle immediately.

## Alternatives considered

**Keep the agent on a backend and treat the browser as the file source of truth, syncing the workspace to a thin executor.** Rejected: it still needs a backend, which the direction excludes, and it moves the durability question from browser storage to a sync protocol. It remains the fallback if the shell shim cannot reach acceptable fidelity, because a real executor can run real `bash`.

**Port a full WASI bash immediately.** Rejected for the first milestone: it is the largest and most fragile option, and the seam does not require it. The `ctx.subprocess` boundary keeps the fidelity decision local to one provider; a JS command subset ships first and WASI bash can replace the provider without touching the agent stack.

**Use an in-memory filesystem provider for the spike.** Accepted for the first iteration, then replaced: the OPFS provider proves the `FileSystem` seam over real browser storage and the durability claim that a Map cannot. The in-memory provider was deleted from the spike.

**Rely on the browser's default ephemeral storage for OPFS.** Rejected by measurement: a sibling page could not see the origin-private writes. The persistent-profile requirement is recorded above.

**Use a full zone-style context-propagation layer for `AsyncLocalStorage`.** Deferred: the Promise-restore shim is correct for the sequential single-agent driver chain the spike runs, but a real port with concurrent agents needs real context propagation, and that is its own package decision.

**Keep the agent in a Web Worker from the start.** Deferred to the real port: the spike runs on the page main thread to reduce moving parts. The worker is part of the `dsh-agent-in-browser` proposal (sync OPFS access handles and a responsive UI thread).

## Acceptance criteria

- The spike remains runnable from a clean checkout with `node build.mjs && node run.mjs` under `spikes/browser-agent/`, and the two-page probe (agent turn, then a reloaded page reading the same origin's OPFS) passes without a real API key.
- A `dsh-fs-opfs` provider package exists under `packages/` with the full `FileSystem` seam, a durable version source, and per-file 100% coverage per the repo gate.
- The session log writes and replays in the browser: a recorded session reconstructs keyless from IndexedDB/OPFS, matching the host's replay output.
- The existing web GUI's object layer drives an in-page agent (local adapter or in-page gateway) with an OPFS-backed workspace, without the host connection.
- A written workspace file survives a page reload in a persistent browser profile.
- The `Buffer.byteLength` call site in `dsh-tool-fs` is fixed with a `TextEncoder` byte count, and every `node:*` shim in the spike is replaced by an in-repo fix in its owning package.
- The shell shim decision (JS command subset vs WASI bash) is recorded with its coverage of the common command set before the first milestone ships.

## Risks

- **Shell shim fidelity is the schedule-driving unknown.** A JS POSIX subset drops real-world command edge cases the model may depend on; a WASI bash build is a large, fragile dependency. The seam localizes the risk to one provider, but the product promise depends on the tier chosen.
- **API keys live in browser storage.** They are readable by the machine's user and exported by browser devtools. This bounds the deployment to personal, single-user use; a shared deployment needs a different credential story, which this direction does not design.
- **DeepSeek API browser CORS is unverified.** The provider calls `fetch` against a configurable base URL; `api.deepseek.com`'s CORS policy decides whether the key-in-browser path works as-is or needs a proxy (which would reintroduce a backend).
- **The `AsyncLocalStorage` shim misattributes under concurrency.** Two agents' turns interleaving on one page would clobber the shared store. The real port must ship real context propagation before concurrent sessions.
- **Host capabilities are dropped.** LSP, Codex/Claude Code subagents, terminal, E2B, and native dialogs do not port; product expectations must not assume them in the browser surface.
- **Browser-storage durability is profile-dependent.** The spike proved a persistent profile; a fresh ephemeral profile loses the workspace. The deployment must own the profile.
