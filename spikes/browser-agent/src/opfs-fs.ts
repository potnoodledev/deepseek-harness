/**
 * OPFS-backed `FileSystem` provider for the browser-agent spike: the real
 * browser-storage stand-in for `dsh-fs-local`. Every primitive operates on
 * `navigator.storage.getDirectory()` handles (Origin Private File System), so
 * the files the agent reads/writes survive page reloads on the same origin.
 * The agent stack (tool-fs and below) is untouched — this provider is the
 * swap-in for the memory provider, proving the fs seam runs over browser
 * storage.
 *
 * OPFS init is async, so construction is inert and callers run {@link prepare}
 * once before use to reset and re-seed the workspace. Versions are an
 * in-memory counter (the observation policy that consumes version guards is
 * not mounted in this spike); a durable port should derive versions from OPFS
 * file metadata or a sidecar store.
 */

import { Context } from '@deepseek-ai/cordis'
import { FileSystem, FsError, FsTargetKey, FsVersion } from '@deepseek-ai/dsh-fs'
import type {
  FsDirEntry,
  FsEditOutcome,
  FsEditRequest,
  FsInfo,
  FsPathInfo,
  FsTarget,
  FsWriteIntent,
  FsWriteOutcome,
} from '@deepseek-ai/dsh-fs'

/** Spike configuration: virtual cwd plus seed files placed by {@link prepare}. */
export interface OpfsFsConfig {
  /** Virtual base directory (e.g. `/workspace`). */
  cwd?: string
  /** Seed files written at prepare, keyed by path relative to `cwd`. */
  seed?: Record<string, string>
}

