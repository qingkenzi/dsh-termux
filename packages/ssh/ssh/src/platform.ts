/** Host admission shared by the OpenSSH runtime, its installed helper and handshake validation. */

/**
 * Whether a host provides the POSIX process, filesystem and shell facilities this package requires.
 * Android runs the same POSIX userland under Termux, so it belongs with Linux and macOS.
 * @param platform - a `process.platform` value.
 * @returns whether that platform is an admitted POSIX host.
 */
export function isPosixPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin' || platform === 'android'
}
