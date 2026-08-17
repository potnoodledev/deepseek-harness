import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './PasskeyGate.module.css'

interface AuthStatus {
  configured: boolean
  authenticated: boolean
}

/** Frame-wide passkey setup and authentication gate. */
export type PasskeyGateProps = PropsRuntime<'shell.overlay'>

/**
 * Keep the hosted Web UI behind the Host-owned passkey session.
 * @param _props - standard root-scope props supplied by the overlay slot.
 * @returns null for an unavailable auth endpoint or authenticated session, otherwise the setup/login gate.
 */
export function PasskeyGate(_props: PasskeyGateProps): ReactNode {
  const [status, setStatus] = useState<AuthStatus | undefined>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  useEffect(() => {
    let live = true
    void fetch('/auth/status', { credentials: 'same-origin' }).then(async (response) => {
      if (response.status === 404) return
      if (!response.ok) throw new Error('Authentication service unavailable')
      const next = await response.json() as AuthStatus
      if (live) setStatus(next)
    }).catch((reason: unknown) => {
      if (live) setError(reason instanceof Error ? reason.message : 'Authentication service unavailable')
    })
    return () => { live = false }
  }, [])

  if (status === undefined && error === undefined) return <Gate title="Loading authentication" message="Checking the passkey session…" />
  if (status === undefined) return <Gate title="Authentication unavailable" message={error ?? 'Authentication service unavailable'} />
  if (status.authenticated) return null

  const setup = !status.configured
  const authenticate = async (): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      if (!('PublicKeyCredential' in window)) throw new Error('This browser does not support passkeys')
      const prefix = setup ? 'register' : 'login'
      const optionsResponse = await fetch(`/auth/${prefix}/options`, { credentials: 'same-origin' })
      if (!optionsResponse.ok) throw new Error('Could not start passkey authentication')
      const options = await optionsResponse.json() as Record<string, unknown>
      const credential = setup
        ? await navigator.credentials.create({ publicKey: creationOptions(options) })
        : await navigator.credentials.get({ publicKey: requestOptions(options) })
      if (!(credential instanceof PublicKeyCredential)) throw new Error('Passkey operation was cancelled')
      const response = setup
        ? serializeCreation(credential)
        : serializeRequest(credential)
      const verifyResponse = await fetch(`/auth/${prefix}/verify`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(response),
      })
      if (!verifyResponse.ok) throw new Error('Passkey verification failed')
      setStatus({ configured: true, authenticated: true })
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Passkey authentication failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Gate
      title={setup ? 'Set up your passkey' : 'Unlock DeepSeek Harness'}
      message={setup ? 'Create the passkey that will protect this hosted app.' : 'Use the registered passkey to continue.'}
      action={setup ? 'Create passkey' : 'Unlock'}
      busy={busy}
      {...error === undefined ? {} : { error }}
      onAction={() => { void authenticate() }}
    />
  )
}

interface GateProps {
  title: string
  message: string
  action?: string
  busy?: boolean
  error?: string
  onAction?: () => void
}

function Gate(props: GateProps): ReactNode {
  return (
    <div className={css.mask} role="dialog" aria-modal="true" aria-labelledby="passkey-title">
      <div className={css.card}>
        <h1 id="passkey-title">{props.title}</h1>
        <p>{props.message}</p>
        {props.error === undefined ? null : <p className={css.error} role="alert">{props.error}</p>}
        {props.action === undefined ? null : <button type="button" disabled={props.busy} onClick={props.onAction}>
          {props.busy ? 'Working…' : props.action}
        </button>}
      </div>
    </div>
  )
}

function decode(value: string): Uint8Array {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function creationOptions(options: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const user = options.user as Record<string, unknown>
  return {
    ...options,
    challenge: decode(options.challenge as string).buffer,
    user: { ...user, id: decode(user.id as string).buffer },
    excludeCredentials: (options.excludeCredentials as Array<Record<string, unknown>> | undefined)?.map(credential => ({
      ...credential,
      id: decode(credential.id as string).buffer,
    })),
  } as PublicKeyCredentialCreationOptions
}

function requestOptions(options: Record<string, unknown>): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: decode(options.challenge as string).buffer,
    allowCredentials: (options.allowCredentials as Array<Record<string, unknown>> | undefined)?.map(credential => ({
      ...credential,
      id: decode(credential.id as string).buffer,
    })),
  } as PublicKeyCredentialRequestOptions
}

function serializeCreation(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse
  return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: {
    clientDataJSON: encode(response.clientDataJSON), attestationObject: encode(response.attestationObject),
  } }
}

function serializeRequest(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAssertionResponse
  return { id: credential.id, rawId: encode(credential.rawId), type: credential.type, response: {
    clientDataJSON: encode(response.clientDataJSON), authenticatorData: encode(response.authenticatorData),
    signature: encode(response.signature), userHandle: response.userHandle === null ? undefined : encode(response.userHandle),
  } }
}
