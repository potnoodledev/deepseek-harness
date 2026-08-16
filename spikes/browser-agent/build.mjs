/**
 * Build the browser-agent spike with Vite (resolved from apps/web's deps).
 * The inline plugin maps workspace package names to their src/ (from
 * tsconfig.base.json paths) and redirects the graph's five `node:*` imports
 * to browser shims, proving the host agent stack has no hidden Node surface.
 */

import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { readFileSync, existsSync } from 'node:fs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..')
const shimsDir = resolve(here, 'src', 'shims')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version

// JSONC-lite parse: remove line and block comments outside string literals
// (tsconfig.base.json carries comments beside values and on their own lines).
function stripJsonc(source) {
  let out = ''
  let inString = false
  let i = 0
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (inString) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 2; continue }
      if (ch === '"') inString = false
      i += 1
      continue
    }
    if (ch === '"') { inString = true; out += ch; i += 1; continue }
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 2
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const tsconfig = JSON.parse(stripJsonc(readFileSync(resolve(root, 'tsconfig.base.json'), 'utf8')))
const paths = tsconfig.compilerOptions.paths
const entries = Object.entries(paths).sort((a, b) => b[0].length - a[0].length)

const NODE_SHIMS = {
  'node:crypto': 'crypto.ts',
  'node:async_hooks': 'async-hooks.ts',
  'node:path': 'path.ts',
  'node:util/types': 'util-types.ts',
  'node:module': 'module.ts',
  'node:fs': 'fs.ts',
  'node:fs/promises': 'fs-promises.ts',
  'node:os': 'os.ts',
  'node:child_process': 'child-process.ts',
  'node:url': 'url.ts',
  'node:timers/promises': 'timers.ts',
}

const explicitEntries = entries.filter(([key]) => !key.includes('*'))
const wildcardEntries = entries.filter(([key]) => key.includes('*')).sort((a, b) => b[0].length - a[0].length)

function pathExists(candidate) {
  return (
    existsSync(candidate) ||
    existsSync(`${candidate}.ts`) ||
    existsSync(`${candidate}.tsx`) ||
    existsSync(`${candidate}.js`) ||
    existsSync(resolve(candidate, 'index.ts'))
  )
}

/** Resolve a directory-ish candidate to an actual loadable file path. */
function toFilePath(candidate) {
  if (existsSync(candidate)) {
    if (existsSync(resolve(candidate, 'index.ts'))) return resolve(candidate, 'index.ts')
    if (existsSync(resolve(candidate, 'index.js'))) return resolve(candidate, 'index.js')
    return candidate
  }
  if (existsSync(`${candidate}.ts`)) return `${candidate}.ts`
  if (existsSync(`${candidate}.tsx`)) return `${candidate}.tsx`
  if (existsSync(`${candidate}.js`)) return `${candidate}.js`
  return candidate
}

/** Resolve a workspace import to its src/, replicating tsconfig `paths` wildcard matching. */
function resolveWorkspaceId(source) {
  for (const [key, replacements] of explicitEntries) {
    if (source !== key && !source.startsWith(`${key}/`)) continue
    const suffix = source.slice(key.length)
    for (const replacement of replacements) {
      const candidate = resolve(root, replacement) + suffix
      if (pathExists(candidate)) return toFilePath(candidate)
    }
  }
  for (const [key, replacements] of wildcardEntries) {
    const starIndex = key.indexOf('*')
    const prefix = key.slice(0, starIndex)
    const suffix = key.slice(starIndex + 1)
    if (!source.startsWith(prefix) || !source.endsWith(suffix)) continue
    const star = source.slice(prefix.length, source.length - suffix.length)
    if (star === '') continue
    for (const replacement of replacements) {
      const candidate = resolve(root, replacement.replace('*', star))
      if (pathExists(candidate)) return toFilePath(candidate)
    }
  }
  return null
}

/** Vite plugin: workspace src resolution + node: shim redirection. */
const resolveWorkspaceSrc = {
  name: 'resolve-workspace-src',
  enforce: 'pre',
  resolveId(source, importer) {
    if (source.startsWith('node:')) {
      const shim = NODE_SHIMS[source]
      if (shim) return resolve(shimsDir, shim)
      console.error(`spike build: no browser shim for ${source} (imported by ${importer})`)
      throw new Error(`spike build: no browser shim for ${source}`)
    }
    if (!source.startsWith('@deepseek-ai/')) return null
    return resolveWorkspaceId(source)
  },
}

const viteEntry = resolve(root, 'apps/web/node_modules/vite/dist/node/index.js')
const { build } = await import(viteEntry)

await build({
  root: here,
  logLevel: 'info',
  plugins: [resolveWorkspaceSrc],
  define: { __DSH_VERSION__: JSON.stringify(version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    lib: { entry: resolve(here, 'src/entry.ts'), formats: ['es'], fileName: 'agent' },
    minify: false,
  },
})

console.log('spike build done -> spikes/browser-agent/dist/agent.js')
