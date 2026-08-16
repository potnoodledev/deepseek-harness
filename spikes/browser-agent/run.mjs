/**
 * Run the browser-agent spike: serve the built bundle over localhost (a
 * secure context, so crypto.randomUUID works) and drive it in headless
 * Chromium via Playwright, then assert the agent completed one read+write
 * turn against the in-browser filesystem.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, existsSync, readdirSync, mkdtempSync } from 'node:fs'
import os from 'node:os'
import http from 'node:http'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const playwrightEntry = resolve(root, 'apps/web/node_modules/playwright/index.js')

const html = readFileSync(resolve(here, 'index.html'), 'utf8')
const bundlePath = resolve(here, 'dist', 'agent.js')
if (!existsSync(bundlePath)) {
  console.error('dist/agent.js missing; run `node build.mjs` first')
  process.exit(2)
}
const bundle = readFileSync(bundlePath, 'utf8')

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname
  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(html)
    return
  }
  if (pathname === '/agent.js') {
    res.writeHead(200, { 'content-type': 'text/javascript' })
    res.end(bundle)
    return
  }
  res.writeHead(404)
  res.end('not found')
})

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen))
const port = server.address().port
const url = `http://127.0.0.1:${port}/`

function findChromium() {
  const cache = resolve(os.homedir(), '.cache', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  const candidates = readdirSync(cache)
    .filter((dir) => dir.startsWith('chromium-') && !dir.includes('headless'))
    .sort()
  for (const dir of [...candidates].reverse()) {
    for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell']) {
      const candidate = resolve(cache, dir, rel)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}

const playwright = await import(playwrightEntry)
const chromium = playwright.chromium ?? playwright.default?.chromium
const executablePath = findChromium()
console.log(`serving ${url} (chromium: ${executablePath ?? 'playwright default'})`)

// A disk-backed profile so OPFS (an origin-private store) is durable across
// pages and reloads — the realistic browser-workspace deployment shape.
const profileDir = mkdtempSync(resolve(os.tmpdir(), 'dsh-spike-profile-'))
const context = await chromium.launchPersistentContext(profileDir, {
  headless: true,
  ...(executablePath ? { executablePath } : {}),
})
const page = await context.newPage()
const deepSeekMode = process.env.BROWSER_AGENT_DEEPSEEK === '1'
if (deepSeekMode) {
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('BROWSER_AGENT_DEEPSEEK=1 requires DEEPSEEK_API_KEY')
  }
  await page.addInitScript(({ apiKey, baseURL }) => {
    window.__DSH_DEEPSEEK_API_KEY__ = apiKey
    if (baseURL !== undefined) window.__DSH_DEEPSEEK_BASE_URL__ = baseURL
  }, {
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL,
  })
}
const consoleMessages = []
const pageErrors = []
page.on('console', (msg) => consoleMessages.push(`[console.${msg.type()}] ${msg.text()}`))
page.on('pageerror', (error) => pageErrors.push(`[pageerror] ${error.message}`))

try {
  await page.goto(deepSeekMode ? `${url}?deepseek=1` : url, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => window.__SPIKE_RESULT__ !== undefined, { timeout: 60000 })
  const result = await page.evaluate(() => window.__SPIKE_RESULT__)
  console.log('result:', JSON.stringify(result, null, 2))

  const ok = result.ok === true
  const modelRequests = result.modelRequests
  const toolResults = result.toolResults ?? []
  const workspaceFile = result.workspaceFile
  const opfsReadback = result.opfsReadback
  const persistence = result.persistence ?? {}
  const shell = result.shell ?? {}
  const readOk = toolResults.some((t) => t.name === 'read' && !t.isError)
  const writeOk = toolResults.some((t) => t.name === 'write' && !t.isError)
  const shellToolOk = (shell.toolResults ?? []).some((t) => t.name === 'bash' && !t.isError)
  const shellFileOk = typeof shell.fileContent === 'string' && shell.fileContent.includes('built by the browser shell')

  console.log(`model requests: ${modelRequests} (expect 7)`)
  console.log(`tool results: ${JSON.stringify(toolResults)}`)
  console.log(`workspace file content: ${JSON.stringify(workspaceFile)}`)
  console.log(`fresh-handle OPFS readback: ${JSON.stringify(opfsReadback)}`)
  console.log(`persistence: ${JSON.stringify(persistence)}`)
  console.log(`shell: ${JSON.stringify(shell)}`)

  const persistenceOk =
    persistence.roundTripOk === true &&
    persistence.resumeContinuityOk === true &&
    persistence.newEventsAfterResume > 0 &&
    persistence.rawLineCount === persistence.totalEventsAfterResume + 1

  const pass =
    ok &&
    modelRequests === 7 &&
    readOk &&
    writeOk &&
    workspaceFile === 'written by the browser agent' &&
    opfsReadback === 'written by the browser agent' &&
    persistenceOk &&
    shellToolOk &&
    shellFileOk

  // GUI object-layer adapter: the in-process protocol round trip.
  const gui = result.gui ?? {}
  const guiConversation = gui.conversation ?? []
  const guiOk =
    gui.ok === true &&
    gui.sessionId !== null &&
    gui.listedSessions >= 1 &&
    guiConversation.some((e) => e.type === 'user/message') &&
    guiConversation.some((e) => e.type === 'tool/call' && e.toolName === 'read') &&
    guiConversation.some((e) => e.type === 'tool/result') &&
    guiConversation.some((e) => e.type === 'assistant/message') &&
    guiConversation.some((e) => e.type === 'turn/end')
  console.log(`gui (in-process gateway): sessionId=${JSON.stringify(gui.sessionId)} frames=${JSON.stringify(gui.muxFrameTypes)} conversation=${JSON.stringify(guiConversation)}`)

  // Reload the SAME tab (the realistic "user refreshes" case): OPFS is
  // origin-private and the renderer that wrote it reads its own commits;
  // sibling-renderer visibility proved unreliable in headless Chromium.
  let probePass = false
  if (pass && guiOk) {
    const probeConsole = []
    const probeErrors = []
    page.removeAllListeners('console')
    page.removeAllListeners('pageerror')
    page.on('console', (msg) => probeConsole.push(`[console.${msg.type()}] ${msg.text()}`))
    page.on('pageerror', (error) => probeErrors.push(`[pageerror] ${error.message}`))
    // Reload the existing document instead of navigating to a new renderer;
    // Chromium can briefly expose OPFS names without resolving handles from a
    // sibling renderer.
    await page.evaluate(() => history.replaceState({}, '', '?probe=1'))
    await page.reload({ waitUntil: 'domcontentloaded' })
    try {
      await page.waitForFunction(() => window.__SPIKE_RESULT__ !== undefined, { timeout: 30000 })
    } catch (error) {
      console.log('probe timed out; console:')
      for (const line of probeConsole) console.log(line)
      for (const line of probeErrors) console.log(line)
      throw error
    }
    const probe = await page.evaluate(() => window.__SPIKE_RESULT__)
    console.log(`probe (reloaded tab): ${JSON.stringify(probe)}`)
    probePass =
      probe.ok === true &&
      probe.opfsReadback === 'written by the browser agent' &&
      probe.shellOut.includes('built by the browser shell') &&
      probe.sessionLines !== null &&
      probe.sessionLines > 2 &&
      probe.sessionHasResume === true
  }

  console.log(pass && guiOk && probePass
    ? 'PASS: agent over OPFS, session persistence + resume, bash shim, and the in-process gateway (ApiProxy + InProcessApiClient) all work in the browser and survived a page reload'
    : 'FAIL')
  if (!pass || !probePass) {
    for (const line of consoleMessages) console.log(line)
    for (const line of pageErrors) console.log(line)
  }
  process.exitCode = pass && probePass ? 0 : 1
} finally {
  await context.close()
  await new Promise((resolveClose) => server.close(resolveClose))
}
