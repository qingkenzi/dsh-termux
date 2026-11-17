/**
 * @deepseek-ai/dsh-web-app — the browser-surface bundle's runtime glue plugin
 * plus the bundle patch (`cordis.patch.yml`, declared by the `dsh.bundle.patch`
 * manifest field). The plugin owns the browser-surface glue: it resolves
 * the built frontend dist (workspace knowledge of this bundle, never user
 * config), mounts the `frontend-static` fallback owner over it, registers the
 * bash-visible web runtime variable, the entry URL lines, and the
 * default-browser handoff, and provides the `webApp` service. An advertised
 * `publicUrl` replaces the published bind-address URL. Non-loopback
 * HTTP binds trigger an exposure warning. App command-line values arrive
 * through the `webStartup` service expressions in the bundle patch.
 * @module @deepseek-ai/dsh-web-app
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { auditStartupEntries } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import * as FrontendStatic from '@deepseek-ai/dsh-host-frontend-static'
import { bindUrlHost, isLoopbackHost, type WebEntryUrl } from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { launchedThroughSsh, launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-shell-env'
import { parsePublicUrl } from './public-url.ts'

/**
 * How startup publishes the login URL: `auto` prints it only on an interactive
 * terminal that is not opening a browser and otherwise writes a 0600 file;
 * `always` prints it with a secret warning; `never` prints no URL at all.
 */
export type PrintUrlMode = 'auto' | 'always' | 'never'

/** The Web GUI this process serves, provided by the `web-runtime` row. */
export interface WebApp {
  /**
   * The URL this GUI advertises, also used for `DSH_WEB_URL` and the startup URL line.
   * @returns the configured `publicUrl`, otherwise the listener origin.
   */
  getAdvertisedUrl(): string
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Web GUI this process serves; absent when no Web runtime is mounted. */
    webApp: WebApp
  }
}

/** Stable Cordis plugin name. */
export const name = 'web-app'

const ANNOUNCED_ROOTS = new WeakSet<Context>()

/** Services required before the web runtime can mount. */
export const inject = ['webServer']

/** Plugin config: composed deployment settings plus per-invocation command-line values. */
export interface Config {
  /** Permit default-browser handoff after the Loader tree settles; an SSH launch suppresses it. */
  openBrowser: boolean
  /**
   * Login-URL publication for this invocation. `auto` keeps the one-time
   * secret out of captured stdout: an interactive terminal that is not opening
   * a browser receives the full URL, while every other invocation writes it to
   * `$DSH_HOME/run/web-<pid>.url` (directory 0700, file 0600, removed on exit)
   * and prints only that path. `always` prints the full URL and warns that it
   * is a credential. `never` prints no URL.
   * @default 'auto'
   */
  printUrl: PrintUrlMode
  /**
   * Register the `DSH_WEB_URL` bash variable naming this GUI. A one-shot
   * non-interactive layer can turn it off when its user is not in the GUI.
   */
  surfaceContext: boolean
  /**
   * Canonical HTTP(S) root to advertise in the printed and opened URL,
   * `DSH_WEB_URL`, and `webApp.getAdvertisedUrl()`, which supplies the Web GUI
   * URL in agent runtime context, e.g. `https://app.example/ui/`, normalized to end in `/`. Configures no routing
   * or authentication; see [public deployments](../README.md#public-deployments).
   * Absent or YAML `null` advertises the bind-address URL.
   */
  publicUrl?: string
}

export const Config: z<Config> = z.object({
  openBrowser: z.boolean().default(true),
  printUrl: z.union(['auto', 'always', 'never']).default('auto'),
  surfaceContext: z.boolean().default(true),
  publicUrl: z.transform(z.string(), value => parsePublicUrl(value).href),
})

/** Environment variable naming the advertised URL of this Web GUI. */
const DSH_WEB_URL = 'DSH_WEB_URL' as const

/**
 * Write this process's complete entry URLs to its private run file.
 * @param entries - contributed entries, written in order.
 * @returns the file path, inside a 0700 directory, readable only by this user.
 */
async function writeLoginUrlFile(entries: readonly WebEntryUrl[]): Promise<string> {
  const path = join(resolveDshHome(), 'run', `web-${String(process.pid)}.url`)
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  await writeFile(path, entries.map(entry => `${entry.label}: ${entry.url}`).join('\n') + '\n', { mode: 0o600 })
  await chmod(path, 0o600)
  return path
}

/** Remove this process's run file; a stale file must not outlive the listener. */
async function removeLoginUrlFile(path: string): Promise<void> {
  await rm(path, { force: true })
}

