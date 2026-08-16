/** Browser `node:fs` shim: the spike graph imports `realpathSync` (sandbox
 * roots) and `accessSync`/`statSync`/`constants` (subagent out-of-process
 * probes) — all dead in this composition, which spawns no real subprocess. */

export const realpathSync = Object.assign(
  (path) => path,
  { native: (path) => path },
)

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }

const files = new Map<string, string>()

export function mkdirSync() {}

export function readFileSync(path) {
  const value = files.get(path)
  if (value === undefined) {
    const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
    error.code = 'ENOENT'
    throw error
  }
  return value
}

export function writeFileSync(path, content, options) {
  if (typeof options === 'object' && options?.flag === 'wx' && files.has(path)) {
    const error = new Error('EEXIST: file already exists') as NodeJS.ErrnoException
    error.code = 'EEXIST'
    throw error
  }
  files.set(path, String(content))
}

export function accessSync() {}

export function statSync(path) {
  return {
    path,
    isDirectory: () => false,
    isFile: () => true,
    size: 0,
  }
}
