/** Browser launch-token, in-memory cookie, and refresh behavior. */

import { createHmac } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PeerId } from '@deepseek-ai/dsh-typert-protocol'
import { BrowserAuth, REFRESH_PATH } from '../src/browser-auth.ts'
import type { ConnectionIndexRequest, ConnectionIndexResponse } from '../src/types.ts'

const AUTHORITY = '127.0.0.1:3080'

function signedCookie(secret: string, name: string, payload: unknown): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', Buffer.from(secret, 'base64url')).update(body).digest('base64url')
  return `${name}=v3.${body}.${signature}`
}

interface ResponseState {
  status?: number
  headers?: Readonly<Record<string, string>>
  body?: string
}

function response(): { value: ConnectionIndexResponse; state: ResponseState } {
  const state: ResponseState = {}
  return {
    value: {
      writeHead(status, headers) {
        state.status = status
        if (headers !== undefined) state.headers = headers
      },
      end(body) {
        if (body !== undefined) state.body = body
      },
    },
    state,
  }
}

function request(url: string, authority = AUTHORITY, init?: {
  cookie?: string
  method?: string
  origin?: string
  site?: string
}): ConnectionIndexRequest {
  return {
    method: init?.method ?? 'GET',
    url,
    headers: {
      host: authority,
      ...init?.cookie === undefined ? {} : { cookie: init.cookie },
      ...init?.origin === undefined ? {} : { origin: init.origin },
      ...init?.site === undefined ? {} : { 'sec-fetch-site': init.site },
    },
  }
}

function exchange(
  auth: BrowserAuth,
  authority = AUTHORITY,
  secure = false,
): { cookie: string; launchUrl: string; state: ResponseState } {
  const launchUrl = auth.authenticatedUrl(`${secure ? 'https' : 'http'}://${authority}`)
  const target = new URL(launchUrl)
  const res = response()
  expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`, authority), res.value, secure)).toBe(false)
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('token exchange did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, launchUrl, state: res.state }
}

function exchangeStatus(auth: BrowserAuth): number | undefined {
  const target = new URL(auth.authenticatedUrl(`http://${AUTHORITY}`))
  const res = response()
  auth.authorizeIndex(request(`${target.pathname}${target.search}`), res.value)
  return res.state.status
}

function refresh(
  auth: BrowserAuth,
  cookie: string,
  init?: { origin?: string; site?: string; method?: string; authority?: string },
): ResponseState {
  const res = response()
  const authority = init?.authority ?? AUTHORITY
  auth.authorizeRefresh(request(REFRESH_PATH, authority, {
    method: init?.method ?? 'POST',
    cookie,
    origin: init?.origin ?? `http://${authority}`,
    ...init?.site === undefined ? {} : { site: init.site },
  }), res.value)
  return res.state
}

afterEach(() => {
  vi.useRealTimers()
})

describe('launch token', () => {
  it('is one-shot for the index, one-shot for /connect, and expires after ten minutes', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = BrowserAuth.create({})
    const first = exchange(auth)
    const replay = response()
    const target = new URL(first.launchUrl)
    expect(auth.authorizeIndex(request(`${target.pathname}${target.search}`), replay.value)).toBe(false)
    expect(replay.state.status).toBe(401)

    // The /connect scope spends its own single use.
    const connect = auth.authenticatedUrl(`http://${AUTHORITY}/connect`)
    const publish = vi.fn(() => 'api-operator' as PeerId)
    const connected = response()
    auth.authorizeConnect(request(new URL(connect).pathname + new URL(connect).search), connected.value, false, publish)
    expect(connected.state.status).toBe(302)
    const reconnected = response()
    auth.authorizeConnect(request(new URL(connect).pathname + new URL(connect).search), reconnected.value, false, publish)
    expect(reconnected.state.status).toBe(401)
    expect(publish).toHaveBeenCalledTimes(1)

    // The ten-minute window starts when the process state is created.
    const nearlyAuth = BrowserAuth.create({})
    const expiredAuth = BrowserAuth.create({})
    vi.setSystemTime(new Date('2026-08-24T00:09:59.999Z'))
    expect(exchange(nearlyAuth).state.status).toBe(303)
    vi.setSystemTime(new Date('2026-08-24T00:10:00.000Z'))
    expect(exchangeStatus(expiredAuth)).toBe(401)
  })

  it('is shared across reloads of the same root and replaced by a restart', () => {
    const root = {}
    const first = BrowserAuth.create(root)
    const reloaded = BrowserAuth.create(root)
    const restarted = BrowserAuth.create({})
    expect(reloaded.authenticatedUrl(`http://${AUTHORITY}`)).toBe(first.authenticatedUrl(`http://${AUTHORITY}`))
    expect(new URL(restarted.authenticatedUrl(`http://${AUTHORITY}`)).searchParams.get('token'))
      .not.toBe(new URL(first.authenticatedUrl(`http://${AUTHORITY}`)).searchParams.get('token'))
  })

  it('preserves the caller authority and mount while adding only this process token', () => {
    const auth = BrowserAuth.create({})
    const mounted = new URL(auth.authenticatedUrl('https://gateway.example/tools/dsh/'))
    expect(mounted.origin).toBe('https://gateway.example')
    expect(mounted.pathname).toBe('/tools/dsh/')
    expect([...mounted.searchParams.keys()]).toEqual(['token'])

    const loopback = new URL(auth.authenticatedUrl(`http://${AUTHORITY}/`))
    expect(loopback.origin).toBe(`http://${AUTHORITY}`)
    expect(loopback.pathname).toBe('/')
    expect(loopback.searchParams.get('token')).toBe(mounted.searchParams.get('token'))
  })

  it('gives every unauthenticated request one response', () => {
    const auth = BrowserAuth.create({})
    for (const candidate of [
      request('/'),
      request('/?token=wrong'),
      request('/?token=wrong&token=again'),
      request('/index.html?token=wrong'),
      request(auth.authenticatedUrl(`http://${AUTHORITY}`), AUTHORITY, { method: 'HEAD' }),
    ]) {
      const denied = response()
      expect(auth.authorizeIndex(candidate, denied.value)).toBe(false)
      expect(denied.state.status).toBe(401)
      expect(denied.state.headers).toEqual({
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      })
      expect(denied.state.body).toBe(candidate.method === 'HEAD'
        ? undefined
        : 'dsh web authentication required; reopen the URL printed by dsh web.\n')
    }
  })
})

