/** WebApp collects provider entry URLs and owns browser handoff. */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as AppBoot from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import type { WebEntryUrl, WebServer } from '@deepseek-ai/dsh-host-webserver'
import { apply, type Config, internals } from '../src/index.ts'

const originalOpen = internals.openBrowser
const originalLoginUrlFile = internals.loginUrlFile
const originalRemoveLoginUrlFile = internals.removeLoginUrlFile
afterEach(() => {
  internals.openBrowser = originalOpen
  internals.loginUrlFile = originalLoginUrlFile
  internals.removeLoginUrlFile = originalRemoveLoginUrlFile
  Reflect.deleteProperty(process.stdout, 'isTTY')
  vi.restoreAllMocks()
})

async function setup(options: { origin?: string; ssh?: 'SSH_CONNECTION' | 'SSH_TTY'; settle?: () => Promise<void> } = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([
    { source: 'process', values: options.ssh === undefined ? {} : { [options.ssh]: 'remote-launch' } },
    { source: 'project-env', path: '/project/.env', values: { SSH_TTY: 'project-setting' } },
  ]))
  if (options.settle !== undefined) ctx.provide('loader', { await: options.settle, entries: () => [] } as never)
  const server: Pick<WebServer, 'host' | 'protocol' | 'registerFallback'> = {
    host: '127.0.0.1', protocol: 'http:', registerFallback: () => () => {},
  }
  ctx.provide('webServer', server as WebServer)
  const baseUrl = () => options.origin ?? 'http://127.0.0.1:3080/'
  const auth = { authenticatedUrl: (url: string) => `${url}?token=fixture-token` }
  const removeEntry = ctx.on('webserver/entry-url', (url, entries) => {
    entries.push({ label: 'dsh web', url: auth.authenticatedUrl(url), displayUrl: url, open: true })
  })
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const open = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined)
  internals.openBrowser = open
  const written = vi.fn<(entries: readonly WebEntryUrl[]) => Promise<string>>(() => Promise.resolve('/run/web-1.url'))
  const removed = vi.fn<(path: string) => Promise<void>>(() => Promise.resolve())
  internals.loginUrlFile = written
  internals.removeLoginUrlFile = removed
  return { ctx, auth, log, error, open, baseUrl, removeEntry, written, removed }
}

/** Exercise startup through the same plugin entry as the Loader. */
function publishStartup(ctx: Context, config: Pick<Config, 'printUrl' | 'openBrowser'>, baseUrl: () => string): void {
  apply(ctx, { ...config, publicUrl: baseUrl(), surfaceContext: false })
}

it('prints and opens its authenticated advertised URL in order', async () => {
  const { ctx, baseUrl, auth, log, open } = await setup({ origin: 'https://public.test/ui/' })
  const events: string[] = []
  log.mockImplementation((value) => { events.push(String(value)) })
  open.mockImplementation((url) => { events.push(`open:${url}`); return Promise.resolve() })
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  const expected = auth.authenticatedUrl('https://public.test/ui/')
  await vi.waitFor(() => { expect(events).toEqual([
    `dsh web: ${expected}`,
    'dsh web: opening https://public.test/ui/ in the default browser; pass --no-open to disable',
    `open:${expected}`,
  ]) })
})

