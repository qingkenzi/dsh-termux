/**
 * Whether the provider's shared runtime directory can exist on this host.
 *
 * The transport owns `/tmp/dsh-cua-<uid>` and names every socket in it after the 64-character
 * runtime key, so a fixture that connects through it needs a writable `/tmp` whose absolute
 * paths fit `sockaddr_un` (108 bytes). Termux/Android has no writable `/tmp`, and its own
 * temporary directory is long enough that the socket name no longer fits.
 */
import { accessSync, constants } from 'node:fs'

/** True when `/tmp` is a writable directory for the current user. */
export const runtimeDirectoryAvailable: boolean = (() => {
  try {
    accessSync('/tmp', constants.W_OK)
    return true
  } catch {
    return false
  }
})()
