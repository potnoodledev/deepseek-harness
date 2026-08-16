/**
 * OPFS file helpers for the browser shell shim. The virtual root `/` is the
 * Origin Private File System root, matching the `OpfsFileSystem` provider's
 * convention, so the shell and the `tool-fs` seam address the same files.
 * Every operation navigates fresh `FileSystemHandle`s; there is no cache.
 */

/** Collapse `.`/`..`/empty segments into one canonical absolute path. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/') ? path : `/${path}`
  const segments: string[] = []
  for (const part of absolute.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return `/${segments.join('/')}`
}

/** Resolve a possibly relative path against a working directory. */
export function resolvePath(cwd: string, path: string): string {
  if (path.startsWith('/')) return normalizePath(path)
  return normalizePath(`${cwd}/${path}`)
}

/** The segments of a normalized absolute path (empty for `/`). */
function pathSegments(abs: string): string[] {
  return abs.split('/').filter(Boolean)
}

async function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory()
}

/** Walk to the parent directory, creating directories when asked. */
async function navigate(
  root: FileSystemDirectoryHandle,
  segs: string[],
  createDirs: boolean,
): Promise<{ dir: FileSystemDirectoryHandle; finalName: string | undefined }> {
  let dir = root
  for (let i = 0; i < segs.length - 1; i += 1) {
    dir = await dir.getDirectoryHandle(segs[i], { create: createDirs })
  }
  return { dir, finalName: segs.length > 0 ? segs[segs.length - 1] : undefined }
}

async function openFile(abs: string, create: boolean): Promise<FileSystemFileHandle> {
  const root = await opfsRoot()
  const { dir, finalName } = await navigate(root, pathSegments(abs), create)
  if (finalName === undefined) throw new Error(`invalid path "${abs}"`)
  return dir.getFileHandle(finalName, { create })
}

/** One directory entry as the shell sees it. */
export interface ShellEntry {
  name: string
  kind: 'file' | 'directory'
}

/** Stat result for the shell. */
export interface ShellStat {
  kind: 'file' | 'directory'
  size: number
}

export async function opfsStat(abs: string): Promise<ShellStat | undefined> {
  const root = await opfsRoot()
  const { dir, finalName } = await navigate(root, pathSegments(abs), false)
  if (finalName === undefined) return { kind: 'directory', size: 0 }
  try {
    const handle = await dir.getFileHandle(finalName)
    const file = await handle.getFile()
    return { kind: 'file', size: file.size }
  } catch {
    // not a file
  }
  try {
    await dir.getDirectoryHandle(finalName)
    return { kind: 'directory', size: 0 }
  } catch {
    return undefined
  }
}

export async function opfsExists(abs: string): Promise<boolean> {
  return (await opfsStat(abs)) !== undefined
}

export async function opfsReadFile(abs: string): Promise<string | undefined> {
  const stat = await opfsStat(abs)
  if (stat === undefined || stat.kind !== 'file') return undefined
  const handle = await openFile(abs, false)
  return (await handle.getFile()).text()
}

/** Write a file, creating parent directories. Returns false when a path
 * component is an existing file (cannot make a directory there). */
export async function opfsWriteFile(abs: string, content: string): Promise<boolean> {
  try {
    const handle = await openFile(abs, true)
    const writable = await handle.createWritable()
    await writable.write(content)
    await writable.close()
    return true
  } catch {
    return false
  }
}

export async function opfsAppendFile(abs: string, content: string): Promise<boolean> {
  const existing = await opfsReadFile(abs)
  return opfsWriteFile(abs, `${existing ?? ''}${content}`)
}

export async function opfsListDir(abs: string): Promise<ShellEntry[] | undefined> {
  const stat = await opfsStat(abs)
  if (stat === undefined || stat.kind !== 'directory') return undefined
  const root = await opfsRoot()
  const { dir, finalName } = await navigate(root, pathSegments(abs), false)
  const handle = finalName === undefined ? dir : await dir.getDirectoryHandle(finalName)
  const entries: ShellEntry[] = []
  for await (const [name, child] of handle.entries()) {
    entries.push({ name, kind: child.kind === 'file' ? 'file' : 'directory' })
  }
  entries.sort((a, b) => a.name.localeCompare(b.name))
  return entries
}

export async function opfsMakeDirs(abs: string): Promise<void> {
  const root = await opfsRoot()
  const segs = pathSegments(abs)
  let dir = root
  for (const segment of segs) {
    dir = await dir.getDirectoryHandle(segment, { create: true })
  }
}

/** Remove a file or directory. Returns false when absent. */
export async function opfsRemove(abs: string, recursive: boolean): Promise<boolean> {
  const stat = await opfsStat(abs)
  if (stat === undefined) return false
  if (stat.kind === 'file') {
    return openFile(abs, false).then(async (handle) => {
      const parent = await parentHandle(abs)
      await parent.removeEntry(lastSegment(abs))
      return true
    })
  }
  if (!recursive) {
    const entries = await opfsListDir(abs)
    if (entries !== undefined && entries.length > 0) return false
  }
  const parent = await parentHandle(abs)
  await parent.removeEntry(lastSegment(abs), { recursive: true })
  return true
}

async function parentHandle(abs: string): Promise<FileSystemDirectoryHandle> {
  const root = await opfsRoot()
  const segs = pathSegments(abs)
  const { dir } = await navigate(root, segs.slice(0, -1), false)
  return dir
}

function lastSegment(abs: string): string {
  const segs = pathSegments(abs)
  return segs[segs.length - 1] ?? ''
}

export async function opfsCopy(src: string, dst: string, recursive: boolean): Promise<boolean> {
  const stat = await opfsStat(src)
  if (stat === undefined) return false
  if (stat.kind === 'file') {
    const content = await opfsReadFile(src)
    return opfsWriteFile(dst, content ?? '')
  }
  if (!recursive) return false
  await opfsMakeDirs(dst)
  const entries = (await opfsListDir(src)) ?? []
  for (const entry of entries) {
    const ok = await opfsCopy(`${src}/${entry.name}`, `${dst}/${entry.name}`, true)
    if (!ok) return false
  }
  return true
}

export async function opfsMove(src: string, dst: string): Promise<boolean> {
  const stat = await opfsStat(src)
  if (stat === undefined) return false
  if (stat.kind === 'directory') {
    const copied = await opfsCopy(src, dst, true)
    if (!copied) return false
    return opfsRemove(src, true)
  }
  const content = await opfsReadFile(src)
  const written = content !== undefined && await opfsWriteFile(dst, content)
  if (!written) return false
  return opfsRemove(src, false)
}