it('keeps startup dormant when both flags are disabled', async () => {
  const { ctx, baseUrl, log, open } = await setup()
  publishStartup(ctx, { printUrl: 'never', openBrowser: false }, baseUrl)
  expect(log).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it.each(['SSH_CONNECTION', 'SSH_TTY'] as const)('prints without opening when %s marks SSH', async (ssh) => {
  const remote = await setup({ ssh })
  publishStartup(remote.ctx, { printUrl: 'always', openBrowser: true }, remote.baseUrl)
  await vi.waitFor(() => { expect(remote.log).toHaveBeenCalledWith(`dsh web: ${remote.auth.authenticatedUrl('http://127.0.0.1:3080/')}`) })
  expect(remote.open).not.toHaveBeenCalled()
})

it('honors no-open while still printing the login URL', async () => {
  const { ctx, baseUrl, log, open } = await setup()
  publishStartup(ctx, { printUrl: 'always', openBrowser: false }, baseUrl)
  await vi.waitFor(() => { expect(log).toHaveBeenCalledOnce() })
  expect(open).not.toHaveBeenCalled()
})

it('waits for Loader settlement and suppresses a disposed publication', async () => {
  const gate = Promise.withResolvers<undefined>()
  const first = await setup({ settle: () => gate.promise })
  const plugin = first.ctx.plugin({ apply(scope: Context) { publishStartup(scope, { printUrl: 'always', openBrowser: true }, first.baseUrl) } })
  await plugin.await()
  expect(first.log).not.toHaveBeenCalled()
  await plugin.dispose()
  gate.resolve(undefined)
  await gate.promise
  await Promise.resolve()
  expect(first.log).not.toHaveBeenCalled()
  expect(first.open).not.toHaveBeenCalled()
})

it.each(['disposed', 'unavailable'] as const)('does not publish when startup becomes %s during the audit', async (state) => {
  const entered = Promise.withResolvers<undefined>()
  const audited = Promise.withResolvers<undefined>()
  const { ctx, baseUrl, log, open } = await setup({ settle: () => Promise.resolve() })
  vi.spyOn(AppBoot, 'auditStartupEntries').mockImplementation(() => {
    entered.resolve(undefined)
    return audited.promise
  })
  const plugin = ctx.plugin({ apply(scope: Context) { publishStartup(scope, { printUrl: 'always', openBrowser: true }, baseUrl) } })
  try {
    await plugin.await()
    await entered.promise
    if (state === 'disposed') await plugin.dispose()
    else ctx.set('webServer', undefined)
  } finally {
    audited.resolve(undefined)
    await audited.promise
  }
  expect(log).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it('joins a cancelled browser handoff without reporting it as a launch failure', async () => {
  const { ctx, baseUrl, error } = await setup()
  const handoff = Promise.withResolvers<undefined>()
  const open = vi.fn<typeof internals.openBrowser>(() => handoff.promise)
  internals.openBrowser = open
  let disposing: Promise<void> | undefined
  try {
    const plugin = ctx.plugin({ apply(scope: Context) { publishStartup(scope, { printUrl: 'never', openBrowser: true }, baseUrl) } })
    await plugin.await()
    expect(open).toHaveBeenCalledOnce()
    const signal = open.mock.calls[0]![1]!
    const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
    let disposed = false
    disposing = plugin.dispose().then(() => { disposed = true })
    await aborted
    expect(signal.aborted).toBe(true)
    expect(disposed).toBe(false)
  } finally {
    handoff.reject(new Error('browser handoff cancelled'))
    await disposing
  }
  expect(error).not.toHaveBeenCalled()
})

it('publishes after successful Loader settlement', async () => {
  const gate = Promise.withResolvers<undefined>()
  const { ctx, baseUrl, auth, log, open } = await setup({ settle: () => gate.promise })
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  expect(log).not.toHaveBeenCalled()
  gate.resolve(undefined)
  await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  expect(log).toHaveBeenCalledWith(`dsh web: ${auth.authenticatedUrl('http://127.0.0.1:3080/')}`)
})

it('collects an entry registered while application readiness is pending', async () => {
  const gate = Promise.withResolvers<undefined>()
  const { ctx, baseUrl, removeEntry, log, open } = await setup({ settle: () => gate.promise })
  removeEntry()
  const collect = vi.fn()
  ctx.on('webserver/entry-url', collect)
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  expect(collect).not.toHaveBeenCalled()
  ctx.on('webserver/entry-url', (_base, entries) => {
    entries.push({ label: 'dsh late', url: 'https://late.test/', displayUrl: 'https://late.test/', open: true })
  })
  gate.resolve(undefined)
  await vi.waitFor(() => { expect(open).toHaveBeenCalledOnce() })
  expect(collect).toHaveBeenCalledOnce()
  expect(log).toHaveBeenCalledWith('dsh late: https://late.test/')
})

it('does not announce failed Loader startup', async () => {
  const { ctx, baseUrl, log, open } = await setup({ settle: () => Promise.reject(new Error('loader failed')) })
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  await Promise.resolve()
  await Promise.resolve()
  expect(log).not.toHaveBeenCalled()
  expect(open).not.toHaveBeenCalled()
})

it.each([
  { id: 'webserver', announces: false },
  { id: 'modules', announces: false },
  { id: 'connection', announces: false },
  { id: 'optional-tool', announces: true },
])('announces=$announces after the $id sibling fails', async ({ id, announces }) => {
  const { ctx, baseUrl, log, open } = await setup()
  ctx.baseUrl = 'file:///'
  await ctx.plugin(Loader)
  ctx.loader.builtins.failure = () => { throw new Error('sibling rejected') }
  await ctx.loader.root.update([{ id, name: 'cordis:failure' }])
  await ctx.loader.await()
  await expect(ctx.loader.resolve(id).fiber?.await()).rejects.toThrow('sibling rejected')
  const audit = vi.spyOn(AppBoot, 'auditStartupEntries')
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  await vi.waitFor(() => { expect(audit).toHaveBeenCalledOnce() })
  await Promise.allSettled(audit.mock.results.map(result => result.value as Promise<void>))
  expect(open).toHaveBeenCalledTimes(announces ? 1 : 0)
  expect(log).toHaveBeenCalledTimes(announces ? 2 : 0)
})

it('publishes at most once across WebApp reloads in the same application', async () => {
  const { ctx, baseUrl, log, open } = await setup()
  const config = { printUrl: 'always' as const, openBrowser: true, publicUrl: baseUrl(), surfaceContext: false }
  const first = ctx.plugin({ apply }, config)
  await first.await()
  await first.dispose()
  await ctx.plugin({ apply }, config).await()
  expect(log).toHaveBeenCalledTimes(2)
  expect(open).toHaveBeenCalledOnce()
})

it.each([new Error('launcher unavailable'), 'launcher unavailable'])('reports opener failure without disclosing the token: %s', async (failure) => {
  const { ctx, baseUrl, auth, error, open } = await setup()
  open.mockRejectedValue(failure)
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  await vi.waitFor(() => { expect(error).toHaveBeenCalledOnce() })
  expect(error).toHaveBeenCalledWith('web-app: could not open the default browser because launcher unavailable; use the dsh web URL printed at startup')
  expect(error.mock.calls.flat().join(' ')).not.toContain(new URL(auth.authenticatedUrl('http://localhost')).searchParams.get('token'))
})


it('prints all contributed entries and opens only the first eligible entry', async () => {
  const { ctx, baseUrl, removeEntry, log, open } = await setup()
  removeEntry()
  ctx.on('webserver/entry-url', (base, entries) => {
    expect(base).toBe(baseUrl())
    entries.push({ label: 'dsh remote', url: 'https://remote.test/invite', displayUrl: 'https://remote.test/invite', open: false })
  })
  ctx.on('webserver/entry-url', (_base, entries) => {
    entries.push({ label: 'dsh web', url: 'https://web.test/?token=first', displayUrl: 'https://web.test/', open: true })
    entries.push({ label: 'dsh other', url: 'https://other.test/', displayUrl: 'https://other.test/', open: true })
  })
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  expect(log.mock.calls.map(call => String(call[0]))).toEqual([
    'dsh remote: https://remote.test/invite',
    'dsh web: https://web.test/?token=first',
    'dsh other: https://other.test/',
    'dsh web: opening https://web.test/ in the default browser; pass --no-open to disable',
  ])
  expect(open).toHaveBeenCalledOnce()
  expect(open).toHaveBeenCalledWith('https://web.test/?token=first', expect.any(AbortSignal))
})

it.each([
  { tty: false, handoff: false, expected: ['dsh web: login URL written to /run/web-1.url'] },
  { tty: true, handoff: false, expected: ['dsh web: http://127.0.0.1:3080/?token=fixture-token'] },
  { tty: true, handoff: true, expected: ['dsh web: opening http://127.0.0.1:3080/ in the default browser; pass --no-open to disable'] },
  { tty: false, handoff: true, expected: ['dsh web: opening http://127.0.0.1:3080/ in the default browser; pass --no-open to disable', 'dsh web: login URL written to /run/web-1.url'] },
] as const)('auto mode prints or stores the login URL without leaking it into stdout (tty=$tty handoff=$handoff)', async ({ tty, handoff, expected }) => {
  const { ctx, baseUrl, log, written } = await setup()
  if (tty) Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
  publishStartup(ctx, { printUrl: 'auto', openBrowser: handoff }, baseUrl)
  await vi.waitFor(() => { expect(log.mock.calls.map(call => String(call[0]))).toEqual([...expected]) })
  const output = log.mock.calls.flat().map(String).join('\n')
  if (tty && !handoff) expect(output).toContain('token=fixture-token')
  else expect(output).not.toContain('token=')
  expect(written).toHaveBeenCalledTimes(tty ? 0 : 1)
  if (tty) expect(written).not.toHaveBeenCalled()
})

it('removes its run file when the runtime is disposed', async () => {
  const { ctx, baseUrl, removeEntry, removed, written } = await setup()
  removeEntry()
  ctx.on('webserver/entry-url', (_base, entries) => {
    entries.push({ label: 'dsh web', url: 'http://127.0.0.1:3080/?token=fixture-token', displayUrl: 'http://127.0.0.1:3080/', open: true })
  })
  const plugin = ctx.plugin({ apply(scope: Context) { publishStartup(scope, { printUrl: 'auto', openBrowser: false }, baseUrl) } })
  await plugin.await()
  await vi.waitFor(() => { expect(written).toHaveBeenCalledOnce() })
  expect(removed).not.toHaveBeenCalled()
  await plugin.dispose()
  expect(removed).toHaveBeenCalledExactlyOnceWith('/run/web-1.url')
})

it.each(['absent', 'not-openable'] as const)('does not invent a browser URL when entries are %s', async (mode) => {
  const { ctx, baseUrl, removeEntry, log, open } = await setup()
  removeEntry()
  if (mode === 'not-openable') {
    ctx.on('webserver/entry-url', (_base, entries) => {
      entries.push({ label: 'dsh remote', url: 'https://remote.test/invite', displayUrl: 'https://remote.test/invite', open: false })
    })
  }
  publishStartup(ctx, { printUrl: 'always', openBrowser: true }, baseUrl)
  expect(log).toHaveBeenCalledTimes(mode === 'absent' ? 0 : 1)
  expect(open).not.toHaveBeenCalled()
})

it('writes the login URL to a private run file and removes it on cleanup', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-web-url-file-'))
  vi.stubEnv('DSH_HOME', home)
  try {
    const entries: WebEntryUrl[] = [{
      label: 'dsh web',
      url: 'http://127.0.0.1:3080/?token=fixture-token',
      displayUrl: 'http://127.0.0.1:3080/',
      open: true,
    }]
    const file = await internals.loginUrlFile(entries)
    expect(file).toBe(join(home, 'run', `web-${String(process.pid)}.url`))
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect((await stat(dirname(file))).mode & 0o777).toBe(0o700)
    expect(await readFile(file, 'utf8')).toBe('dsh web: http://127.0.0.1:3080/?token=fixture-token\n')
    await internals.removeLoginUrlFile(file)
    await expect(stat(file)).rejects.toThrow()
  } finally {
    vi.unstubAllEnvs()
    await rm(home, { recursive: true, force: true })
  }
})
