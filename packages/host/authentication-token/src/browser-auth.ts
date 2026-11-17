/** Browser-session authentication for the Host Connection carrier. */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { CONNECT_PATH } from '@deepseek-ai/dsh-client-connection'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { ConnectionInteractions } from './types.ts'
import type {
  ConnectionIndexRequest,
  ConnectionIndexResponse,
  ConnectionTrustRequest,
} from './types.ts'

/** Credential record key of the retired durable cookie-signing secret. */
export const LEGACY_BROWSER_SESSION_KEY = credentialKey('client-connection', 'browser-session')
/** Same-origin endpoint that renews a browser cookie without a launch token. */
export const REFRESH_PATH = '/_dsh/auth/refresh'

const DAY_MILLISECONDS = 24 * 60 * 60 * 1000
/** Absolute browser-cookie lifetime, also its `Max-Age`; a browser session never outlives one day. */
const COOKIE_LIFETIME_MILLISECONDS = DAY_MILLISECONDS
const COOKIE_MAX_AGE_SECONDS = 86_400
/** A launch token is a one-shot capability for a few minutes, never a durable credential. */
const LAUNCH_TOKEN_TTL_MILLISECONDS = 10 * 60 * 1000
const SECRET_BYTES = 32
const TOKEN_QUERY = 'token'
const COOKIE_PREFIX = 'dsh-auth-'
const COOKIE_PAYLOAD_VERSION = 3
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/
const PROCESS_STATES = new WeakMap<object, ProcessAuthState>()

/** Process-scoped token state: one launch token and one HMAC secret per root Context. */
interface ProcessAuthState {
  readonly launchToken: string
  readonly secret: Buffer
  readonly launchTokenExpiresAt: number
  indexExchanged: boolean
  connectExchanged: boolean
}

interface CookiePayload {
  readonly version: typeof COOKIE_PAYLOAD_VERSION
  readonly authority: string
  readonly issuedAt: number
  readonly expiresAt: number
  /** API operator id; absent on a browser-session cookie. */
  readonly id?: PeerId
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function encodeBase64Url(value: Uint8Array): string {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '')
}

function decodeBase64Url(value: string): Buffer | undefined {
  if (!BASE64URL_PATTERN.test(value) || value.length % 4 === 1) return undefined
  const padding = '='.repeat((4 - value.length % 4) % 4)
  const decoded = Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
  return encodeBase64Url(decoded) === value ? decoded : undefined
}

/**
 * One root Context's authentication state. The state is process memory only:
 * a restart has no way to reproduce the HMAC secret, so every cookie minted
 * before it is refused.
 */
function processState(owner: object): ProcessAuthState {
  const existing = PROCESS_STATES.get(owner)
  if (existing !== undefined) return existing
  const created: ProcessAuthState = {
    launchToken: encodeBase64Url(randomBytes(SECRET_BYTES)),
    secret: randomBytes(SECRET_BYTES),
    launchTokenExpiresAt: Date.now() + LAUNCH_TOKEN_TTL_MILLISECONDS,
    indexExchanged: false,
    connectExchanged: false,
  }
  PROCESS_STATES.set(owner, created)
  return created
}

function header(
  headers: ConnectionTrustRequest['headers'],
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const value = headers[name]
  return typeof value === 'string' ? value : undefined
}

/** Protocol-scoped cookie audience; HTTP retains its existing authority-only spelling. */
function requestAudience(headers: ConnectionTrustRequest['headers'], secure: boolean): string | undefined {
  const host = header(headers, 'host')
  if (host === undefined) return undefined
  try {
    const url = new URL(`${secure ? 'https:' : 'http:'}//${host}`)
    return secure ? url.origin : url.host
  } catch {
    return undefined
  }
}

function tokenMatches(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8')
  const expectedBytes = Buffer.from(expected, 'utf8')
  return actualBytes.byteLength === expectedBytes.byteLength && timingSafeEqual(actualBytes, expectedBytes)
}

function cookieName(authority: string): string {
  return COOKIE_PREFIX + encodeBase64Url(createHash('sha256').update(authority).digest())
}

/** Read the exact generated cookie without implementing general Cookie decoding. */
function cookieValue(headerValue: string, name: string): string | undefined {
  for (const segment of headerValue.split(';')) {
    const at = segment.indexOf('=')
    if (at === -1 || segment.slice(0, at).trim() !== name) continue
    return segment.slice(at + 1).trim()
  }
  return undefined
}

