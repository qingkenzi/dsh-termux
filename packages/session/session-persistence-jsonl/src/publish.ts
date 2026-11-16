/**
 * Exclusive "publish if absent" helper.
 *
 * POSIX filesystems publish a staged file with link()+unlink() so a concurrent
 * writer materializing the same target fails with EEXIST rather than silently
 * overwriting. Some filesystems (notably Termux/Android's /data) reject hard
 * links with EACCES/EPERM/ENOSYS/EOPNOTSUPP. On those, fall back to
 * copyFile(..., COPYFILE_EXCL), which keeps the same create-if-absent contract:
 * it fails with EEXIST when the destination already exists.
 */
import { copyFile, link } from 'node:fs/promises'
import { constants } from 'node:fs'

/** Filesystem errors that mean hard links are unsupported, not a name collision. */
function isLinkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'EACCES' || code === 'EPERM' || code === 'ENOSYS' ||
    code === 'EOPNOTSUPP' || code === 'ENOTSUP'
}

/**
 * Atomically publish `source` at `destination`, failing with EEXIST if it
 * already exists. Prefers link(); degrades to copyFile with COPYFILE_EXCL when
 * the filesystem cannot create hard links.
 */
export async function publishExclusive(source: string, destination: string): Promise<void> {
  try {
    await link(source, destination)
  } catch (error: unknown) {
    if (!isLinkUnsupported(error)) throw error
    await copyFile(source, destination, constants.COPYFILE_EXCL)
  }
}
