/** Default token authentication, HTTP exchanges, and entry URL contribution. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-credentials'
import { CONNECT_PATH } from '@deepseek-ai/dsh-client-connection'
import type { ConnectionTrustRequest, PeerScope } from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BrowserAuth, DEFAULT_COOKIE_MAX_AGE_DAYS, REFRESH_PATH, discardLegacyBrowserSession } from './browser-auth.ts'

/** Stable plugin name. */
export const name = 'host-authentication-token'
/** Services owning request admission, the retired-secret cleanup, and the only cookie writer. */
export const inject = ['connection', 'connection.authentication', 'credentials']

/** Configuration of the browser-session lifetime. */
export interface Config {
  /**
   * Absolute lifetime of one browser session in days. A restarted process keeps
   * signing with the same stored secret, so this is how long a login lasts.
   * @default 30
   */
  cookieMaxAgeDays?: number
}

/** Validate the browser-session lifetime; every other lifetime is a fixed invariant. */
export const Config: z<Config> = z.object({
  cookieMaxAgeDays: z.natural().min(1).default(DEFAULT_COOKIE_MAX_AGE_DAYS),
})

/**
 * Register the token provider and its optional Web transport integration.
 * @param ctx - plugin scope owning the shared Peer and registrations.
 * @param config - browser-session lifetime.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const maxAgeDays = config.cookieMaxAgeDays ?? DEFAULT_COOKIE_MAX_AGE_DAYS
  try {
    if (await discardLegacyBrowserSession(ctx.credentials)) {
      ctx.logger.warn('host-authentication-token: discarded an unreadable browser-session secret record; browsers log in once more')
    }
  } catch (error: unknown) {
    // A malformed record is replaced, so the cleanup failure never blocks login.
    ctx.logger.warn(error instanceof Error ? error : new Error(String(error)))
  }
  const auth = await BrowserAuth.createPersistent(ctx[Context.root], ctx.credentials, maxAgeDays)
  const peer = ctx.connection.createPeer({ principal: { kind: 'owner' } })
  const apiPeers = new Map<PeerScope['id'], PeerScope>()
  ctx.connection.authentication.register({
    authenticate(request) {
      const secure = ctx.get('webServer')?.protocol === 'https:'
      if (auth.isAuthenticated(request, secure)) return peer
      const id = auth.authenticateApi(request, secure)
      return id === undefined ? undefined : apiPeers.get(id)
    },
  })
  ctx.inject(['webServer'], (webCtx) => {
    let active = true
    const sockets = new Map<PeerScope, () => Promise<void>>()
    webCtx.effect(() => async () => {
      active = false
      apiPeers.clear()
      await Promise.all([...sockets.values()].map(release => release()))
    }, 'host-authentication-token: API sockets')
    webCtx.on('webserver/request', async (request, response, next) => {
      const facts: ConnectionTrustRequest = request
      if (facts.socket?.destroyed || response.destroyed || facts.signal?.aborted) return
      if (!active) { await next(); return }
      const url = new URL(request.url ?? '/', 'http://dsh.invalid')
      if (url.pathname !== '/' || !url.searchParams.has('token')) {
        await next()
        return
      }
      auth.authorizeIndex(request, response, webCtx.webServer.protocol === 'https:')
    })
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: CONNECT_PATH, auth: 'anonymous',
      handler(request, response) {
        const facts: ConnectionTrustRequest = request
        if (facts.socket?.destroyed || response.destroyed || facts.signal?.aborted) return
        if (!active) {
          response.writeHead(401)
          response.end('unauthorized')
          return
        }
        auth.authorizeConnect(request, response, webCtx.webServer.protocol === 'https:', (interactions) => {
          const apiPeer = webCtx.connection.createPeer({ principal: { kind: 'owner' }, interactions })
          apiPeers.set(apiPeer.id, apiPeer)
          apiPeer.ctx.effect(() => () => { apiPeers.delete(apiPeer.id) }, 'authentication-token: API credential')
          return apiPeer.id
        })
      },
    }), 'host-authentication-token: API connect')
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact', path: REFRESH_PATH, auth: 'anonymous',
      handler(request, response) {
        const facts: ConnectionTrustRequest = request
        if (facts.socket?.destroyed || response.destroyed || facts.signal?.aborted) return
        if (!active) {
          response.writeHead(401)
          response.end('unauthorized')
          return
        }
        auth.authorizeRefresh(request, response, webCtx.webServer.protocol === 'https:')
      },
    }), 'host-authentication-token: cookie refresh')
    webCtx.on('webserver/upgrade', async (request, socket, _head, admittedPeer, next) => {
      if (admittedPeer === undefined) { await next(); return }
      if (new URL(request.url ?? '/', 'http://dsh.invalid').pathname !== '/api/remote.mux') {
        await next()
        return
      }
      if (apiPeers.get(admittedPeer.id) !== admittedPeer) {
        if (auth.authenticateApi(request, webCtx.webServer.protocol === 'https:') === admittedPeer.id) {
          socket.destroy()
          return
        }
        await next()
        return
      }
      if (!active || admittedPeer.signal.aborted) { socket.destroy(); return }
      if (sockets.has(admittedPeer)) {
        socket.end([
          'HTTP/1.1 409 Conflict',
          'Connection: close',
          'Content-Type: text/plain; charset=utf-8',
          'Content-Length: 8',
          '',
          'conflict',
        ].join('\r\n'))
        return
      }
      const closed = Promise.withResolvers<undefined>()
      let released: Promise<void> | undefined
      const release = (): Promise<void> => {
        if (released !== undefined) return released
        // Revocation precedes asynchronous Peer and stream cleanup.
        apiPeers.delete(admittedPeer.id)
        socket.destroy()
        released = Promise.all([
          closed.promise,
          admittedPeer.dispose().catch((error: unknown) => {
            console.error('[host-authentication-token] Peer release failed:', error)
          }),
        ]).then(() => {
          sockets.delete(admittedPeer)
          void disposeSocket()
        })
        return released
      }
      const failed = (): void => { void release() }
      const finish = (): void => {
        socket.removeListener('error', failed)
        socket.removeListener('close', finish)
        closed.resolve(undefined)
        void release()
      }
      sockets.set(admittedPeer, release)
      const disposeSocket = webCtx.effect(() => release, 'host-authentication-token: owned API socket')
      admittedPeer.ctx.effect(() => {
        socket.on('error', failed)
        socket.once('close', finish)
        return async () => {
          apiPeers.delete(admittedPeer.id)
          socket.destroy()
          // Await only the transport: release itself awaits this Peer disposer.
          await closed.promise
        }
      }, 'host-authentication-token: API socket')
      if (socket.closed) finish()
      if (socket.destroyed) { await release(); return }
      try {
        await next()
      } catch (error) {
        await release()
        throw error
      }
    })
  })
  ctx.on('webserver/entry-url', (baseUrl, entries) => {
    entries.push({ label: 'dsh web', url: auth.authenticatedUrl(baseUrl), displayUrl: baseUrl, open: true })
  })
}
