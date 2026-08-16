/** Browser credential provider for an explicitly supplied DeepSeek key. */

import { Context } from '@deepseek-ai/cordis'
import CredentialProvider, {
  type CredentialInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'

declare global {
  interface Window {
    __DSH_DEEPSEEK_API_KEY__?: string
    __DSH_BROWSER_CONFIG__?: { apiKey?: string; baseURL?: string }
  }
}

/**
 * Read-only browser credential provider. The key is supplied by the host page
 * and retained only in memory; it is never written to OPFS or session logs.
 */
export class BrowserCredentials extends CredentialProvider {
  private value: string | undefined

  constructor(ctx: Context) {
    super(ctx)
    this.value = globalThis.localStorage?.getItem('dsh:credential:DEEPSEEK_API_KEY') ?? undefined
  }

  override async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = String(ref) === 'DEEPSEEK_API_KEY'
      ? this.value
        ?? globalThis.localStorage?.getItem('dsh:credential:DEEPSEEK_API_KEY')
        ?? globalThis.window?.__DSH_DEEPSEEK_API_KEY__
        ?? globalThis.window?.__DSH_BROWSER_CONFIG__?.apiKey
      : undefined
    return value === undefined || value.trim() === ''
      ? undefined
      : { value: value.trim(), source: 'browser-memory' }
  }

  override async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return {
      configured: (await this.resolve(ref)) !== undefined,
      source: (await this.resolve(ref))?.source,
      writable: true,
    }
  }

  override async set(ref: CredentialRef, value: string): Promise<void> {
    if (String(ref) !== 'DEEPSEEK_API_KEY') throw new Error(`browser credentials: unsupported reference ${ref}`)
    const trimmed = value.trim()
    if (trimmed === '') throw new Error('browser credentials: an empty value cannot be stored')
    this.value = trimmed
    globalThis.localStorage?.setItem('dsh:credential:DEEPSEEK_API_KEY', trimmed)
    this.ctx.emit('credentials/updated', ref)
  }

  override async unset(ref: CredentialRef): Promise<void> {
    if (String(ref) !== 'DEEPSEEK_API_KEY') throw new Error(`browser credentials: unsupported reference ${ref}`)
    this.value = undefined
    globalThis.localStorage?.removeItem('dsh:credential:DEEPSEEK_API_KEY')
    this.ctx.emit('credentials/updated', ref)
  }
}

export default BrowserCredentials
