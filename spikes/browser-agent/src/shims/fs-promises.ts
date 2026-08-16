/** Browser `node:fs/promises` shim: the spike graph imports `realpath`,
 * `opendir` (home-paths watch canonicalization) and `mkdir`/`stat`
 * (api-proxy workspace materialization / cold-blank probes). `mkdir` is a
 * no-op here; `stat` reports a permissive empty directory so ENOENT can never
 * surprise an un-mocked path. */

export async function realpath(path) {
  return path
}

export function opendir(_path) {
  return {
    async *[Symbol.asyncIterator]() {},
    async close() {},
  }
}

export async function mkdir(_path, _options) {}

export async function stat(_path) {
  return { size: 0, isDirectory: () => true, isFile: () => false }
}

export async function access() {
  throw enoent()
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 }

/** Node's ENOENT error, the conventional "path is absent" signal. */
function enoent(): NodeJS.ErrnoException {
  const error = new Error('ENOENT: no such file or directory') as NodeJS.ErrnoException
  error.code = 'ENOENT'
  error.errno = -2
  return error
}

export async function readFile(_path, _encoding) {
  throw enoent()
}

export async function writeFile(_path, _content, _encoding) {}

export async function rename() {}

export async function readdir(_path) {
  return []
}

export async function rm() {}

export async function chmod() {}

export async function cp() {}

/** Minimal file-handle stand-in for storage-json's atomic writer: writes are
 * no-ops in the browser (the JSON unit stays in memory). */
export async function open() {
  return {
    async writeFile() {},
    async sync() {},
    async close() {},
  }
}
