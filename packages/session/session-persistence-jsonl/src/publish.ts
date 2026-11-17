/**
 * Exclusive "publish if absent" helper.
 *
 * POSIX filesystems publish a staged file with link()+unlink() so a concurrent
 * writer materializing the same target fails with EEXIST rather than silently
 * overwriting. Some hosts reject hard links with EACCES/EPERM/ENOSYS/EOPNOTSUPP
 * (Android app data under SELinux is one). On those, fall back to
 * copyFile(..., COPYFILE_EXCL), which keeps the same create-if-absent contract:
 * it fails with EEXIST when the destination already exists.
 *
 * The copy path creates a fresh inode, so it must flush that inode's bytes
 * before returning. Callers fsync only the parent directory, which makes the
 * directory entry durable but not the copied contents; without this flush a
 * power loss can leave a published-but-empty session log. copyFile promises no
 * particular destination mode, so the copy path also forces 0600 before that
 * flush: a session log must stay owner-only whatever the source mode or umask.
 */
import { chmod, copyFile, link, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'

/** Filesystem errors that mean hard links are unsupported, not a name collision. */
function isLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOSYS' ||
    code === 'EOPNOTSUPP' || code === 'ENOTSUP'
}

/**
 * Copy one staged file to a new inode, force owner-only mode, and flush it,
 * removing the copy when the flush fails so an unsynced publication never
 * outlives the failed call.
 * @param source - staged file whose bytes are already durable.
 * @param destination - target path that must not exist yet; a copy is published with mode 0600.
 */
async function copyExclusiveDurable(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  // copyFile may inherit the source mode (a read-only staged file stays 0400)
  // or the creation umask; either must not decide a session log's mode.
  await chmod(destination, 0o600)
  let handle: FileHandle
  try {
    handle = await open(destination, 'r+')
  } catch (failure: unknown) {
    // A flush needs no write access: POSIX allows fsync on a read-only
    // descriptor. Fall back instead of deleting a copy that copyFile already
    // created and whose bytes can still be made durable.
    if ((failure as NodeJS.ErrnoException | null)?.code !== 'EACCES') throw failure
    handle = await open(destination, 'r')
  }
  let syncFailure: unknown
  try {
    await handle.sync()
  } catch (failure: unknown) {
    syncFailure = failure
  }
  try {
    await handle.close()
  } catch (failure: unknown) {
    // A flushed copy is published and must survive a close failure; after a
    // sync failure the copy is removed below and the sync failure is reported.
    if (syncFailure === undefined) throw failure
  }
  if (syncFailure === undefined) return
  try {
    await rm(destination, { force: true })
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [syncFailure, cleanupFailure],
      `failed to remove unsynced publication "${destination}"`,
    )
  }
  throw syncFailure
}

/**
 * Publish `source` at `destination`, failing with EEXIST if it already exists.
 * Prefers link(); degrades to copyFile with COPYFILE_EXCL when the filesystem
 * cannot create hard links. Both paths require `source` and `destination` to be
 * on the same filesystem. The copy path keeps the exclusive create-if-absent
 * contract but is not atomic for readers: another process may observe
 * `destination` while its bytes are still being written.
 * @param source - staged file to publish; its bytes are already durable.
 * @param destination - target path that must not exist yet.
 * @returns a promise that resolves once `destination` names the candidate
 *   bytes and, on the copy path, those bytes are flushed. The directory entry
 *   is not yet durable: the caller fsyncs the parent directory. Rejects with
 *   the fallback copy's failure — EEXIST when another writer won — carrying
 *   the refused link error as its cause.
 */
export async function publishExclusive(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination)
    return
  } catch (error: unknown) {
    if (!isLinkUnsupported(error)) throw error
    try {
      await copyExclusiveDurable(source, destination)
    } catch (copyFailure: unknown) {
      // Keep the refusal that forced the fallback while leaving the copy's own
      // code (EEXIST for a lost race) as the caller's answer.
      if (copyFailure instanceof Error) Object.assign(copyFailure, { cause: error })
      throw copyFailure
    }
  }
}
