/**
 * Session publication policy: the shared exclusive-publication primitive runs with an owner-only
 * copy mode, so a session log never inherits a wider mode from its staged file or the process umask.
 * The primitive's own paths are covered in `@deepseek-ai/dsh-util-exclusive-publish`.
 */

import { describe, expect, it, vi } from 'vitest'
import { publishExclusive } from '../src/publish.ts'

const shared = vi.hoisted(() => ({ publishExclusive: vi.fn(async () => 'linked' as const) }))

vi.mock('@deepseek-ai/dsh-util-exclusive-publish', () => shared)

describe('publishExclusive', () => {
  it('publishes through the shared primitive with an owner-only copy mode', async () => {
    await publishExclusive('/root/staged.jsonl', '/root/session.v4.jsonl')

    expect(shared.publishExclusive).toHaveBeenCalledWith('/root/staged.jsonl', '/root/session.v4.jsonl', { mode: 0o600 })
  })

  it('propagates the shared publication failure', async () => {
    const failure = Object.assign(new Error('target exists'), { code: 'EEXIST' })
    shared.publishExclusive.mockRejectedValueOnce(failure)

    await expect(publishExclusive('/root/staged.jsonl', '/root/session.v4.jsonl')).rejects.toBe(failure)
  })
})
