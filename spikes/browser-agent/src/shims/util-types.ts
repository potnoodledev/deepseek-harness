/** Browser `node:util/types` shim: the agent package's only import is `isPromise`. */

export function isPromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise
}
