/**
 * The GUI object-layer adapter milestone: the shipped wire protocol runs
 * in-process in the browser. The real `ApiProxyService` (the web host's API
 * gateway) is mounted inside the same cordis context as the in-page agent,
 * and `toFetchHandler`/`InProcessApiClient` — the repository's own isomorphic
 * transport seam — bridge the client API to it with zero HTTP. The client
 * then drives a session through the real RPC surface (`session.create`,
 * `session.list`, `session.prompt`) and consumes the real `events.mux` SSE
 * stream, reconstructing the conversation from `session/event` frames.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import ApiProxyService, { RpcId, toFetchHandler, InProcessApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import type { MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import AgentDefaultModelConfig from '@deepseek-ai/dsh-agent-default-model'
import { apply as applyDeepSeek } from '@deepseek-ai/dsh-llm-deepseek'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import AttachmentStore from '@deepseek-ai/dsh-attachment'
import DirectoryPicker from '@deepseek-ai/dsh-host-directory-picker'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as applyJsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { apply as applyStorageDomain } from '@deepseek-ai/dsh-storage-domain'
import SettingsProvider, { type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { apply as applySettingsGeneral } from '@deepseek-ai/dsh-client-ui-settings-general'
import BrowserSessionPersistence from './browser-session-persistence.ts'
import BrowserCredentials from './browser-credentials.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy'
import { MockAdapter, textResponse, toolCallResponse } from './mock-llm.ts'
import { mountStack } from './agent.ts'

/** Stub: session search is out of the browser spike's scope. */
class SessionQueryStub extends SessionQueryEngine {
  override async searchSessions(): Promise<never> {
    throw new Error('browser spike: session search not supported')
  }

  override async searchEvents(): Promise<never> {
    throw new Error('browser spike: session search not supported')
  }
}

/** Stub: image attachments are out of the browser spike's scope. */
class AttachmentStub extends AttachmentStore {
  override readonly imageLimits = {
    maxImageBytes: 0,
    maxMessageImageBytes: 0,
    maxImagePixels: 0,
  }

  override async validateImage(): Promise<never> {
    throw new Error('browser spike: image attachments not supported')
  }

  override async saveImage(): Promise<never> {
    throw new Error('browser spike: image attachments not supported')
  }

  override async readImage(): Promise<never> {
    throw new Error('browser spike: image attachments not supported')
  }
}

/** Stub: native directory dialogs are out of the browser spike's scope. */
class DirectoryPickerStub extends DirectoryPicker {
  override capability() {
    const unavailable = async (): Promise<never> => {
      throw new Error('browser spike: directory picking not supported')
    }
    return { kind: 'browse', list: unavailable, createDirectory: unavailable }
  }
}

/** Writable browser settings document used by the in-page API gateway. */
class BrowserSettings extends SettingsProvider {
  readonly writable = true
  private document: Record<string, unknown>

  constructor(ctx: Context) {
    super(ctx)
    this.document = {}
    const raw = globalThis.localStorage?.getItem('dsh:settings')
    if (raw !== null && raw !== undefined) {
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          this.document = parsed as Record<string, unknown>
        }
      } catch {
        // Ignore an unreadable browser document; the next successful write replaces it.
      }
    }
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.document))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.document[String(ns)] = structuredClone(section)
    globalThis.localStorage?.setItem('dsh:settings', JSON.stringify(this.document))
    return Promise.resolve()
  }
}

/** Whether browser configuration selects the real DeepSeek adapter. */
function hasBrowserDeepSeekKey(): boolean {
  return new URLSearchParams(location.search).has('deepseek')
    || globalThis.window?.__DSH_DEEPSEEK_API_KEY__ !== undefined
    || globalThis.window?.__DSH_BROWSER_CONFIG__?.apiKey !== undefined
    || globalThis.localStorage?.getItem('dsh:credential:DEEPSEEK_API_KEY') !== null
}

