import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'

/** Persisted single-passkey credential. */
interface StoredCredential {
  id: string
  publicKey: string
  counter: number
}

/** Passkey configuration owned by the Web deployment. */
export interface PasskeyConfig {
  /** WebAuthn relying-party identifier, normally the public hostname. */
  rpId: string
  /** Exact HTTPS origin accepted for WebAuthn ceremonies. */
  origin: string
  /** JSON file containing the one registered credential. */
  storagePath: string
}

/** Minimal request-facing authentication service used by the API carrier. */
export interface PasskeyAuthService {
  /** Whether a request carries a valid authenticated session cookie. */
  isAuthenticated(req: IncomingMessage): Promise<boolean>
}

const COOKIE = 'dsh_session'
const MAX_BODY_BYTES = 128 * 1024
const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** Host plugin implementing one-owner WebAuthn setup and cookie sessions. */
export class PasskeyAuth implements PasskeyAuthService {
  private credential: StoredCredential | undefined
  private readonly challenges = new Map<string, { value: string; expiresAt: number }>()
  private readonly sessions = new Set<string>()
  private readonly ready: Promise<void>

  /**
   * @param ctx - Host context that owns route registration.
   * @param config - relying-party and durable storage settings.
   */
  constructor(private readonly ctx: Context, private readonly config: PasskeyConfig) {
    this.ready = this.load()
  }

  /** Whether the deployment has completed first-run passkey setup. */
  async isConfigured(): Promise<boolean> {
    await this.ready
    return this.credential !== undefined
  }

  /** Whether a request carries a valid authenticated session cookie. */
  async isAuthenticated(req: IncomingMessage): Promise<boolean> {
    await this.ready
    const token = parseCookie(req.headers.cookie, COOKIE)
    return token !== undefined && this.sessions.has(token)
  }

  /** Register the `/auth` routes and publish the service for API carriers. */
  apply(): void {
    this.ctx.provide('passkeyAuth', this)
    const routes: WebRoute[] = [
      { kind: 'exact', path: '/auth/status', handler: (req, res) => this.status(req, res) },
      { kind: 'exact', path: '/auth/register/options', handler: (req, res) => this.registerOptions(req, res) },
      { kind: 'exact', path: '/auth/register/verify', handler: (req, res) => this.registerVerify(req, res) },
      { kind: 'exact', path: '/auth/login/options', handler: (req, res) => this.loginOptions(req, res) },
      { kind: 'exact', path: '/auth/login/verify', handler: (req, res) => this.loginVerify(req, res) },
      { kind: 'exact', path: '/auth/logout', handler: (req, res) => { this.logout(req, res) } },
    ]
    this.ctx.effect(() => {
      const disposers = routes.map(route => this.ctx.webServer.register(route))
      return () => { for (const dispose of disposers) dispose() }
    }, 'passkey-auth: routes')
  }

  private async status(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.json(res, 200, { configured: await this.isConfigured(), authenticated: await this.isAuthenticated(_req) })
  }

  private async registerOptions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (await this.isConfigured()) { this.json(res, 409, { error: 'already-configured' }); return }
    const userId = randomBytes(16)
    const options = await generateRegistrationOptions({
      rpName: 'DeepSeek Harness',
      rpID: this.config.rpId,
      userName: 'owner',
      userDisplayName: 'DeepSeek Harness owner',
      userID: userId,
      attestationType: 'none',
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
    this.challenges.set('register', { value: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS })
    this.json(res, 200, options)
  }

  private async registerVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (await this.isConfigured()) { this.json(res, 409, { error: 'already-configured' }); return }
    const response = await readJson<RegistrationResponseJSON>(req)
    const challenge = this.takeChallenge('register')
    if (challenge === undefined) { this.json(res, 400, { error: 'challenge-expired' }); return }
    const result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
    })
    if (!result.verified) { this.json(res, 400, { error: 'registration-rejected' }); return }
    const credential = result.registrationInfo.credential
    this.credential = {
      id: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
    }
    await this.save()
    this.issueSession(res)
    this.json(res, 200, { authenticated: true })
  }

  private async loginOptions(_req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credential = this.credential
    if (credential === undefined) { this.json(res, 409, { error: 'setup-required' }); return }
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      allowCredentials: [{ id: credential.id }],
      userVerification: 'required',
    })
    this.challenges.set('login', { value: options.challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS })
    this.json(res, 200, options)
  }

  private async loginVerify(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const credential = this.credential
    if (credential === undefined) { this.json(res, 409, { error: 'setup-required' }); return }
    const challenge = this.takeChallenge('login')
    if (challenge === undefined) { this.json(res, 400, { error: 'challenge-expired' }); return }
    const response = await readJson<AuthenticationResponseJSON>(req)
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      credential: {
        id: credential.id,
        publicKey: Buffer.from(credential.publicKey, 'base64url'),
        counter: credential.counter,
      },
    })
    if (!result.verified) { this.json(res, 401, { error: 'authentication-rejected' }); return }
    credential.counter = result.authenticationInfo.newCounter
    await this.save()
    this.issueSession(res)
    this.json(res, 200, { authenticated: true })
  }

  private logout(_req: IncomingMessage, res: ServerResponse): void {
    const token = parseCookie(_req.headers.cookie, COOKIE)
    if (token !== undefined) this.sessions.delete(token)
    res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`)
    this.json(res, 200, { authenticated: false })
  }

  private issueSession(res: ServerResponse): void {
    const token = randomUUID()
    this.sessions.add(token)
    res.setHeader('set-cookie', `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`)
  }

  private takeChallenge(key: string): string | undefined {
    const challenge = this.challenges.get(key)
    this.challenges.delete(key)
    return challenge !== undefined && challenge.expiresAt >= Date.now() ? challenge.value : undefined
  }

  private async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.config.storagePath, 'utf8')) as StoredCredential
      if (typeof parsed.id !== 'string' || typeof parsed.publicKey !== 'string' || !Number.isSafeInteger(parsed.counter)) throw new Error('invalid credential')
      this.credential = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.config.storagePath), { recursive: true })
    const temporary = `${this.config.storagePath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(this.credential) + '\n', { mode: 0o600 })
    await rename(temporary, this.config.storagePath)
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(value))
  }
}

async function readJson<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(Buffer.from(buffer))
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(`${name}=`))?.slice(name.length + 1)
  return value === undefined || value === '' ? undefined : value
}
