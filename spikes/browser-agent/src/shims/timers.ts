/** Browser `node:timers/promises` shim: the cordis include plugin imports
 * the promise-form `setTimeout`. */

export function setTimeout(ms, value) {
  return new Promise((resolve) => {
    globalThis.setTimeout(() => resolve(value), ms)
  })
}