/** Mount the agent stack plus every service the ApiProxy gateway injects. */
async function mountGuiStack(ctx: Context): Promise<void> {
  await mountStack(ctx)
  const deepSeek = hasBrowserDeepSeekKey()
  await ctx.plugin(BrowserCredentials)
  await ctx.plugin({ inject: ['llm', 'credentials'], apply: applyDeepSeek }, {
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: globalThis.window?.__DSH_DEEPSEEK_BASE_URL__ ?? globalThis.window?.__DSH_BROWSER_CONFIG__?.baseURL,
  })
  await ctx.plugin(BrowserSessionPersistence)
  await ctx.plugin(Storage)
  await ctx.plugin({ inject: ['storage'], apply: applyJsonStorageBackend }, { root: '/browser-storage' })
  await ctx.plugin({ inject: ['storage'], apply: applyStorageDomain }, { backend: 'json' })
  await ctx.plugin(BrowserSettings)
  await ctx.plugin({ inject: ['settings'], apply: applySettingsGeneral })
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentDefaultModelConfig, {
    provider: deepSeek ? 'deepseek-official' : 'mock',
    model: deepSeek ? 'deepseek-chat' : 'mock',
  })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SessionQueryStub)
  await ctx.plugin(AttachmentStub)
  await ctx.plugin(DirectoryPickerStub)
  await ctx.plugin(ApiProxyService, { nativeOpen: false })
}

/** JSON-safe summary of the in-process protocol round trip. */
export interface GuiResult {
  ok: boolean
  sessionId: string | null
  listedSessions: number
  muxFrameTypes: string[]
  sessionEventTypes: string[]
  conversation: Array<{ seq: number; type: string; toolName?: string }>
  error?: string
}

/** Live browser session handle used by the manual frontend. */
export interface InteractiveGui {
  readonly sessionId: string
  readonly events: SessionEvent[]
  prompt(text: string): Promise<void>
  subscribe(listener: () => void): () => void
  dispose(): Promise<void>
}

/** Mount the spike gateway and expose its normal client transport to the web runtime. */
export async function createBrowserAgentApi(): Promise<IApiClient> {
  const ctx = new Context()
  await mountGuiStack(ctx)
  const deepSeek = hasBrowserDeepSeekKey()
  if (!deepSeek) {
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Mock response from the browser agent.')], undefined, undefined, true))
  }
  return new InProcessApiClient(toFetchHandler(ctx.apiProxy))
}

