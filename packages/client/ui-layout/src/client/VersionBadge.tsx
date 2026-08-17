import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './VersionBadge.module.css'

declare const __DSH_BUILD_TIMESTAMP__: string

/** Current Web application release displayed in the shell overlay. */
const WEB_VERSION = '0.1.0-rc.5'
/** UTC timestamp captured when the client bundle was built. */
const BUILD_TIMESTAMP = typeof __DSH_BUILD_TIMESTAMP__ === 'undefined' ? 'dev' : __DSH_BUILD_TIMESTAMP__

/** Frame-wide release marker. */
export type VersionBadgeProps = PropsRuntime<'shell.overlay'>

/**
 * Render the application release in the lower-right corner of the frame.
 * @param _props - standard root-scope props supplied by the overlay slot.
 * @returns the release marker.
 */
export function VersionBadge(_props: VersionBadgeProps): ReactNode {
  return <span className={css.badge}>v{WEB_VERSION} · {BUILD_TIMESTAMP}</span>
}
