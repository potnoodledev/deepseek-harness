import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryEntry, DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import type { SidebarFileBrowserOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './FileBrowser.module.css'

/** Keys used by the sidebar file-browser copy. */
export type FileBrowserKey = 'title' | 'empty' | 'loading' | 'expand'

/** File-listing calls supplied by the directory capability owner. */
export interface FileBrowserInjected {
  listDirectory: (path?: string, signal?: AbortSignal, options?: { includeFiles?: boolean }) => Promise<DirectoryListing>
}

/** Props for the sidebar file-browser contribution. */
export type FileBrowserProps =
  & PropsRuntime<'sidebar.fileBrowser'>
  & SidebarFileBrowserOwnerProps
  & InjectFace<FileBrowserInjected>
  & PropsLocale<'fileBrowser'>

/** File browser state. */
interface FileState {
  path: string
  entries: DirectoryEntry[]
  loading: boolean
  error?: string
}

/** Render files and directories for the active workspace above the session list. */
export function FileBrowser(props: FileBrowserProps): ReactNode {
  const { wide, expandSidebar, useWorkspaces, listDirectory, t } = props
  const workspace = useWorkspaces(snapshot => snapshot.items.find(
    item => item.workspaceId === snapshot.recentWorkspaceId,
  ) ?? snapshot.items[0])
  const [state, setState] = useState<FileState | undefined>()
  const [path, setPath] = useState<string>()

  useEffect(() => {
    if (!wide || workspace === undefined) return
    const nextPath = path === undefined || !path.startsWith(workspace.path) ? workspace.path : path
    const controller = new AbortController()
    setState(previous => ({ path: nextPath, entries: previous?.path === nextPath ? previous.entries : [], loading: true }))
    void listDirectory(nextPath, controller.signal, { includeFiles: true }).then((listing) => {
      setState({ path: listing.path, entries: listing.entries, loading: false })
      setPath(listing.path)
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) {
        setState({
          path: nextPath,
          entries: [],
          loading: false,
          error: reason instanceof Error ? reason.message : String(reason),
        })
      }
    })
    return () => { controller.abort() }
  }, [listDirectory, path, wide, workspace])

  if (!wide) {
    return <button type="button" className={css.railButton} aria-label={t('expand')} onClick={expandSidebar}>▦</button>
  }
  if (workspace === undefined) return <section className={css.root}><h2>{t('title')}</h2><p>{t('empty')}</p></section>
  const goParent = (): void => { setPath(parentPath(state?.path ?? workspace.path)) }

  return (
    <section className={css.root} aria-label={t('title')}>
      <h2>{t('title')}</h2>
      <div className={css.path} title={state?.path ?? workspace.path}>{state?.path ?? workspace.path}</div>
      <div className={css.list}>
        {state?.path !== workspace.path && <button
          type="button"
          className={css.row}
          onClick={goParent}
        >..</button>}
        {state?.loading && <p className={css.status}>{t('loading')}</p>}
        {state?.error !== undefined && <p className={css.error}>{state.error}</p>}
        {state?.entries.map(entry => <FileRow
          key={entry.path}
          entry={entry}
          onOpen={() => { if (entry.kind !== 'file') setPath(entry.path) }}
        />)}
        {state !== undefined && !state.loading && state.error === undefined && state.entries.length === 0 && <p className={css.status}>{t('empty')}</p>}
      </div>
    </section>
  )
}

function FileRow(props: { entry: DirectoryEntry; onOpen: () => void }): ReactNode {
  const directory = props.entry.kind !== 'file'
  return <button type="button" className={css.row} data-kind={directory ? 'directory' : 'file'} onClick={props.onOpen}>
    <span aria-hidden="true">{directory ? '▸' : '·'}</span><span className={css.name}>{props.entry.name}</span>
  </button>
}

function parentPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/'
  const trimmed = path.endsWith(separator) ? path.slice(0, -1) : path
  const index = trimmed.lastIndexOf(separator)
  return index <= 0 ? `${trimmed.slice(0, 1)}${separator}` : trimmed.slice(0, index)
}

declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { fileBrowser: FileBrowserKey } }
