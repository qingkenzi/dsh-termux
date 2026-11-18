/** Read the reachable Web URL from a launcher's stdout. */

import { readFileSync } from 'node:fs'

/**
 * Read the reachable Web URL from launcher stdout. The launcher either prints it
 * inside the browser-handoff line or writes a private login URL file and names
 * that file on stdout; a non-terminal run with `--no-open` takes the file path.
 * @param output - launcher stdout captured so far, or one complete line of it.
 * @returns the advertised URL, or undefined before the launcher announces it.
 */
export function loginUrlFromFile(output: string): string | undefined {
  const path = /dsh web: login URL written to (.+)$/mu.exec(output)?.[1]
  if (path === undefined) return undefined
  try {
    const line = readFileSync(path.trim(), 'utf8').split('\n')[0] ?? ''
    const separator = line.indexOf(': ')
    return separator < 0 ? undefined : line.slice(separator + 2)
  } catch (error: unknown) {
    // The owning process may remove the run file while it shuts down; readiness
    // is announced before that, so a vanished file is not a URL.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * The URL the launcher advertised for a browser hand-off; it omits the login
 * token that {@link loginUrlFromFile} returns.
 * @param output - launcher stdout captured so far.
 * @returns the hand-off URL, or undefined before the launcher announces it.
 */
export function announcedHandoffUrl(output: string): string | undefined {
  return /dsh web: opening (http:\/\/[^\s]+)/u.exec(output)?.[1]
}

/**
 * Read the reachable Web URL for readiness checks: the tokenized run-file URL
 * when the launcher wrote one, otherwise the hand-off URL.
 * @param output - launcher stdout captured so far, or one complete line of it.
 * @returns the advertised URL, or undefined before the launcher announces it.
 */
export function announcedWebUrl(output: string): string | undefined {
  return loginUrlFromFile(output) ?? announcedHandoffUrl(output)
}
