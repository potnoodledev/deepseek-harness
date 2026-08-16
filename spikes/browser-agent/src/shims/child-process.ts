/** Browser `node:child_process` shim: native-command's `execFile` is dead in
 * this composition (no desktop opener, no native subprocess). */

export function execFile(_command, _args, _options, _callback) {
  const cb = typeof _options === 'function' ? _options : _callback
  const error = new Error('browser: native child_process.execFile is not available')
  if (typeof cb === 'function') {
    process.nextTick ? process.nextTick(() => cb(error)) : queueMicrotask(() => cb(error))
    return undefined
  }
  throw error
}