/** Mount one persistent in-process session for the interactive browser page. */
export async function createInteractiveGui(): Promise<InteractiveGui> {
  const ctx = new Context()
  await mountGuiStack(ctx)
  const deepSeek = hasBrowserDeepSeekKey()
  if (!deepSeek) {
    ctx.llm.registerAdapter(['mock'], new MockAdapter([textResponse('Mock response from the browser agent.')], undefined, undefined, true))
  }
  const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
  const controller = new AbortController()
  const events: SessionEvent[] = []
  const listeners = new Set<() => void>()
  const stream = (async () => {
    try {
      for await (const frame of client.events.mux({}, controller.signal)) {
        if (frame.payload.type !== 'session/event') continue
        events.push(frame.payload.event)
        for (const listener of [...listeners]) listener()
      }
    } catch {
      // Aborting the session controller ends the local stream during dispose.
    }
  })()
  const created = await client.sessions.create({ cwd: '/workspace' })
  if (!created.result.ok) {
    controller.abort()
    await ctx.fiber.dispose().catch(() => {})
    throw new Error(`session.create failed: ${created.result.error.message}`)
  }
  const sessionId = String(created.result.value.sessionId)
  return {
    sessionId,
    events,
    async prompt(text: string): Promise<void> {
      const response = await client.sessions.prompt({
        sessionId: created.result.value.sessionId,
        mode: 'queue',
        content: [{ type: 'text', text }],
      })
      if (!response.result.ok) throw new Error(`session.prompt failed: ${response.result.error.message}`)
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async dispose(): Promise<void> {
      controller.abort()
      await stream.catch(() => {})
      await ctx.fiber.dispose().catch(() => {})
    },
  }
}

/** Poll the collected mux frames until the session's turn closes. */
async function waitForTurnEnd(frames: MuxFrame[], sessionId: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const ended = frames.some(
      (frame) => frame.type === 'session/event'
        && String(frame.sessionId) === sessionId
        && frame.event.type === 'turn/end',
    )
    if (ended) return
    if (Date.now() >= deadline) throw new Error('timed out waiting for the session turn to close')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

/** Drive one session through the in-process gateway and summarize the frames. */
export async function driveGui(): Promise<GuiResult> {
  const ctx = new Context()
  let muxFrames: MuxFrame[] = []
  let sessionEvents: SessionEvent[] = []
  try {
    await mountGuiStack(ctx)

    const deepSeek = hasBrowserDeepSeekKey()
    if (!deepSeek) {
      const adapter = new MockAdapter([
        toolCallResponse('g1', 'read', { file_path: 'hello.txt' }),
        textResponse('I read hello.txt through the in-process gateway.'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
    }

    const client = new InProcessApiClient(toFetchHandler(ctx.apiProxy))
    const ac = new AbortController()
    void (async () => {
      try {
        for await (const frame of client.events.mux({}, ac.signal)) {
          muxFrames.push(frame.payload)
        }
      } catch {
        // abort at teardown
      }
    })()

    const created = await client.sessions.create({ cwd: '/workspace' })
    if (!created.result.ok) throw new Error(`session.create failed: ${created.result.error.code}: ${created.result.error.message}`)
    const sessionId = created.result.value.sessionId

    const listed = await client.sessions.list({})
    if (!listed.result.ok) throw new Error('session.list failed')

    const prompted = await client.sessions.prompt({
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text: 'read hello.txt' }],
    })
    if (!prompted.result.ok) throw new Error(`session.prompt failed: ${prompted.result.error.code}: ${prompted.result.error.message}`)

    await waitForTurnEnd(muxFrames, String(sessionId), 30_000)
    ac.abort()

    sessionEvents = muxFrames
      .filter((frame) => frame.type === 'session/event' && String(frame.sessionId) === String(sessionId))
      .map((frame) => (frame as { type: 'session/event'; event: SessionEvent }).event)

    return {
      ok: true,
      sessionId: String(sessionId),
      listedSessions: listed.result.value.items.length,
      muxFrameTypes: [...new Set(muxFrames.map((frame) => frame.type))],
      sessionEventTypes: [...new Set(sessionEvents.map((event) => event.type))],
      conversation: sessionEvents.map((event) => ({
        seq: event.seq,
        type: event.type,
        ...(event.type === 'tool/call' ? { toolName: event.data.name } : {}),
      })),
    }
  } catch (error) {
    // Surface the gateway's own error, which the handler folds into a 500.
    let proxyError: string | undefined
    try {
      const direct = await ctx.apiProxy.sessions.create({ rpcId: RpcId('debug'), payload: { cwd: '/workspace' } })
      proxyError = JSON.stringify(direct)
    } catch (directError) {
      proxyError = directError instanceof Error ? `${directError.message}\n${directError.stack ?? ''}` : String(directError)
    }
    return {
      ok: false,
      sessionId: null,
      listedSessions: 0,
      muxFrameTypes: muxFrames.map((frame) => frame.type),
      sessionEventTypes: sessionEvents.map((event) => event.type),
      conversation: sessionEvents.map((event) => ({ seq: event.seq, type: event.type })),
      error: `client: ${error instanceof Error ? error.message : String(error)}; proxy: ${proxyError ?? 'n/a'}`,
    }
  } finally {
    await ctx.fiber.dispose().catch(() => {})
  }
}
