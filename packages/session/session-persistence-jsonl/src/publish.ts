/**
 * Publish a staged session log under its final name without replacing an existing log.
 *
 * The shared exclusive-publication primitive prefers a hard link, then a zero-copy
 * `renameat2(RENAME_NOREPLACE)`, then an exclusive flushed copy; Android app data reaches the
 * copy path because SELinux refuses hard links there. A session log stays owner-only on every
 * path, so the copy mode is fixed instead of inheriting the staged file's mode.
 */
import { publishExclusive as publishFileExclusive } from '@deepseek-ai/dsh-util-exclusive-publish'

/**
 * Publish `source` at `destination`, failing with EEXIST if it already exists.
 * @param source - staged log file whose bytes are already durable.
 * @param destination - final log path that must not exist yet.
 * @returns a promise that resolves once `destination` names the candidate bytes and, on the copy
 *   path, those bytes are flushed. The caller fsyncs the parent directory.
 */
export async function publishExclusive(source: string, destination: string): Promise<void> {
  await publishFileExclusive(source, destination, { mode: 0o600 })
}
