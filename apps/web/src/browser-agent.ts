// @ts-expect-error The runtime wrapper intentionally keeps the exploratory spike outside this project.
import browserAgentRuntime from './browser-agent-runtime.js'

type BrowserAgentWindow = Window & {
  __DSH_BROWSER_AGENT__?: () => Promise<unknown>
}

/** Install the local agent transport before the client plugin graph boots. */
export function installBrowserAgent(): void {
  ;(globalThis.window as BrowserAgentWindow).__DSH_BROWSER_AGENT__ = browserAgentRuntime
}
