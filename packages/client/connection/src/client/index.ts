/**
 * Browser wire client. The plugin selects fixture or HTTP transport, provides
 * the shared API client, and lets the runtime object layer start the stream
 * controller with its sinks.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { HostDescription, IApiClient } from './api.ts'
import { ConnectionController, type ConnectionConfig, type ConnectionSinks, type ConnectionState } from './connection.ts'
import { FixtureApiClient } from './fixture.ts'
import { WebApiClient } from './web-api-client.ts'
import { createWebConnectionRpc } from './rpc.ts'
import { isLoopbackHostname } from '../loopback-hostname.ts'
import type { ClientConnectionRpc } from '../rpc.ts'

// ---- Contract re-exports (browser-safe apiproxy channels + core types) ----
export type {
  ApiProxy, SessionsApi, SessionSearchItem, SessionSummary, PromptContentPart, HostApi, EventsApi, MuxFrame, HostFrame,
  ApprovalResponsePayload, QuestionResponsePayload, HistoryEntry, ToolEventView,
  DirectoryEntry, DirectoryListing,
  ToolCallView, ToolResultView, WorkspaceApi, WorkspaceId, WorkspaceView,
  SkillsApi, SkillEntry,
  ModelCatalogFailure, ModelCatalogModel, ModelProviderGroup, ModelReasoning,
  MessageId, ModelReasoningEffort, ModelSelection, QueueAction, QueuedInboxItem, SessionModels,
  SubagentsApi, SubagentAddress, SubagentCatalog, SubagentListEntry, SubagentPromptReceipt,
  JobView,
  RpcRequest, RpcResponse, RpcResult, RpcError, RpcErrorCode,
  ClientRequest, ServerResponse, ServerRequest, ClientResponse, RpcMessage, RpcReceipt,
  HostDescription, IApiClient, SessionId, SessionEvent, ContentBlock, StreamChunk,
  GoalsApi, GoalRef,
  SettingsApi, SettingsNamespaceView, SettingsPathOpView, SettingsSecretView,
  CredentialsApi, CredentialView, ConfigurableProviderView, DiscoveredModelView, LlmApi,
} from './api.ts'
export {
  RpcId,
  AbstractApiClient,
  transportError,
} from './api.ts'

// Connection loop types are public through ConnectionHandle.start; the
// controller remains package-internal.
export type { ConnectionConfig, ConnectionSinks, ConnectionState }
export type { ClientConnectionRpc } from '../rpc.ts'

/** Observable Host description published by each completed connection handshake. */
export interface HostDescriptionSource {
  /** Latest connected-generation description; absent before connect and while reconnecting. */
  getSnapshot(): HostDescription | undefined
  /** Subscribe to description replacement and connection loss. */
  subscribe(listener: () => void): () => void
}

/** Required services (none — this is the wire root). */
export const inject: string[] = []

/**
 * The ctx.connection service API: the API client plus a one-shot
 * controller starter (the runtime plugin supplies sinks when its object layer
 * is ready — connection stays consumer-agnostic).
 */
export interface ConnectionHandle {
  /** Shared api client (fixture or real, decided at boot from the page URL). */
  readonly api: IApiClient
  /** Whether the current page authority is loopback; non-browser contexts default to true. */
  readonly isLoopback: boolean
  /** Generation-scoped Host facts, including native path-open capability. */
  readonly hostDescription: HostDescriptionSource
  /** Generic logical RPC channels over the same Connection transport. */
  readonly rpc: ClientConnectionRpc
  /**
   * Start the connect/pump/reconnect loop with the consumer's frame sinks.
   * One consumer owns the streams (the runtime object layer); a second call
   * throws.
   * @param sinks - frame/state callbacks.
   * @param config - reconnect/backoff tunables.
   * @returns stop handle for the loop.
   */
  start(sinks: ConnectionSinks, config?: ConnectionConfig): { stop(): void }
}

declare global {
  interface Window {
    /** Optional app-provided local agent transport for browser-agent mode. */
    __DSH_BROWSER_AGENT__?: () => Promise<IApiClient>
  }
}

/** Delay API calls until the in-browser agent gateway has mounted. */
function deferredApi(ready: Promise<IApiClient>): IApiClient {
  return new Proxy({}, {
    get: (_target, group: string) => new Proxy({}, {
      get: (_nested, method: string) => {
        if (group === 'events') {
          return (...args: unknown[]) => (async function* () {
            const events = await ready
            const open = (events.events as unknown as Record<string, (...values: unknown[]) => AsyncIterable<unknown>>)[method]
            if (open === undefined) throw new Error(`connection: unknown event stream ${method}`)
            const stream = open(...args)
            yield* stream
          })()
        }
        return (...args: unknown[]) => ready.then((client) => {
          const service = (client as unknown as Record<string, Record<string, (...values: unknown[]) => unknown>>)[group]
          const call = service?.[method]
          if (call === undefined) throw new Error(`connection: unknown API method ${group}.${method}`)
          return call(...args)
        })
      },
    }),
  }) as IApiClient
}

/**
 * Client plugin body: pick the api by page mode and provide ctx.connection.
 * @param ctx - client cordis context.
 */
export function apply(ctx: Context): void {
  const pageLocation = typeof location === 'undefined' ? undefined : location
  const fixture = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('fixture')
  const browserAgent = pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('browser-agent')
    ? globalThis.window?.__DSH_BROWSER_AGENT__
    : undefined
  if (pageLocation !== undefined && new URLSearchParams(pageLocation.search).has('browser-agent') && browserAgent === undefined) {
    throw new Error('browser-agent mode was requested but its transport was not installed')
  }
  const fixtureClient = fixture ? new FixtureApiClient() : undefined
  const api: IApiClient = browserAgent === undefined
    ? fixtureClient ?? new WebApiClient()
    : deferredApi(browserAgent())
  const rpc = fixtureClient?.rpc ?? createWebConnectionRpc()
  let started = false
  let description: HostDescription | undefined
  const descriptionListeners = new Set<() => void>()
  const publishDescription = (next: HostDescription | undefined): void => {
    if (Object.is(description, next)) return
    description = next
    for (const listener of [...descriptionListeners]) {
      try {
        listener()
      } catch (error) {
        console.error('[web-runtime] host-description listener threw:', error)
      }
    }
  }
  const handle: ConnectionHandle = {
    api,
    isLoopback: pageLocation === undefined || isLoopbackHostname(pageLocation.hostname),
    hostDescription: {
      getSnapshot: () => description,
      subscribe: (listener) => {
        descriptionListeners.add(listener)
        return () => { descriptionListeners.delete(listener) }
      },
    },
    rpc,
    start(sinks, config) {
      if (started) throw new Error('connection: the stream loop is already owned by another consumer')
      started = true
      const controller = new ConnectionController(api, {
        ...sinks,
        onConnected: (next) => {
          publishDescription(next)
          // A description subscriber may synchronously stop the loop. In that
          // case publishDescription(undefined) has already retracted this
          // generation, so do not leak its stale connected notification to
          // the consumer sink afterward.
          if (!Object.is(description, next)) return
          sinks.onConnected?.(next)
        },
        onStateChange: (state) => {
          if (state === 'reconnecting') publishDescription(undefined)
          sinks.onStateChange?.(state)
        },
      }, config ?? {})
      controller.start()
      return {
        stop: () => {
          controller.stop()
          publishDescription(undefined)
        },
      }
    },
  }
  ctx.provide('connection', handle)
}
