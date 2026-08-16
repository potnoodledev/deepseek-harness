/** Browser entry: run the spike and publish the result for the Playwright harness. */

import './polyfills.ts'
import { drive } from './agent.ts'
import { createInteractiveGui, driveGui } from './gui.ts'
import { readSessionRaw } from './session-store.ts'

declare global {
  interface Window {
    __SPIKE_RESULT__?: Record<string, unknown>
  }
}

/** Probe mode: no agent run, just verify the workspace survived in OPFS. */
async function probe(): Promise<void> {
  const status = document.getElementById('status')
  const rootNames: string[] = []
  try {
    const root = await navigator.storage.getDirectory()
    for await (const [name] of root.entries()) rootNames.push(name)
    // OPFS commits may not be visible to a sibling page instantly; retry briefly.
    let text = ''
    let shellOut = ''
    let names: string[] = []
    const deadline = performance.now() + 8000
    for (;;) {
      try {
        // Reacquire the OPFS root on every attempt: Chromium can expose a
        // directory entry before a handle from the previous renderer can
        // resolve it after a reload.
        const freshRoot = await navigator.storage.getDirectory()
        const workspace = await freshRoot.getDirectoryHandle('workspace')
        names = []
        for await (const [name] of workspace.entries()) names.push(name)
        const notes = await workspace.getFileHandle('notes.txt')
        text = await (await notes.getFile()).text()
        shellOut = await (await (await workspace.getFileHandle('out.txt')).getFile()).text()
        break
      } catch (error) {
        if (performance.now() >= deadline) throw error
        await new Promise((resolve) => setTimeout(resolve, 200))
      }
    }
    const ok = text === 'written by the browser agent'
    const sessionRaw = await readSessionRaw('spike').catch(() => undefined)
    window.__SPIKE_RESULT__ = {
      ok,
      rootNames: rootNames.sort(),
      opfsEntries: names.sort(),
      opfsReadback: text,
      shellOut,
      sessionLines: sessionRaw === undefined ? null : sessionRaw.trimEnd().split('\n').length,
      sessionHasResume: sessionRaw !== undefined && sessionRaw.includes('resumed from the persisted log'),
    }
    if (status) status.textContent = ok ? 'PROBE OK' : 'PROBE FAILED'
    console.log('probe result:', JSON.stringify(window.__SPIKE_RESULT__))
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    window.__SPIKE_RESULT__ = { ok: false, error: message, phase: 'probe', seenNames: rootNames }
    if (status) status.textContent = 'PROBE FAILED'
    console.error(message)
  }
}

async function main(): Promise<void> {
  if (new URLSearchParams(location.search).get('probe') === '1') {
    await probe()
    return
  }
  if (new URLSearchParams(location.search).get('interactive') === '1') {
    await interactive()
    return
  }
  const status = document.getElementById('status')
  try {
    const result = await drive()
    const gui = await driveGui()
    window.__SPIKE_RESULT__ = { ...result, wallMs: Math.round(performance.now()), gui }
    if (status) status.textContent = result.ok && gui.ok ? 'SPIKE OK' : `SPIKE FAILED: ${result.error ?? gui.error ?? 'unknown'}`
    renderConversation(gui.conversation, result.error ?? gui.error)
    console.log('spike result:', JSON.stringify(result))
    console.log('gui result:', JSON.stringify(gui))
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    window.__SPIKE_RESULT__ = { ok: false, error: message }
    if (status) status.textContent = 'SPIKE FAILED'
    console.error(message)
  }
}

/** Interactive frontend mode: keep one gateway session alive behind a chat form. */
async function interactive(): Promise<void> {
  const status = document.getElementById('status')
  const input = document.getElementById('prompt') as HTMLInputElement | null
  const form = document.getElementById('composer') as HTMLFormElement | null
  try {
    const gui = await createInteractiveGui()
    const render = (): void => {
      renderConversation(gui.events.map((event) => ({
        seq: event.seq,
        type: event.type,
        ...(event.type === 'tool/call' ? { toolName: event.data.name } : {}),
      })))
    }
    gui.subscribe(render)
    render()
    if (status) status.textContent = `Session ${gui.sessionId} ready`
    form?.addEventListener('submit', (event) => {
      event.preventDefault()
      const text = input?.value.trim() ?? ''
      if (text === '') return
      if (input) input.value = ''
      void gui.prompt(text).catch((error: unknown) => {
        if (status) status.textContent = error instanceof Error ? error.message : String(error)
      })
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (status) status.textContent = `Failed: ${message}`
  }
}

/** Render the protocol-derived transcript for manual browser inspection. */
function renderConversation(
  conversation: Array<{ seq: number; type: string; toolName?: string }>,
  error?: string,
): void {
  const target = document.getElementById('conversation')
  if (target === null) return
  target.replaceChildren()
  if (error !== undefined) {
    const failure = document.createElement('div')
    failure.className = 'event tool'
    failure.textContent = error
    target.append(failure)
    return
  }
  for (const event of conversation) {
    const item = document.createElement('article')
    item.className = `event ${event.type.startsWith('user/') ? 'user' : event.type.startsWith('assistant/') ? 'assistant' : event.type === 'tool/call' || event.type === 'tool/result' ? 'tool' : ''}`
    const label = document.createElement('div')
    label.className = 'event-label'
    label.textContent = `#${String(event.seq)} ${event.type}`
    const body = document.createElement('div')
    body.className = 'event-body'
    body.textContent = event.toolName === undefined ? event.type : `${event.toolName} tool call`
    item.append(label, body)
    target.append(item)
  }
}

void main()