describe('browser cookie', () => {
  it('is process-memory signed, authority-bound, and one day long', () => {
    const auth = BrowserAuth.create({})
    const login = exchange(auth)
    expect(login.state).toMatchObject({
      status: 303,
      headers: {
        'cache-control': 'no-store',
        'location': './',
        'referrer-policy': 'no-referrer',
      },
    })
    const setCookie = login.state.headers?.['set-cookie']
    expect(setCookie).toMatch(/; Max-Age=86400; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    expect(setCookie).not.toContain('Secure')
    const [, value] = login.cookie.split('=') as [string, string]
    expect(value.startsWith('v3.')).toBe(true)
    const payload = JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ version: 3, authority: AUTHORITY })
    expect(payload.expiresAt - payload.issuedAt).toBe(86_400_000)

    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie: login.cookie }))).toBe(true)
    expect(auth.isAuthenticated({
      headers: new Headers({ host: AUTHORITY, cookie: login.cookie }),
    })).toBe(true)
    expect(auth.isAuthenticated({ headers: new Headers() })).toBe(false)
    expect(auth.isAuthenticated(request('/', 'localhost:3080', { cookie: login.cookie }))).toBe(false)
    expect(auth.isAuthenticated(request('/', '127.0.0.1:3081', { cookie: login.cookie }))).toBe(false)
    // The cookie is a browser session, not an API credential.
    expect(auth.authenticateApi(request('/', AUTHORITY, { cookie: login.cookie }))).toBeUndefined()
  })

  it('rejects a cookie forged with the retired durable secret', () => {
    const auth = BrowserAuth.create({})
    const issuedAt = Date.now()
    const payload = { version: 3, authority: AUTHORITY, issuedAt, expiresAt: issuedAt + 86_400_000 }
    const name = exchange(auth).cookie.split('=', 1)[0]!
    const forged = signedCookie(Buffer.alloc(32, 7).toString('base64url'), name, payload)
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie: forged }))).toBe(false)
    expect(auth.authenticateApi(request('/', AUTHORITY, { cookie: forged }))).toBeUndefined()
  })

  it('rejects tampering, a previous process, expiry, future issuance, and a legacy version', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = BrowserAuth.create({})
    const { cookie } = exchange(auth)
    const [name, value] = cookie.split('=') as [string, string]

    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie: `${name}=broken` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie: `${name}=${value.slice(0, -1)}x` }))).toBe(false)
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie: `${name}=%` }))).toBe(false)
    expect(auth.isAuthenticated({ headers: {} })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: 'bad host', cookie } })).toBe(false)
    expect(auth.isAuthenticated({ headers: { host: AUTHORITY } })).toBe(false)
    // Version 1 and 2 payloads are retired with the durable secret.
    expect(auth.isAuthenticated(request('/', AUTHORITY, {
      cookie: cookie.replace('=v3.', '=v2.'),
    }))).toBe(false)

    // A restart cannot reproduce the signing secret.
    const restarted = BrowserAuth.create({})
    expect(restarted.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(false)

    // Issued in the future relative to the verifier's clock.
    vi.setSystemTime(new Date('2026-08-23T23:59:59.000Z'))
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(false)

    // One day after the login the cookie is expired.
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(false)
    vi.setSystemTime(new Date('2026-08-24T23:59:59.000Z'))
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(true)
  })

  it('keeps HTTPS port 443 distinct from HTTP port 80', () => {
    const plainAuth = BrowserAuth.create({})
    const tlsAuth = BrowserAuth.create({})
    const plain = exchange(plainAuth, 'harness.example')
    const tls = exchange(tlsAuth, 'harness.example', true)
    expect(tls.state.headers?.['set-cookie']).toContain('; Secure')
    expect(tlsAuth.isAuthenticated(request('/', 'harness.example', { cookie: plain.cookie }), true)).toBe(false)
    expect(tlsAuth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }), true)).toBe(true)
    expect(tlsAuth.isAuthenticated(request('/', 'harness.example:443', { cookie: tls.cookie }), true)).toBe(true)
    expect(tlsAuth.isAuthenticated(request('/', 'harness.example', { cookie: tls.cookie }))).toBe(false)
  })
})