const BROWSER_OPENER_MODULE = import.meta.resolve('open')

const BROWSER_OPENER_PROGRAM = `
try {
  const { default: open } = await import(${JSON.stringify(BROWSER_OPENER_MODULE)})
  const launcher = await open(process.argv[1])
  if (process.platform === 'win32') {
    // open resolves at PowerShell spawn; keep it referenced until that launcher hands the URL to Windows.
    const code = launcher.exitCode ?? await new Promise((resolve, reject) => {
      function onError(error) {
        launcher.off('close', onClose)
        reject(error)
      }
      function onClose(code) {
        launcher.off('error', onError)
        resolve(code)
      }
      launcher.ref()
      launcher.once('error', onError)
      launcher.once('close', onClose)
    })
    if (code !== 0) throw new Error('browser operating-system launcher exited with code ' + String(code))
  }
  process.exitCode = 0
} catch (error) {
  // The parent turns this exit into the manual-URL warning.
  console.error(error)
  process.exitCode = 1
}
`

/**
 * Dist location is workspace knowledge of this bundle: anchored on the
 * frontend package manifest, not configured. Existence is a request-time
 * concern — the fallback owner reads files per request, so a composition
 * whose page never reaches the fallback seat (the static worker preview
 * ships its own page and carries no dist) boots without one.
 */
function resolveDistIndex(): string {
  const require = createRequire(import.meta.url)
  try {
    return join(dirname(require.resolve('@deepseek-ai/dsh-web-frontend/package.json')), 'dist', 'index.html')
  } catch {
    /* v8 ignore next 2 -- reachable only when the frontend package is absent from the checkout */
    throw new Error('web-app: @deepseek-ai/dsh-web-frontend is not resolvable from this composition')
  }
}

/** Start the maintained platform opener without forwarding Harness credentials. */
function spawnBrowserLauncher(url: string): ChildProcess {
  return spawn(process.execPath, [
    '--input-type=module',
    '--eval', BROWSER_OPENER_PROGRAM,
    '--', url,
  ], {
    env: scrubbedParentEnv(),
    stdio: ['ignore', 'inherit', 'pipe'],
  })
}

/** Hand one URL to the operating system's default browser. */
async function openBrowser(url: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const launcher = spawnBrowserLauncher(url)
  let launcherStderr = ''
  launcher.stderr?.setEncoding('utf8')
  launcher.stderr?.on('data', (chunk: string) => { launcherStderr += chunk })
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => { launcher.kill() }
    function onError(error: Error): void {
      launcher.off('close', onClose)
      signal?.removeEventListener('abort', abort)
      reject(error)
    }
    function onClose(code: number | null): void {
      launcher.off('error', onError)
      signal?.removeEventListener('abort', abort)
      if (signal?.aborted) {
        reject(signal.reason instanceof Error ? signal.reason : new Error('Browser handoff cancelled', { cause: signal.reason }))
        return
      }
      if (code !== 0) {
        const firstLine = launcherStderr.trim().split(/\r?\n/u)[0]
        const reason = firstLine === undefined || firstLine === ''
          ? `browser launcher exited with code ${String(code)}`
          : firstLine.replace(/^(?:[A-Za-z]*Error):\s*/u, '')
        reject(new Error(reason))
        return
      }
      if (launcherStderr !== '') process.stderr.write(launcherStderr)
      resolve()
    }
    launcher.once('error', onError)
    launcher.once('close', onClose)
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
  })
}

/** Test hooks for the built dist, browser handoff, and private URL file; production never mutates them. */
export const internals: {
  resolveDistIndex: () => string
  openBrowser: (url: string, signal?: AbortSignal) => Promise<void>
  loginUrlFile: (entries: readonly WebEntryUrl[]) => Promise<string>
  removeLoginUrlFile: (path: string) => Promise<void>
} = { resolveDistIndex, openBrowser, loginUrlFile: writeLoginUrlFile, removeLoginUrlFile }

