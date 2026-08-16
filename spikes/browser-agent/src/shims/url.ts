/** Browser `node:url` shim: the spike graph imports `pathToFileURL` and
 * `fileURLToPath`. */

export function pathToFileURL(path) {
  return new URL(`file://${path}`)
}

export function fileURLToPath(url) {
  return typeof url === 'string' ? url : String(url)
}
