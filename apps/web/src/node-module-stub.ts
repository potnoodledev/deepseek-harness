/** Browser stand-in for the small `node:module` surface used by the client graph. */

/** Resolve the package metadata needed for provider attribution without filesystem access. */
export const createRequire = (_filename?: string | URL): ((specifier: string) => unknown) => {
  return (specifier: string): unknown => {
    if (specifier.endsWith('package.json')) return { version: '0.0.0' }
    throw new Error(`createRequire(${JSON.stringify(specifier)}) is not available in the browser`)
  }
}

/** Erased type peer for the vendored loader's type-only LoadHookContext import. */
export type LoadHookContext = never
