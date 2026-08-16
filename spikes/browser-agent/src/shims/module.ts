/**
 * Browser `node:module` shim. The only call site (dsh-llm attribution) reads
 * its own package.json to derive the User-Agent version; the version is
 * injected at build time so the browser bundle needs no filesystem access.
 */

declare const __DSH_VERSION__: string

export function createRequire(_filename: string | URL): (specifier: string) => unknown {
  return (specifier: string): unknown => {
    if (specifier.endsWith('package.json')) return { version: __DSH_VERSION__ }
    throw new Error(`createRequire(${JSON.stringify(specifier)}) is not available in the browser`)
  }
}
