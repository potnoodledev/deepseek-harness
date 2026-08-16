export default async function createBrowserAgentApi() {
  await import('../../../spikes/browser-agent/src/polyfills.ts')
  const { createBrowserAgentApi: create } = await import('../../../spikes/browser-agent/src/gui.ts')
  return create()
}
