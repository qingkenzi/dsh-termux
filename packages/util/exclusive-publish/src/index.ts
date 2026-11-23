/**
 * Exclusive publication of a staged file under a name that must not already exist.
 *
 * Publication tries two capabilities in order and reports which one produced the target:
 * `link(2)` keeps the staged inode and publishes it under a second name; a host that refuses hard
 * links (Android app data under SELinux answers EACCES) falls back to
 * `copyFile(..., COPYFILE_EXCL)`, which creates a new inode. Both fail with EEXIST when the
 * target exists, so a concurrent creator keeps its file and this call loses the race.
 *
 * The copy path is not atomic for readers: another process can observe the target while its bytes
 * are still being written. It therefore applies the requested mode, flushes the new inode, and
 * removes the copy when that flush fails. The directory entry is the caller's to fsync.
 *
 * `publishExclusiveSync` runs the same two paths on the synchronous primitives, for callers that
 * cannot await.
 * @module @deepseek-ai/dsh-util-exclusive-publish
 */

import {
  chmodSync, closeSync, constants, copyFileSync, fsyncSync, linkSync, openSync, rmSync,
} from 'node:fs'
import { chmod, copyFile, link, open, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'

/** How a successful publication created the target name. */
export type PublishMethod = 'linked' | 'copied'

/** Filesystem errors that mean hard links are unsupported, not a name collision. */
const LINK_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'ENOSYS', 'EOPNOTSUPP', 'ENOTSUP'])
/** Marks a copy whose bytes were already flushed when its descriptor failed to close. */
const FLUSHED_COPY = Symbol('dsh-exclusive-publish-flushed-copy')

/** Injection seams for tests and for callers that own an equivalent primitive. */
export interface PublishExclusiveOptions {
  /** POSIX mode for a copied target; omission keeps the mode the copy primitive gives it. */
  mode?: number
  /**
   * Exclusive copy primitive; defaults to `copyFile(source, target, COPYFILE_EXCL)`.
   * It must create the target and reject with `EEXIST` rather than overwrite an existing one.
   */
  exclusive?: (source: string, target: string) => Promise<void>
  /** Hard-link primitive; defaults to `link(2)`. */
  link?: (source: string, target: string) => Promise<void>
  /**
   * Flush a copied target; defaults to opening the copy and fsyncing its inode.
   * A rejection discards the copy unless the default flush already completed that step.
   */
  fsync?: (target: string) => Promise<void>
}

/** Injection seams for the synchronous publication; each seam mirrors its asynchronous counterpart. */
export interface PublishExclusiveSyncOptions {
  /** POSIX mode for a copied target; omission keeps the mode the copy primitive gives it. */
  mode?: number
  /**
   * Exclusive copy primitive; defaults to `copyFileSync(source, target, COPYFILE_EXCL)`.
   * It must create the target and throw `EEXIST` rather than overwrite an existing one.
   */
  exclusive?: (source: string, target: string) => void
  /** Hard-link primitive; defaults to `linkSync`. */
  link?: (source: string, target: string) => void
  /**
   * Flush a copied target; defaults to opening the copy and fsyncing its inode.
   * A throw discards the copy unless the default flush already completed that step.
   */
  fsync?: (target: string) => void
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code
}

function isLinkUnsupported(error: unknown): boolean {
  const code = errnoCode(error)
  return code !== undefined && LINK_UNSUPPORTED.has(code)
}

/** Attach the refusal that forced a fallback without replacing an existing cause. */
function withRefusal(error: unknown, refusal: unknown): unknown {
  if (error instanceof Error && error.cause === undefined) Object.assign(error, { cause: refusal })
  return error
}

/** Remove one failed or unflushed copy, keeping the failure that ended the publication. */
async function removeCopyAndThrow(target: string, failure: unknown): Promise<never> {
  try {
    await rm(target, { force: true })
  } catch (cleanupFailure: unknown) {
    throw new AggregateError([failure, cleanupFailure], `failed to remove unpublished copy "${target}"`)
  }
  throw failure
}

function markFlushed(error: unknown): void {
  if (error instanceof Error) Object.assign(error, { [FLUSHED_COPY]: true })
}

function wasFlushed(error: unknown): boolean {
  return typeof error === 'object' && error !== null && FLUSHED_COPY in error
}

/**
 * Flush a freshly copied inode. A read-only copy is flushed through a read-only descriptor,
 * which POSIX permits; a close failure after a successful sync keeps the durable copy and is
 * marked so the caller does not discard it.
 * @param target - copied file whose bytes must reach the filesystem.
 */
async function flushCopiedFile(target: string): Promise<void> {
  let handle: FileHandle
  try {
    handle = await open(target, 'r+')
  } catch (error: unknown) {
    // A published object can be read-only (mode 0400), and fsync needs no write access.
    if (errnoCode(error) !== 'EACCES') throw error
    handle = await open(target, 'r')
  }
  let syncFailure: unknown
  try {
    await handle.sync()
  } catch (error: unknown) {
    syncFailure = error
  }
  try {
    await handle.close()
  } catch (error: unknown) {
    if (syncFailure === undefined) {
      markFlushed(error)
      throw error
    }
  }
  if (syncFailure !== undefined) throw syncFailure
}

/**
 * Copy one staged file to a new inode, apply the requested mode, and flush it.
 * @param source - staged file whose bytes are already durable.
 * @param target - target path that must not exist yet.
 * @param options - Mode, exclusive copy, and flush overrides.
 */
