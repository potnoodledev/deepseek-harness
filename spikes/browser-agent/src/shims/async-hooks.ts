/**
 * Browser AsyncLocalStorage shim for the browser-agent spike. `run()` keeps
 * the store readable for the whole operation it wraps and restores the
 * previous store only after the returned promise settles, giving correct
 * semantics for the single sequential driver chain the spike runs. It is not
 * a general zone implementation: concurrent interleaved `run()` calls would
 * misattribute. The real port needs a full Promise-patching context
 * propagation layer (the WebContainers-style decision).
 */

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown } | null)?.then === 'function'

export class AsyncLocalStorage<T> {
  private current: T | undefined

  run(store: T, callback: (...args: unknown[]) => unknown): unknown {
    const previous = this.current
    this.current = store
    try {
      const result = callback()
      if (isThenable(result)) {
        return Promise.resolve(result).finally(() => {
          this.current = previous
        })
      }
      this.current = previous
      return result
    } catch (error) {
      this.current = previous
      throw error
    }
  }

  getStore(): T | undefined {
    return this.current
  }

  disable(): void {
    this.current = undefined
  }
}

/** No-op resource holder; nothing in the spike graph binds resources. */
export class AsyncResource {
  constructor(_type?: string) {}

  runInAsyncScope<T>(callback: () => T): T {
    return callback()
  }
}
