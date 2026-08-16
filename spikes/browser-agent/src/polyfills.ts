/** Browser Buffer polyfill for the spike: `Buffer.byteLength` (used by
 * tool-fs read-render) with no Node global. The real port should replace the
 * call site with a TextEncoder byte count instead of shipping a polyfill. */

globalThis.Buffer ??= {
  byteLength(input: string | Uint8Array): number {
    return typeof input === 'string' ? new TextEncoder().encode(input).length : input.length
  },
} as unknown as BufferConstructor

/** Minimal `process` global: shell-env's home resolution reads `process.env`
 * in its default argument, and ApiProxyService defaults the host cwd from
 * `process.cwd()`. The real port removes the Node defaults. */
globalThis.process ??= {
  env: {},
  cwd: () => '/',
  platform: 'browser',
} as unknown as NodeJS.Process

export {}