/** Serialize the fixed browser-session attributes; generated names and values are cookie-safe base64url. */
function sessionCookie(
  name: string,
  value: string,
  expiresAt: number,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  const attributes = `${name}=${value}; Max-Age=${String(maxAgeSeconds)}; Path=/; Expires=${new Date(expiresAt).toUTCString()}; HttpOnly; SameSite=Strict`
  return secure ? `${attributes}; Secure` : attributes
}

function signature(secret: Buffer, body: string): Buffer {
  return createHmac('sha256', secret).update(body).digest()
}

/** Absolute end of a browser session that starts at `now`. */
function cookieExpiry(now: number): number {
  return now + COOKIE_LIFETIME_MILLISECONDS
}

function encodeCookie(payload: CookiePayload, secret: Buffer): string {
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'))
  return `v${payload.version}.${body}.${encodeBase64Url(signature(secret, body))}`
}

function decodeCookie(value: string, secret: Buffer): CookiePayload | undefined {
  const parts = value.split('.')
  const [version, body, encodedSignature] = parts
  if (parts.length !== 3 || version !== `v${COOKIE_PAYLOAD_VERSION}`
    || body === undefined || encodedSignature === undefined) return undefined
  const actualSignature = decodeBase64Url(encodedSignature)
  if (actualSignature === undefined) return undefined
  const expectedSignature = signature(secret, body)
  if (actualSignature.byteLength !== expectedSignature.byteLength
    || !timingSafeEqual(actualSignature, expectedSignature)) return undefined
  let decoded: unknown
  try {
    const bodyBytes = decodeBase64Url(body)
    if (bodyBytes === undefined) return undefined
    decoded = JSON.parse(bodyBytes.toString('utf8'))
  } catch {
    return undefined
  }
  if (!isRecord(decoded)
    || decoded.version !== COOKIE_PAYLOAD_VERSION
    || typeof decoded.authority !== 'string'
    || typeof decoded.issuedAt !== 'number' || !Number.isSafeInteger(decoded.issuedAt)
    || typeof decoded.expiresAt !== 'number' || !Number.isSafeInteger(decoded.expiresAt)) return undefined
  const payload = {
    version: COOKIE_PAYLOAD_VERSION,
    authority: decoded.authority,
    issuedAt: decoded.issuedAt,
    expiresAt: decoded.expiresAt,
  } as const
  if (decoded.id === undefined) return payload
  if (typeof decoded.id !== 'string' || decoded.id.length === 0) return undefined
  return { ...payload, id: decoded.id as PeerId }
}

/**
 * Delete the retired durable browser-session secret. The record is no longer
 * read by anything, so it is removed at startup; every other credential record
 * is left untouched.
 * @param credentials - persistent credential provider of the Web profile.
 * @returns true when a legacy record was present and removed.
 */
export async function discardLegacyBrowserSession(credentials: CredentialProvider): Promise<boolean> {
  const record = await credentials.readRecord(LEGACY_BROWSER_SESSION_KEY)
  if (record === undefined) return false
  await credentials.deleteRecord(LEGACY_BROWSER_SESSION_KEY)
  return true
}

/**
 * Process launch-token exchange and in-memory signed-cookie verification.
 *
 * The launch token lives in process memory for ten minutes and each exchange
 * path — the Web index and `/connect` — accepts it once. Cookies are signed by
 * a per-process random secret, so a restart revokes every browser session and a
 * cookie minted under a previous process cannot be forged or replayed.
 */
export class BrowserAuth {
  private constructor(private readonly state: ProcessAuthState) {}

  /**
   * Create the authentication owner for one root application context.
   * @param processOwner - root application context retaining one token and one
   *   signing secret across Token plugin reloads.
   * @returns authentication owner sharing this process's launch token.
   */
  static create(processOwner: object): BrowserAuth {
    return new BrowserAuth(processState(processOwner))
  }

  /**
   * Add this process's launch token to the caller's application URL.
   * @param baseUrl - clean browser URL whose authority and mount are preserved.
   * @returns the same URL carrying the process token as its sole authentication input.
   */
  authenticatedUrl(baseUrl: string): string {
    const url = new URL(baseUrl)
    url.searchParams.set(TOKEN_QUERY, this.state.launchToken)
    return url.href
  }

