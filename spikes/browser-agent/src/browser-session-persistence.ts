/**
 * Minimal in-memory `SessionPersistence` provider for the browser spike: the
 * abstract seam implemented over a Map so the workspace registry and API
 * gateway mount (their injects must resolve). Nothing is durable — the real
 * port is the OPFS/IndexedDB provider from the Agent Note. `list()` returns
 * the in-memory headers; `load`/`inspect`/`readFrom` read the stored events.
 */

import { Context } from '@deepseek-ai/cordis'
import { SessionPersistence, type SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

/** Browser in-memory session persistence for the GUI gateway spike. */
export class BrowserSessionPersistence extends SessionPersistence {
  private readonly headers = new Map<string, SessionHeader>()
  private readonly logs = new Map<string, SessionEvent[]>()

  constructor(ctx: Context) {
    super(ctx)
  }

  override locate(_meta: SessionHeader) {
    return undefined
  }

  override readonly supportsRawArtifacts = false

  override async create(meta: SessionHeader): Promise<void> {
    this.headers.set(String(meta.id), meta)
    this.logs.set(String(meta.id), [])
  }

  override async append(id: SessionId, events: readonly SessionEvent[]): Promise<void> {
    const key = String(id)
    this.logs.set(key, [...(this.logs.get(key) ?? []), ...events])
  }

  override async load(id: SessionId): Promise<SessionInspection> {
    const key = String(id)
    const meta = this.headers.get(key)
    if (meta === undefined) throw new Error(`browser persistence: no session ${key}`)
    return { meta, events: this.logs.get(key) ?? [] }
  }

  override async inspect(id: SessionId): Promise<SessionInspection> {
    return this.load(id)
  }

  override async readFrom(id: SessionId, fromSeq: number): Promise<{ meta: SessionHeader; events: SessionEvent[] }> {
    const loaded = await this.load(id)
    return { meta: loaded.meta, events: loaded.events.filter((event) => event.seq >= fromSeq) }
  }

  override async list(): Promise<SessionHeader[]> {
    return [...this.headers.values()]
  }

  override async listSnapshots() {
    return []
  }
}

export default BrowserSessionPersistence
