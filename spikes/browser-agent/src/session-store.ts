/**
 * Browser session-log store for the browser-agent spike: one JSONL artifact
 * per session in the Origin Private File System, mirroring the host's
 * per-session JSONL layout so the same storage shape (a durable log the loop
 * can seed and resume from) exists browser-side. The first line is a
 * `type: 'session'` header record; every following line is one session event
 * as JSON. This is the persistence primitive the real `SessionPersistence`
 * browser provider builds on; the full interface (prepare/load/inspect/
 * readFrom/readRaw and crash recovery) is out of the spike's scope.
 */

import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'

const SESSIONS_DIR = 'sessions'

/** A persisted session artifact read back into its header and event list. */
export interface PersistedSession {
  header: SessionHeader
  events: SessionEvent[]
}

/** Encode a session id as one safe OPFS path segment (the spike uses plain ids). */
function encodeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, (ch) => `~${ch.codePointAt(0).toString(16)}`)
}

async function sessionsDir(create: boolean): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory()
  return root.getDirectoryHandle(SESSIONS_DIR, { create })
}

/** Remove the sessions store so a run starts from a known empty artifact set. */
export async function resetSessionStore(): Promise<void> {
  const root = await navigator.storage.getDirectory()
  try {
    await root.removeEntry(SESSIONS_DIR, { recursive: true })
  } catch {
    // absent store: nothing to clear
  }
}

/** Durably write one session's header and events as a JSONL artifact in OPFS. */
export async function saveSession(id: SessionId, header: SessionHeader, events: readonly SessionEvent[]): Promise<void> {
  const dir = await sessionsDir(true)
  const file = await dir.getFileHandle(`${encodeId(id)}.jsonl`, { create: true })
  const lines = [
    JSON.stringify({ type: 'session', ...header }),
    ...events.map((event) => JSON.stringify(event)),
  ]
  const writable = await file.createWritable()
  await writable.write(`${lines.join('\n')}\n`)
  await writable.close()
}

/** Read and parse a session artifact from OPFS, or undefined when absent. */
export async function loadSession(id: SessionId): Promise<PersistedSession | undefined> {
  const dir = await sessionsDir(false)
  let file: FileSystemFileHandle
  try {
    file = await dir.getFileHandle(`${encodeId(id)}.jsonl`)
  } catch {
    return undefined
  }
  const text = await (await file.getFile()).text()
  const lines = text.trimEnd().split('\n').filter((line) => line.length > 0)
  if (lines.length === 0) return undefined
  const headerLine = JSON.parse(lines[0]) as SessionHeader & { type?: string }
  const header: SessionHeader = { ...headerLine } as SessionHeader
  const events = lines.slice(1).map((line) => JSON.parse(line) as SessionEvent)
  return { header, events }
}

/** Read the raw artifact text so a reload probe can assert its bytes. */
export async function readSessionRaw(id: SessionId): Promise<string | undefined> {
  const dir = await sessionsDir(false)
  try {
    const file = await dir.getFileHandle(`${encodeId(id)}.jsonl`)
    return await (await file.getFile()).text()
  } catch {
    return undefined
  }
}