  /**
   * Authenticate an index request. A valid root query token mints the cookie
   * and redirects to the directory-relative clean `./`; a valid cookie lets
   * the caller serve the index; every other request receives the same minimal
   * 401 response.
   * @param req - incoming root or configured-index request.
   * @param res - response owned when this method returns false.
   * @param secure - whether the listener receiving this request serves TLS; the
   * minted cookie carries `Secure` when it does. Only that listener's own
   * protocol decides, never a `publicUrl` announcement or a forwarded header:
   * those describe a hop this process does not terminate.
   * @returns true only when the caller may serve index.html.
   */
  authorizeIndex(req: ConnectionIndexRequest, res: ConnectionIndexResponse, secure = false): boolean {
    /* v8 ignore next -- node:http always supplies url on server requests. */
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    if (tokens.length > 0) {
      const authority = requestAudience(req.headers, secure)
      if (req.method === 'GET' && url.pathname === '/' && tokens.length === 1
        && authority !== undefined && tokenMatches(tokens.join(''), this.state.launchToken)
        && this.exchangeLaunchToken('index')) {
        this.setCookie(res, 303, { location: './' }, authority, secure)
        return false
      }
      if (req.method === 'GET' && url.pathname === '/' && this.isAuthenticated(req, secure)) {
        res.writeHead(303, {
          'cache-control': 'no-store',
          'location': './',
          'referrer-policy': 'no-referrer',
        })
        res.end()
        return false
      }
      this.writeUnauthorized(req, res)
      return false
    }
    if (this.isAuthenticated(req, secure)) return true
    this.writeUnauthorized(req, res)
    return false
  }

  /**
   * Exchange the launch token for an independent API operator; omitted interactions default to none.
   * @param req - trusted GET request on /connect with at most one interactions declaration.
   * @param res - response owned to completion, redirecting to the API mux on success.
   * @param secure - whether the receiving listener serves TLS.
   * @param publish - synchronously create the operator before exposing its signed credential.
   */
  authorizeConnect(
    req: ConnectionIndexRequest,
    res: ConnectionIndexResponse,
    secure: boolean,
    publish: (interactions: ConnectionInteractions) => PeerId,
  ): void {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const declarations = url.searchParams.getAll('interactions')
    const interactions = declarations[0] ?? 'none'
    if (declarations.length > 1 || (interactions !== 'answer' && interactions !== 'none')) {
      res.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' })
      res.end('interactions must be declared once as answer or none\n')
      return
    }
    const tokens = url.searchParams.getAll(TOKEN_QUERY)
    const authority = requestAudience(req.headers, secure)
    if (req.method !== 'GET' || url.pathname !== CONNECT_PATH || tokens.length !== 1
      || authority === undefined || !tokenMatches(tokens.join(''), this.state.launchToken)
      || !this.exchangeLaunchToken('connect')) {
      this.writeUnauthorized(req, res)
      return
    }
    const id = publish(interactions)
    const expiresAt = cookieExpiry(Date.now())
    this.setCookie(res, 302, { location: './api/remote.mux' }, authority, secure, { id, expiresAt })
  }

  /**
   * Renew the current browser cookie for the remainder of its absolute
   * one-day session. The request proves it is same-origin: `Origin` must match
   * the request authority and, when present, `Sec-Fetch-Site` must be
   * `same-origin` or `none`; anything else is refused before the cookie is
   * read. Renewal cannot extend the session past its first login, and a
   * restart still invalidates it because the signing secret is new.
   * @param req - POST request on {@link REFRESH_PATH}.
   * @param res - response owned to completion.
   * @param secure - whether the receiving listener serves TLS.
   * @returns true when the cookie was renewed with 204.
   */
  authorizeRefresh(req: ConnectionIndexRequest, res: ConnectionIndexResponse, secure = false): boolean {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const authority = requestAudience(req.headers, secure)
    if (req.method !== 'POST' || url.pathname !== REFRESH_PATH || authority === undefined
      || !isSameOrigin(req.headers, authority, secure)) {
      this.writeForbidden(res)
      return false
    }
    const payload = this.authenticate(req, secure)
    if (payload === undefined || payload.id !== undefined) {
      this.writeUnauthorized(req, res)
      return false
    }
    const now = Date.now()
    const remaining = payload.expiresAt - now
    if (remaining <= 0) {
      this.writeUnauthorized(req, res)
      return false
    }
    this.setCookie(res, 204, {}, authority, secure, {
      issuedAt: now,
      expiresAt: payload.expiresAt,
      maxAgeSeconds: Math.floor(remaining / 1000),
    })
    return true
  }

