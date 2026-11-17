/**
 * Exclusive "publish if absent" for one immutable attachment object.
 *
 * link(2) publishes a staged file under its content-addressed name: either the
 * name appears carrying the complete object, or the call fails with EEXIST, so a
 * concurrent writer can never replace an object another reader already resolved.
 * Some hosts refuse hard links outright (Android app data under SELinux answers
 * EACCES). There, copyFile(..., COPYFILE_EXCL) keeps the create-if-absent
 * contract and still reports a lost race as EEXIST.
 *
 * The copy is a new inode, so it must be flushed before returning: callers fsync
 * the parent directory only, which makes the name durable but not the bytes. A
 * published object is mode 0400 and the copy inherits that mode, so the flush
 * falls back to a read-only descriptor, which fsync accepts.
 */
import { constants } from 'node:fs'
import { copyFile, link, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

/** Filesystem errors that mean hard links are unsupported, not a name collision. */
function isLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOSYS' ||
    code === 'EOPNOTSUPP' || code === 'ENOTSUP'
}

/**
 * Remove a copy that cannot be proven durable, keeping the error that ended the
 * publication as the reported one.
 * @param destination - copied object to discard.
 * @param failure - error that ends the publication; reported when removal succeeds.
 * @returns never; the promise always rejects.
 */
async function removeUnflushedCopy(destination: string, failure: unknown): Promise<never> {
  try {
    await rm(destination, { force: true })
  } catch (cleanupFailure: unknown) {
    throw new AggregateError(
      [failure, cleanupFailure],
      `failed to remove unflushed publication "${destination}"`,
    )
  }
  throw failure
}

/**
 * Open a copied object for its flush, discarding the copy when no descriptor
 * can be opened for it.
 * @param destination - copied object that must be flushed.
 * @returns descriptor whose bytes can be synced.
 */
async function openCopiedFile(destination: string): Promise<FileHandle> {
  try {
    return await open(destination, 'r+')
  } catch {
    try {
      return await open(destination, 'r')
    } catch (readOnlyFailure: unknown) {
      return await removeUnflushedCopy(destination, readOnlyFailure)
    }
  }
}

/**
 * Copy one staged file to a new inode and flush it, removing the copy when the
 * flush fails so an unsynced publication never outlives the failed call.
 * @param source - staged file whose bytes are already durable.
 * @param destination - target path that must not exist yet.
 */
async function copyExclusiveDurable(source: string, destination: string): Promise<void> {
  await copyFile(source, destination, constants.COPYFILE_EXCL)
  const handle = await openCopiedFile(destination)
  let syncFailure: unknown
  try {
    await handle.sync()
  } catch (failure: unknown) {
    syncFailure = failure
  }
  try {
    await handle.close()
  } catch (closeFailure: unknown) {
    // A flushed copy is published and must survive a close failure; after a
    // sync failure the copy is removed below and the sync failure is reported.
    if (syncFailure === undefined) throw closeFailure
  }
  if (syncFailure === undefined) return
  return await removeUnflushedCopy(destination, syncFailure)
}

/**
 * Publish `source` at `destination` only when the destination is absent, and
 * only once the published bytes are durable.
 * @param source - staged file to publish; its own bytes are already durable.
 * @param destination - target path that must not exist yet.
 * @returns a promise that resolves once the published entry and its bytes are durable.
 * @throws The failure of the copy fallback when the filesystem refuses hard
 *   links: EEXIST when another writer won, carrying the refused link error as
 *   its cause.
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
