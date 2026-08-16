/** Browser `node:path` shim: POSIX-only subset used by the spike graph. */

export function isAbsolute(path) {
  return path.length > 0 && path[0] === '/'
}

export function basename(path, suffix) {
  const base = path.slice(path.lastIndexOf('/') + 1)
  return suffix !== undefined && base.endsWith(suffix) ? base.slice(0, -suffix.length) : base
}

export function extname(path) {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

export function dirname(path) {
  const index = path.lastIndexOf('/')
  return index <= 0 ? (path.length > 0 && path[0] === '/' ? '/' : '.') : path.slice(0, index)
}

export function join(...parts) {
  return parts.join('/')
}

export function resolve(...parts) {
  const segments = []
  for (const part of parts) {
    if (part.startsWith('/')) segments.length = 0
    for (const seg of part.split('/')) {
      if (seg === '' || seg === '.') continue
      if (seg === '..') {
        segments.pop()
        continue
      }
      segments.push(seg)
    }
  }
  return `/${segments.join('/')}`
}

export function relative(from, to) {
  const fromSegs = from.split('/').filter(Boolean)
  const toSegs = to.split('/').filter(Boolean)
  let common = 0
  while (common < fromSegs.length && common < toSegs.length && fromSegs[common] === toSegs[common]) common += 1
  const ups = fromSegs.length - common
  return [...Array(ups).fill('..'), ...toSegs.slice(common)].join('/')
}

export const sep = '/'
export const posix = { isAbsolute, basename, extname, dirname, join, resolve, relative, sep: '/' }