  /**
   * Verify the authority-bound browser cookie on a Host request.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS, including its default port.
   * @returns true only for an unexpired browser-session cookie signed by this process's secret.
   */
  isAuthenticated(request: ConnectionTrustRequest, secure = false): boolean {
    const payload = this.authenticate(request, secure)
    return payload !== undefined && payload.id === undefined
  }

  /**
   * Verify an API credential without creating or reviving its operator.
   * @param request - request headers carrying Host and Cookie.
   * @param secure - whether the receiving listener uses TLS.
   * @returns the signed operator id, or undefined for invalid, expired, or browser cookies.
   */
  authenticateApi(request: ConnectionTrustRequest, secure = false): PeerId | undefined {
    return this.authenticate(request, secure)?.id
  }

  /** Consume one one-shot launch-token exchange path; false when spent or expired. */
  private exchangeLaunchToken(scope: 'index' | 'connect'): boolean {
    const now = Date.now()
    if (now >= this.state.launchTokenExpiresAt) return false
    if (scope === 'index') {
      if (this.state.indexExchanged) return false
      this.state.indexExchanged = true
      return true
    }
    if (this.state.connectExchanged) return false
    this.state.connectExchanged = true
    return true
  }

  /** Mint the browser or API cookie and write the redirect. */
  private setCookie(
    res: ConnectionIndexResponse,
    status: number,
    headers: Readonly<Record<string, string>>,
    authority: string,
    secure: boolean,
    options: { id?: PeerId; issuedAt?: number; expiresAt?: number; maxAgeSeconds?: number } = {},
  ): void {
    const issuedAt = options.issuedAt ?? Date.now()
    const expiresAt = options.expiresAt ?? cookieExpiry(issuedAt)
    const payload: CookiePayload = {
      version: COOKIE_PAYLOAD_VERSION,
      authority,
      issuedAt,
      expiresAt,
      ...options.id === undefined ? {} : { id: options.id },
    }
    res.writeHead(status, {
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      ...headers,
      'set-cookie': sessionCookie(
        cookieName(authority),
        encodeCookie(payload, this.state.secret),
        expiresAt,
        options.maxAgeSeconds ?? COOKIE_MAX_AGE_SECONDS,
        secure,
      ),
    })
    res.end()
  }

  private authenticate(request: ConnectionTrustRequest, secure: boolean): CookiePayload | undefined {
    const authority = requestAudience(request.headers, secure)
    const rawCookie = header(request.headers, 'cookie')
    if (authority === undefined || rawCookie === undefined) return undefined
    const value = cookieValue(rawCookie, cookieName(authority))
    if (value === undefined) return undefined
    const payload = decodeCookie(value, this.state.secret)
    if (payload === undefined || payload.authority !== authority) return undefined
    const now = Date.now()
    if (payload.issuedAt > now || payload.expiresAt <= now || payload.expiresAt <= payload.issuedAt
      || payload.expiresAt - payload.issuedAt > COOKIE_LIFETIME_MILLISECONDS) return undefined
    return payload
  }

  private writeUnauthorized(req: ConnectionIndexRequest, res: ConnectionIndexResponse): void {
    res.writeHead(401, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end(req.method === 'HEAD'
      ? undefined
      : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
  }

  private writeForbidden(res: ConnectionIndexResponse): void {
    res.writeHead(403, {
      'cache-control': 'no-store',
      'content-type': 'text/plain; charset=utf-8',
    })
    res.end('refresh must be a same-origin POST\n')
  }
}

/**
 * Whether a refresh request provably originates from the page the cookie
 * belongs to: `Origin` names the same authority and protocol, and a browser's
 * `Sec-Fetch-Site` metadata is `same-origin` or `none` when it is present.
 */
function isSameOrigin(
  headers: ConnectionTrustRequest['headers'],
  authority: string,
  secure: boolean,
): boolean {
  const origin = header(headers, 'origin')
  const expected = `${secure ? 'https:' : 'http:'}//${authority}`
  if (origin !== expected) return false
  const site = header(headers, 'sec-fetch-site')
  return site === undefined || site === 'same-origin' || site === 'none'
}