/**
 * Mount the Web runtime: dist serving, the bash runtime variable, entry URL
 * publication, and the default-browser handoff.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  // The schema validates a present string; an explicit YAML `null` bypasses
  // the string transform and reaches here, meaning unset.
  const publicUrl = config.publicUrl ?? undefined
  const boundHost = ctx.webServer.host
  if (publicUrl === undefined && bindUrlHost(boundHost) === undefined) {
    throw new Error(
      `web-app: bind address ${JSON.stringify(boundHost)} carries an interface zone id, which no URL can express;`
      + ' pass --public-url with the root browsers actually reach it through',
    )
  }
  if (ctx.webServer.protocol === 'http:' && !isLoopbackHost(boundHost)) {
    console.warn(`dsh web: listening on ${boundHost} over plain HTTP; restrict this port to a trusted proxy or network`)
  }
  // The bind URL belongs to this host. Under SSH, the operator reaches it
  // through a local forwarding address that this process cannot derive.
  const handoffBrowser = config.openBrowser && !launchedThroughSsh(launchEnvironmentOf(ctx))
  /** The advertised root: the canonical `publicUrl`, or the listener's own origin. */
  const appRootUrl = (): string => publicUrl ?? ctx.webServer.getOrigin()
  ctx.provide('webApp', { getAdvertisedUrl: appRootUrl } satisfies WebApp)
  ctx.plugin(FrontendStatic, { distIndex: internals.resolveDistIndex() })
  if (config.surfaceContext) {
    ctx.inject(['shellEnv'], (runtimeCtx) => {
      runtimeCtx.shellEnv.register({
        name: 'web-runtime',
        variables: {
          [DSH_WEB_URL]: { description: 'Advertised URL of the DeepSeek Harness Web GUI serving this session.' },
        },
        resolve: () => ({ [DSH_WEB_URL]: appRootUrl() }),
      })
    })
  }
  if (config.printUrl !== 'never' || handoffBrowser) {
    const lifetime = new AbortController()
    let opening: Promise<void> | undefined
    let urlFile: string | undefined
    let publishing: Promise<unknown> | undefined
    const publishUrlFile = async (entries: readonly WebEntryUrl[]): Promise<string | undefined> => {
      if (urlFile !== undefined) return urlFile
      if (lifetime.signal.aborted) return undefined
      try {
        const written = await internals.loginUrlFile(entries)
        if (lifetime.signal.aborted) {
          await internals.removeLoginUrlFile(written)
          return undefined
        }
        urlFile = written
        return written
      } catch (error: unknown) {
        if (lifetime.signal.aborted) return undefined
        console.error(`web-app: could not write the login URL file because ${error instanceof Error ? error.message : String(error)}`)
        return undefined
      }
    }
    ctx.effect(() => async () => {
      lifetime.abort()
      await opening
      await publishing
      if (urlFile !== undefined) await internals.removeLoginUrlFile(urlFile)
    }, 'web-app: startup handoff')
    const announceReady = (): void => {
      if (lifetime.signal.aborted || ctx.get('webServer') === undefined || ANNOUNCED_ROOTS.has(ctx[Context.root])) return
      const entries: WebEntryUrl[] = []
      ctx.emit(ctx.webServer, 'webserver/entry-url', appRootUrl(), entries)
      ANNOUNCED_ROOTS.add(ctx[Context.root])
      const entry = entries.find(entry => entry.open)
      if (config.printUrl === 'always' && entries.length > 0) {
        for (const printed of entries) console.log(`${printed.label}: ${printed.url}`)
        console.warn('dsh web: the printed URL contains a one-time login secret; anyone who can read it can open this GUI until the token is used or expires')
      } else if (config.printUrl === 'auto' && entries.length > 0) {
        // Off a terminal, and when opening a browser, the secret never reaches
        // captured stdout or a log; the operator reads it from the run file.
        if (!handoffBrowser && process.stdout.isTTY === true) {
          for (const printed of entries) console.log(`${printed.label}: ${printed.url}`)
        } else if (process.stdout.isTTY !== true) {
          publishing = publishUrlFile(entries).then(path => {
            if (path !== undefined && !lifetime.signal.aborted) console.log(`dsh web: login URL written to ${path}`)
          })
        }
      }
      if (handoffBrowser && entry !== undefined) {
        console.log(`dsh web: opening ${entry.displayUrl} in the default browser; pass --no-open to disable`)
        opening = internals.openBrowser(entry.url, lifetime.signal).catch(async (error: unknown) => {
          if (lifetime.signal.aborted) return
          const reason = (error instanceof Error ? error.message : String(error)).replaceAll(entry.url, '[login URL]')
          const path = config.printUrl === 'auto' ? await publishUrlFile(entries) : undefined
          console.error(`web-app: could not open the default browser because ${reason};`
            + (path === undefined ? ' use the dsh web URL printed at startup' : ` open it from ${path}`))
        })
      }
    }
    const settled = ctx.get('loader')?.await()
    if (settled === undefined) announceReady()
    else {
      void settled.then(async () => {
        if (lifetime.signal.aborted) return
        await auditStartupEntries(ctx[Context.root], 'dsh web', () => {})
        announceReady()
      }).catch(() => {
        // The Loader/startup audit owns failure diagnostics; failed startup remains unpublished.
      })
    }
  }
}