async function copyExclusiveDurable(
  source: string,
  target: string,
  options: PublishExclusiveOptions,
): Promise<void> {
  const copyExclusive = options.exclusive
    ?? ((from: string, to: string) => copyFile(from, to, constants.COPYFILE_EXCL))
  try {
    await copyExclusive(source, target)
  } catch (error: unknown) {
    // With COPYFILE_EXCL, EEXIST means the copy never touched the winner's file.
    if (errnoCode(error) === 'EEXIST') throw error
    await removeCopyAndThrow(target, error)
  }
  try {
    if (options.mode !== undefined) await chmod(target, options.mode)
    await (options.fsync ?? flushCopiedFile)(target)
  } catch (error: unknown) {
    if (wasFlushed(error)) throw error
    await removeCopyAndThrow(target, error)
  }
}

/**
 * Publish `source` at `target`, failing with EEXIST when `target` already exists.
 *
 * A link keeps `source`; a copy leaves it in place. The caller owns the parent directory's fsync
 * and may remove `source` once the call succeeds in every case.
 * @param source - staged file to publish; its own bytes are already durable.
 * @param target - target path that must not exist yet.
 * @param options - Injection seams and the copy mode.
 * @returns How the target name was created.
 * @throws The refusing capability's errno: EEXIST when another writer won, and the copy or flush
 *   failure when the copy path cannot publish durable bytes. A copy failure carries the refused
 *   hard-link error as its cause.
 */
export async function publishExclusive(
  source: string,
  target: string,
  options: PublishExclusiveOptions = {},
): Promise<PublishMethod> {
  let refusal: unknown
  try {
    await (options.link ?? link)(source, target)
    return 'linked'
  } catch (error: unknown) {
    if (!isLinkUnsupported(error)) throw error
    refusal = error
  }
  try {
    await copyExclusiveDurable(source, target, options)
    return 'copied'
  } catch (error: unknown) {
    throw withRefusal(error, refusal)
  }
}

/** Remove one failed or unflushed copy, keeping the failure that ended the publication. */
function removeCopyAndThrowSync(target: string, failure: unknown): never {
  try {
    rmSync(target, { force: true })
  } catch (cleanupFailure: unknown) {
    throw new AggregateError([failure, cleanupFailure], `failed to remove unpublished copy "${target}"`)
  }
  throw failure
}

/**
 * Open a freshly copied inode for its flush. A read-only copy is opened read-only, which POSIX
 * permits, because fsync needs no write access.
 * @param target - copied file whose bytes must reach the filesystem.
 * @returns Descriptor to fsync and close.
 */
function openCopiedFileSync(target: string): number {
  try {
    return openSync(target, 'r+')
  } catch (error: unknown) {
    // A published object can be read-only (mode 0400), and fsync needs no write access.
    if (errnoCode(error) !== 'EACCES') throw error
    return openSync(target, 'r')
  }
}

/**
 * Flush a freshly copied inode. A close failure after a successful sync keeps the durable copy and
 * is marked so the caller does not discard it.
 * @param target - copied file whose bytes must reach the filesystem.
 */
function flushCopiedFileSync(target: string): void {
  const descriptor = openCopiedFileSync(target)
  let syncFailure: unknown
  try {
    fsyncSync(descriptor)
  } catch (error: unknown) {
    syncFailure = error
  }
  try {
    closeSync(descriptor)
  } catch (error: unknown) {
    if (syncFailure === undefined) {
      markFlushed(error)
      throw error
    }
  }
  if (syncFailure !== undefined) throw syncFailure
}

/**
 * Copy one staged file to a new inode, apply the requested mode, and flush it.
 * @param source - staged file whose bytes are already durable.
 * @param target - target path that must not exist yet.
 * @param options - Mode, exclusive copy, and flush overrides.
 */
function copyExclusiveDurableSync(
  source: string,
  target: string,
  options: PublishExclusiveSyncOptions,
): void {
  const copyExclusive = options.exclusive
    ?? ((from: string, to: string) => copyFileSync(from, to, constants.COPYFILE_EXCL))
  try {
    copyExclusive(source, target)
  } catch (error: unknown) {
    // With COPYFILE_EXCL, EEXIST means the copy never touched the winner's file.
    if (errnoCode(error) === 'EEXIST') throw error
    removeCopyAndThrowSync(target, error)
  }
  const flush = options.fsync ?? flushCopiedFileSync
  try {
    if (options.mode !== undefined) chmodSync(target, options.mode)
    flush(target)
  } catch (error: unknown) {
    if (wasFlushed(error)) throw error
    removeCopyAndThrowSync(target, error)
  }
}

/**
 * Publish `source` at `target` from synchronous code, failing with EEXIST when `target` already
 * exists.
 *
 * A link keeps `source`; a copy leaves it in place. The caller owns the parent directory's fsync
 * and may remove `source` once the call succeeds in every case.
 * @param source - staged file to publish; its own bytes are already durable.
 * @param target - target path that must not exist yet.
 * @param options - Injection seams and the copy mode.
 * @returns How the target name was created.
 * @throws The refusing capability's errno: EEXIST when another writer won, and the copy or flush
 *   failure when the copy path cannot publish durable bytes. A copy failure carries the refused
 *   hard-link error as its cause.
 */
export function publishExclusiveSync(
  source: string,
  target: string,
  options: PublishExclusiveSyncOptions = {},
): PublishMethod {
  let refusal: unknown
  const publishLink = options.link ?? linkSync
  try {
    publishLink(source, target)
    return 'linked'
  } catch (error: unknown) {
    if (!isLinkUnsupported(error)) throw error
    refusal = error
  }
  try {
    copyExclusiveDurableSync(source, target, options)
    return 'copied'
  } catch (error: unknown) {
    throw withRefusal(error, refusal)
  }
}
