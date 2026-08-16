/** Browser `node:os` shim: the spike graph imports `tmpdir`, `homedir`, and `release`. */

export function tmpdir(): string {
  return '/tmp'
}

export function homedir(): string {
  return '/'
}

export function release(): string {
  return 'browser'
}
