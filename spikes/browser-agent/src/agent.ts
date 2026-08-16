/**
 * The browser-agent spike composition: the host-side agent stack
 * (agent-loop + session + system-prompt + tools + tool-fs) mounted in a
 * browser-grade JS environment, with browser-safe stand-ins for the
 * Node-quarantined providers (OPFS filesystem, scripted LLM). It drives one
 * read+write turn, persists the session log to OPFS, reloads it from a fresh
 * read, and resumes the same session id from the reconstructed events —
 * proving the log durably round-trips browser storage and the loop seeds from
 * it.
 */

import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent, type SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as ToolFs from '@deepseek-ai/dsh-tool-fs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as BashEnvPlugin from '@deepseek-ai/dsh-shell-env'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { MockAdapter, textResponse, toolCallResponse } from './mock-llm.ts'
import { OpfsFileSystem } from './opfs-fs.ts'
import { opfsReadFile } from './opfs-shell.ts'
import BrowserSubprocessRuntime from './browser-subprocess.ts'
import { loadSession, readSessionRaw, resetSessionStore, saveSession } from './session-store.ts'

/** One turn's transcript summary, JSON-safe for the page assertion. */
export interface SpikeResult {
  ok: boolean
  modelRequests: number
  events: Array<{ seq: number; type: string }>
  toolResults: Array<{ name: string; isError: boolean }>
  workspaceFile: string | null
  opfsReadback: string | null
  persistence: {
    savedEvents: number
    reloadedEvents: number
    roundTripOk: boolean
    totalEventsAfterResume: number
    newEventsAfterResume: number
    resumeContinuityOk: boolean
    rawLineCount: number | null
  } | null
  shell: {
    toolResults: Array<{ name: string; isError: boolean }>
    fileContent: string | null
  } | null
  error?: string
}

/** Event-based idle wait, with the `agent.status` poll as a safe fallback. */
async function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  await new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
    const poll = setInterval(() => {
      if (agent.status === 'idle') {
        clearInterval(poll)
        dispose()
        resolve()
      }
    }, 25)
  })
}

/** Mount the shared agent stack and the OPFS provider. */
export async function mountStack(ctx: Context): Promise<void> {
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(OpfsFileSystem, { cwd: '/workspace', seed: { 'hello.txt': 'hello from the browser filesystem\n' } })
  await ctx.plugin(ToolFs)
  await ctx.plugin(BrowserSubprocessRuntime)
  await ctx.plugin(BashEnvPlugin, {})
  await ctx.plugin(LocalJobRegistry)
  await ctx.plugin(LocalBashExecutor, { cwd: '/workspace', timeoutMs: 10_000 })
  await ctx.plugin(ToolBash)
}

/** Reset and re-seed the OPFS workspace once per run (boot-time, not per context). */
export async function prepareWorkspace(): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(OpfsFileSystem, { cwd: '/workspace', seed: { 'hello.txt': 'hello from the browser filesystem\n' } })
  await (ctx.fs as OpfsFileSystem).prepare()
  await ctx.fiber.dispose().catch(() => {})
}

interface TurnSummary {
  events: SessionEvent[]
  header: SessionHeader
  toolResults: Array<{ name: string; isError: boolean }>
  modelRequests: number
}

/** Run one turn on a (possibly seeded) agent and summarize it. */
async function runTurn(
  ctx: Context,
  adapter: MockAdapter,
  sessionId: SessionId,
  userText: string,
  seed?: readonly SessionEvent[],
): Promise<TurnSummary> {
  const handle = await ctx.agents.create({
    sessionId,
    ...(seed === undefined ? {} : { seed: [...seed], meta: { cwd: '/workspace' } }),
    agentOptions: { provider: 'mock', model: 'mock' },
  })
  const agent = handle.agent
  agent.followup(createUserMessage({ content: [{ type: 'text', text: userText }], source: { kind: 'user' } }))
  await waitForIdle(ctx, agent)

  const callNames = new Map<string, string>()
  const toolResults: Array<{ name: string; isError: boolean }> = []
  for (const event of agent.session.events) {
    if (event.type === 'tool/call') {
      callNames.set(String(event.data.callId), event.data.name)
    } else if (event.type === 'tool/result') {
      const source = event.data.message.source as { callId?: unknown }
      const callId = source?.callId === undefined ? '?' : String(source.callId)
      const content = event.data.message.content?.[0]
      toolResults.push({
        name: callNames.get(callId) ?? '?',
        isError: typeof content === 'object' && content !== null && 'isError' in content && (content as { isError?: unknown }).isError === true,
        ...(content !== undefined ? { content: JSON.stringify(content).slice(0, 200) } : {}),
      })
    }
  }
  const summary = { events: [...agent.session.events], header: agent.session.header, toolResults, modelRequests: adapter.requests.length }
  await handle.dispose()
  return summary
}

