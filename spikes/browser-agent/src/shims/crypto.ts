/** Browser `node:crypto` shim: the spike graph imports `randomUUID` and `randomBytes`. */

export function randomUUID(): string {
  return globalThis.crypto.randomUUID()
}

export function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}