describe('API credential', () => {
  it('signs the published id as a v3 cookie and rejects browser confusion', () => {
    vi.useFakeTimers()
    const auth = BrowserAuth.create({})
    const id = 'api-operator' as PeerId
    const publish = vi.fn(() => id)
    const res = response()
    auth.authorizeConnect(request(auth.authenticatedUrl(`http://${AUTHORITY}/connect`)), {
      ...res.value,
      writeHead(status, headers) {
        expect(publish).toHaveBeenCalledExactlyOnceWith('none')
        return res.value.writeHead(status, headers)
      },
    }, false, publish)
    const cookie = res.state.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('API connect did not set a cookie')
    const [name, value] = cookie.split('=') as [string, string]
    const payload = JSON.parse(Buffer.from(value.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload).toMatchObject({ version: 3, authority: AUTHORITY, id })
    expect(auth.authenticateApi(request('/', AUTHORITY, { cookie }))).toBe(id)
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(false)
    expect(auth.authenticateApi(request('/', AUTHORITY, { cookie: `${name}=${value.slice(0, -1)}!` }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', 'localhost:3080', { cookie }))).toBeUndefined()
    expect(auth.authenticateApi(request('/', AUTHORITY, { cookie }), true)).toBeUndefined()

    vi.setSystemTime(payload.expiresAt)
    expect(auth.authenticateApi(request('/', AUTHORITY, { cookie }))).toBeUndefined()
  })

  it('refuses a request without a URL before publishing an API operator', () => {
    const auth = BrowserAuth.create({})
    const publish = vi.fn(() => 'api-operator' as PeerId)
    const res = response()
    auth.authorizeConnect({ method: 'GET', headers: { host: 'localhost' } }, res.value, false, publish)
    expect(res.state.status).toBe(401)
    expect(publish).not.toHaveBeenCalled()
  })
})

describe('cookie refresh', () => {
  it('renews a browser cookie for the remainder of its first-login day', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T00:00:00.000Z'))
    const auth = BrowserAuth.create({})
    const login = exchange(auth)
    const first = JSON.parse(Buffer.from(login.cookie.split('.')[1]!, 'base64url').toString('utf8'))

    vi.setSystemTime(new Date('2026-08-24T12:00:00.000Z'))
    const renewed = refresh(auth, login.cookie)
    expect(renewed.status).toBe(204)
    expect(renewed.headers?.['set-cookie']).toMatch(/; Max-Age=43200; Path=\/; Expires=.*; HttpOnly; SameSite=Strict$/u)
    const cookie = renewed.headers?.['set-cookie']?.split(';', 1)[0]
    if (cookie === undefined) throw new Error('refresh did not set a cookie')
    const payload = JSON.parse(Buffer.from(cookie.split('.')[1]!, 'base64url').toString('utf8'))
    expect(payload.expiresAt).toBe(first.expiresAt)
    expect(payload.issuedAt).toBe(Date.parse('2026-08-24T12:00:00.000Z'))
    expect(auth.isAuthenticated(request('/', AUTHORITY, { cookie }))).toBe(true)

    // Renewal never extends the session past its first-login day.
    vi.setSystemTime(new Date('2026-08-25T00:00:00.000Z'))
    expect(refresh(auth, cookie).status).toBe(401)
  })

  it('refuses cross-site and non-POST callers before reading the cookie', () => {
    const auth = BrowserAuth.create({})
    const login = exchange(auth)
    expect(refresh(auth, login.cookie, { origin: 'http://evil.example' }).status).toBe(403)
    expect(refresh(auth, login.cookie, { site: 'cross-site' }).status).toBe(403)
    expect(refresh(auth, login.cookie, { site: 'same-site' }).status).toBe(403)
    expect(refresh(auth, login.cookie, { method: 'GET' }).status).toBe(403)
    expect(refresh(auth, login.cookie, { authority: 'localhost:3080', origin: `http://${AUTHORITY}` }).status).toBe(403)
    // A stale or forged cookie reaches the 401 path only after same-origin validation.
    expect(refresh(auth, `${login.cookie}x`).status).toBe(401)
    expect(refresh(auth, login.cookie, { site: 'same-origin' }).status).toBe(204)
  })
})
