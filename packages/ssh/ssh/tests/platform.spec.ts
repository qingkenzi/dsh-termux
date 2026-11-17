/** POSIX host admission shared by the SSH runtime, its installed helper and handshake validation. */
import { describe, expect, it } from 'vitest'
import { isPosixPlatform } from '../src/platform.ts'
import { helloSchema } from '../src/schemas.ts'

const hello = {
  protocol: 3, hash: 'a'.repeat(64), kind: 'node-script' as const, nodeVersion: 'v24.19.0',
  executable: '/usr/bin/node', root: '/tmp/dsh-ssh-1', workspace: '/workspace',
}

describe('SSH POSIX platform admission', () => {
  it.each(['linux', 'darwin', 'android'] as const)('admits %s hosts', (platform) => {
    expect(isPosixPlatform(platform)).toBe(true)
  })

  it('rejects non-POSIX hosts', () => {
    expect(isPosixPlatform('win32')).toBe(false)
  })

  it('accepts an Android helper handshake and keeps unsupported platforms outside the wire schema', () => {
    expect(helloSchema.parse({ ...hello, platform: 'android' }).platform).toBe('android')
    expect(helloSchema.safeParse({ ...hello, platform: 'win32' }).success).toBe(false)
  })
})
