/** Serve the browser-agent page for manual frontend testing. */

import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(here, '../../.env')

async function browserConfig() {
  let text = ''
  try {
    text = await readFile(envPath, 'utf8')
  } catch {
    return 'window.__DSH_BROWSER_CONFIG__ = {};'
  }
  const valueOf = (name) => {
    const match = text.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^#\\r\\n]*))`, 'm'))
    return (match?.[1] ?? match?.[2] ?? match?.[3])?.trim() || undefined
  }
  return `window.__DSH_BROWSER_CONFIG__ = ${JSON.stringify({
    apiKey: valueOf('DEEPSEEK_API_KEY'),
    baseURL: valueOf('DEEPSEEK_BASE_URL'),
  })};`
}

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
  if (pathname === '/config.js') {
    response.writeHead(200, { 'content-type': 'text/javascript' })
    response.end(await browserConfig())
    return
  }
  const file = pathname === '/agent.js'
    ? resolve(here, 'dist/agent.js')
    : resolve(here, pathname === '/' ? 'index.html' : `.${pathname}`)
  try {
    const content = await readFile(file)
    response.writeHead(200, {
      'content-type': pathname.endsWith('.js') ? 'text/javascript' : 'text/html; charset=utf-8',
    })
    response.end(content)
  } catch {
    response.writeHead(404)
    response.end('not found')
  }
})

server.listen(4173, '127.0.0.1', () => {
  console.log('browser-agent frontend: http://127.0.0.1:4173/')
})