/** Mount the spike composition and drive the persist/reload/resume flow. */
export async function drive(): Promise<SpikeResult> {
  const sessionId = SessionId('spike')
  let result: SpikeResult
  try {
    await resetSessionStore()
    await prepareWorkspace()
    const ctx1 = new Context()
    await mountStack(ctx1)
    const adapter1 = new MockAdapter([
      toolCallResponse('c1', 'read', { file_path: 'hello.txt' }),
      toolCallResponse('c2', 'write', { file_path: 'notes.txt', content: 'written by the browser agent' }),
      textResponse('I read hello.txt and wrote notes.txt.'),
    ])
    ctx1.llm.registerAdapter(['mock'], adapter1)
    const turn1 = await runTurn(ctx1, adapter1, sessionId, 'read hello.txt, then write notes.txt')
    await ctx1.fiber.dispose().catch(() => {})

    const workspaceFile = await readWorkspaceFile()
    const opfsReadback = await freshOpfsReadback()

    // Persist the session log, then reload it from a fresh OPFS read.
    await saveSession(sessionId, turn1.header, turn1.events)
    const reloaded = await loadSession(sessionId)
    const reloadedEvents = reloaded?.events ?? []
    const roundTripOk = JSON.stringify(reloadedEvents) === JSON.stringify(turn1.events)

    // Resume the same session id from the reconstructed events.
    const ctx2 = new Context()
    await mountStack(ctx2)
    const adapter2 = new MockAdapter([
      toolCallResponse('c3', 'write', { file_path: 'resumed.txt', content: 'resumed from the persisted log' }),
      textResponse('I resumed and wrote resumed.txt.'),
    ])
    ctx2.llm.registerAdapter(['mock'], adapter2)
    const turn2 = await runTurn(ctx2, adapter2, sessionId, 'resume and write resumed.txt', reloadedEvents)
    await ctx2.fiber.dispose().catch(() => {})

    // Persist the resumed log too, so the artifact reflects the continued session.
    await saveSession(sessionId, turn2.header, turn2.events)
    const finalRaw = await readSessionRaw(sessionId)

    // Drive a bash tool call through the browser shell shim against OPFS.
    const ctx3 = new Context()
    await mountStack(ctx3)
    const adapter3 = new MockAdapter([
      toolCallResponse('c4', 'bash', {
        command: 'echo built by the browser shell > out.txt && cat out.txt && wc -w out.txt',
        description: 'write and read a file with the browser shell',
      }),
      textResponse('shell done.'),
    ])
    ctx3.llm.registerAdapter(['mock'], adapter3)
    const shellTurn = await runTurn(ctx3, adapter3, SessionId('shell'), 'run the shell command')
    await ctx3.fiber.dispose().catch(() => {})
    const shellFile = await opfsReadFile('/workspace/out.txt')

    result = {
      ok: true,
      modelRequests: turn1.modelRequests + turn2.modelRequests + shellTurn.modelRequests,
      events: turn1.events.map((event) => ({ seq: event.seq, type: event.type })),
      toolResults: turn1.toolResults,
      workspaceFile,
      opfsReadback,
      persistence: {
        savedEvents: turn1.events.length,
        reloadedEvents: reloadedEvents.length,
        roundTripOk,
        totalEventsAfterResume: turn2.events.length,
        newEventsAfterResume: turn2.events.length - turn1.events.length,
        resumeContinuityOk: turn2.events[turn1.events.length]?.seq === turn1.events.length,
        rawLineCount: finalRaw === undefined ? null : finalRaw.trimEnd().split('\n').length,
      },
      shell: {
        toolResults: shellTurn.toolResults,
        fileContent: shellFile,
      },
    }
  } catch (error) {
    result = {
      ok: false,
      modelRequests: 0,
      events: [],
      toolResults: [],
      workspaceFile: null,
      opfsReadback: null,
      persistence: null,
      shell: null,
      error: error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error),
    }
  }
  return result
}

/** Read the turn-1 workspace file through the OPFS provider path used by tools. */
async function readWorkspaceFile(): Promise<string | null> {
  const ctx = new Context()
  try {
    await ctx.plugin(OpfsFileSystem, { cwd: '/workspace' })
    return await ctx.fs.readText({ targetKey: '/workspace/notes.txt', displayPath: '/workspace/notes.txt' }).catch(() => null)
  } finally {
    await ctx.fiber.dispose().catch(() => {})
  }
}

/** Re-acquire a fresh OPFS handle (bypassing any provider) and read notes.txt. */
async function freshOpfsReadback(): Promise<string | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const workspace = await root.getDirectoryHandle('workspace')
    const notes = await workspace.getFileHandle('notes.txt')
    return (await (await notes.getFile()).text()).slice(0, 200)
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