/** Collapse `.`/`..`/empty segments into one canonical absolute path. */
function normalizePath(path: string): string {
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

function joinPath(base: string, path: string): string {
  if (path.startsWith('/')) return normalizePath(path)
  return normalizePath(`${base}/${path}`)
}

/** The segments of a normalized absolute path (empty for `/`). */
function pathSegments(abs: string): string[] {
  return abs.split('/').filter(Boolean)
}

type NodeHandle = FileSystemFileHandle | FileSystemDirectoryHandle

/** OPFS-backed `FileSystem` (see the spike README of this package). */
export class OpfsFileSystem extends FileSystem {
  private rootPromise: Promise<FileSystemDirectoryHandle> | undefined
  private readonly versions = new Map<string, number>()
  private counter = 1

  constructor(ctx: Context, private readonly config: OpfsFsConfig = {}) {
    super(ctx)
  }

  private root(): Promise<FileSystemDirectoryHandle> {
    this.rootPromise ??= navigator.storage.getDirectory()
    return this.rootPromise
  }

  /**
   * Reset the configured workspace and write the seed files. OPFS operations
   * are async, so this cannot live in the constructor.
   */
  async prepare(): Promise<void> {
    const root = await this.root()
    const cwdSegs = pathSegments(normalizePath(this.config.cwd ?? '/'))
    if (cwdSegs.length > 0) {
      try {
        await root.removeEntry(cwdSegs[0], { recursive: true })
      } catch {
        // absent workspace: nothing to clear
      }
      await root.getDirectoryHandle(cwdSegs[0], { create: true })
    }
    for (const [rel, content] of Object.entries(this.config.seed ?? {})) {
      const abs = joinPath(this.config.cwd ?? '/', rel)
      const file = await this.openFile(root, pathSegments(abs), true)
      const writable = await file.createWritable()
      await writable.write(content)
      await writable.close()
      this.versions.set(abs, this.counter++)
    }
  }

  /** Return the parent directory and final segment for a path. */
  private async navigate(
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

  private async openFile(root: FileSystemDirectoryHandle, segs: string[], create: boolean): Promise<FileSystemFileHandle> {
    const { dir, finalName } = await this.navigate(root, segs, create)
    if (finalName === undefined) throw new FsError('cannot open a path with no file segment', 'FS_IO_ERROR')
    return dir.getFileHandle(finalName, { create })
  }

  private async findNode(
    root: FileSystemDirectoryHandle,
    segs: string[],
  ): Promise<{ kind: 'file' | 'directory'; handle: NodeHandle } | undefined> {
    const { dir, finalName } = await this.navigate(root, segs, false)
    if (finalName === undefined) return { kind: 'directory', handle: dir }
    try {
      const handle = await dir.getFileHandle(finalName)
      return { kind: 'file', handle }
    } catch {
      // not a file
    }
    try {
      const handle = await dir.getDirectoryHandle(finalName)
      return { kind: 'directory', handle }
    } catch {
      return undefined
    }
  }

  private touch(key: string): FsVersion {
    let version = this.versions.get(key)
    if (version === undefined) {
      version = this.counter
      this.counter += 1
      this.versions.set(key, version)
    }
    return FsVersion(String(version))
  }

  private target(abs: string): FsTarget {
    return { targetKey: FsTargetKey(abs), displayPath: abs }
  }

  private async statOf(node: { kind: 'file' | 'directory'; handle: NodeHandle }, key: string): Promise<FsInfo> {
    const info: FsInfo = { version: this.touch(key), type: node.kind === 'file' ? 'file' : 'directory' }
    if (node.kind === 'file') {
      const file = await (node.handle as FileSystemFileHandle).getFile()
      info.size = file.size
    }
    return info
  }

  override async resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget> {
    return this.target(joinPath(opts?.cwd ?? this.config.cwd ?? '/', path))
  }

  override processPath(target: FsTarget): string {
    return target.targetKey
  }

  override fileUrl(target: FsTarget): string {
    return `file://${target.targetKey}`
  }

  override contains(parent: FsTarget, child: FsTarget): boolean {
    return parent.targetKey === child.targetKey || child.targetKey.startsWith(`${parent.targetKey}/`)
  }

  override async stat(target: FsTarget, _signal?: AbortSignal): Promise<FsInfo | undefined> {
    const node = await this.findNode(await this.root(), pathSegments(target.targetKey))
    if (node === undefined) return undefined
    return this.statOf(node, target.targetKey)
  }

  override async lstat(path: string, opts?: { cwd?: string }, _signal?: AbortSignal): Promise<FsPathInfo | undefined> {
    const target = await this.resolve(path, opts)
    const node = await this.findNode(await this.root(), pathSegments(target.targetKey))
    if (node === undefined) return undefined
    const info = await this.statOf(node, target.targetKey)
    return { version: info.version, type: node.kind === 'file' ? 'file' : 'directory', ...(info.size !== undefined ? { size: info.size } : {}) }
  }

  override async readText(target: FsTarget, _signal?: AbortSignal): Promise<string> {
    const node = await this.findNode(await this.root(), pathSegments(target.targetKey))
    if (node === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (node.kind !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    this.touch(target.targetKey)
    return (await (node.handle as FileSystemFileHandle).getFile()).text()
  }

  override async streamText(target: FsTarget, _signal?: AbortSignal): Promise<AsyncIterable<string>> {
    const content = await this.readText(target)
    return (async function* (): AsyncIterable<string> {
      yield content
    })()
  }

  override async readBytes(target: FsTarget, _signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array> {
    const node = await this.findNode(await this.root(), pathSegments(target.targetKey))
    if (node === undefined) throw new FsError(`cannot read "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (node.kind !== 'file') throw new FsError(`cannot read "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    const file = await (node.handle as FileSystemFileHandle).getFile()
    if (file.size > maxBytes) throw new FsError(`cannot read "${target.displayPath}": exceeds ${maxBytes} bytes`, 'FS_TOO_LARGE')
    return new Uint8Array(await file.arrayBuffer())
  }

  override async listDir(target: FsTarget, _signal?: AbortSignal): Promise<FsDirEntry[]> {
    const node = await this.findNode(await this.root(), pathSegments(target.targetKey))
    if (node === undefined) throw new FsError(`cannot list "${target.displayPath}": not found`, 'FS_NOT_FOUND')
    if (node.kind !== 'directory') throw new FsError(`cannot list "${target.displayPath}": not a directory`, 'FS_NOT_DIRECTORY')
    const entries: FsDirEntry[] = []
    for await (const [name, handle] of (node.handle as FileSystemDirectoryHandle).entries()) {
      const childKey = target.targetKey === '/' ? `/${name}` : `${target.targetKey}/${name}`
      const kind = handle.kind === 'file' ? 'file' : 'directory'
      const entry: FsDirEntry = { name, type: kind, target: this.target(childKey), version: this.touch(childKey) }
      if (handle.kind === 'file') entry.size = (await (handle as FileSystemFileHandle).getFile()).size
      entries.push(entry)
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    return entries
  }

  override async writeText(
    target: FsTarget,
    content: string,
    expected?: FsWriteIntent,
    _signal?: AbortSignal,
    _sandboxPolicy?: never,
  ): Promise<FsWriteOutcome> {
    const key = target.targetKey
    const node = await this.findNode(await this.root(), pathSegments(key))
    const existing = node?.kind === 'file' ? (node.handle as FileSystemFileHandle) : undefined
    if (expected?.kind === 'createIfAbsent' && existing !== undefined) {
      throw new FsError(`cannot create "${target.displayPath}": already exists`, 'FS_NOT_OBSERVED')
    }
    if (expected?.kind === 'replaceIfVersion' && (existing === undefined || String(this.versions.get(key)) !== expected.version)) {
      throw new FsError(`cannot replace "${target.displayPath}": version changed`, 'FS_STALE_VERSION')
    }
    const operation = existing === undefined ? 'create' : 'update'
    const before = existing === undefined ? null : await (await existing.getFile()).text().catch(() => null)
    const file = await this.openFile(await this.root(), pathSegments(key), true)
    const writable = await file.createWritable()
    await writable.write(content)
    await writable.close()
    this.versions.set(key, this.counter)
    const version = FsVersion(String(this.counter))
    this.counter += 1
    return { operation, version, before, after: content }
  }

  override async editText(
    target: FsTarget,
    edit: FsEditRequest,
    expected?: { version: FsVersion },
    _signal?: AbortSignal,
    _sandboxPolicy?: never,
  ): Promise<FsEditOutcome> {
    const key = target.targetKey
    const node = await this.findNode(await this.root(), pathSegments(key))
    if (node === undefined) throw new FsError(`cannot edit "${target.displayPath}": not found`, 'FS_STALE_VERSION')
    if (node.kind !== 'file') throw new FsError(`cannot edit "${target.displayPath}": not a regular file`, 'FS_NOT_REGULAR_FILE')
    if (expected !== undefined && String(this.versions.get(key)) !== expected.version) {
      throw new FsError(`cannot edit "${target.displayPath}": version changed`, 'FS_STALE_VERSION')
    }
    const before = await (node.handle as FileSystemFileHandle).getFile().then((file) => file.text())
    const matches = before.split(edit.oldString).length - 1
    if (matches === 0) throw new FsError(`cannot edit "${target.displayPath}": pattern not found`, 'FS_EDIT_NOT_FOUND')
    if (matches > 1 && !edit.replaceAll) throw new FsError(`cannot edit "${target.displayPath}": ambiguous match`, 'FS_AMBIGUOUS_EDIT')
    const after = edit.replaceAll
      ? before.split(edit.oldString).join(edit.newString)
      : before.replace(edit.oldString, edit.newString)
    const file = await this.openFile(await this.root(), pathSegments(key), false)
    const writable = await file.createWritable()
    await writable.write(after)
    await writable.close()
    this.versions.set(key, this.counter)
    const version = FsVersion(String(this.counter))
    this.counter += 1
    return { version, before, after }
  }
}

export default OpfsFileSystem
