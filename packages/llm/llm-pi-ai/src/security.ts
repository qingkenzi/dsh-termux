/**
 * Provider-endpoint transport validation shared by profile resolution,
 * model discovery, and request dispatch.
 *
 * A provider request carries the API key, the conversation, and tool output.
 * Plain HTTP to anything but this machine exposes all three to every hop in
 * between, so an endpoint is accepted only over TLS, or over plain HTTP to a
 * loopback address the operator deliberately tunnelled.
 * @module dsh-llm-pi-ai/security
 */

import { LlmError } from '@deepseek-ai/dsh-llm'
import { INSECURE_BASE_URL_CODE } from '@deepseek-ai/dsh-llm/src/security-code.ts'

/** Hosts that name this machine without leaving it: `localhost`, 127/8, and `::1`. */
const LOOPBACK_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\])$/i

/**
 * Refuse an endpoint that would send provider traffic over untrusted transport.
 * @param provider - route key or draft label used in the diagnostic.
 * @param baseURL - configured or effective endpoint; `undefined` defers to the
 *   installed catalog, whose own endpoints are trusted as shipped.
 * @param allowInsecureHttp - whether this route explicitly accepts plain HTTP
 *   to a non-loopback host.
 * @returns nothing when the endpoint is safe to use.
 * @throws LlmError `INSECURE_BASE_URL` for plain HTTP off this machine;
 *   LlmError `INVALID_CONFIG` when the value is not an absolute HTTP(S) URL.
 */
export function assertSecureBaseURL(
  provider: string,
  baseURL: string | undefined,
  allowInsecureHttp: boolean,
): void {
  if (baseURL === undefined) return
  let url: URL
  try {
    url = new URL(baseURL)
  } catch {
    throw new LlmError(
      `llm-pi-ai: provider "${provider}" baseURL ${JSON.stringify(baseURL)} is not an absolute http(s) URL`,
      'INVALID_CONFIG',
    )
  }
  if (url.protocol === 'https:') return
  if (url.protocol !== 'http:') {
    throw new LlmError(
      `llm-pi-ai: provider "${provider}" baseURL must use http(s), not ${JSON.stringify(url.protocol)}`,
      'INVALID_CONFIG',
    )
  }
  if (LOOPBACK_HOST.test(url.hostname) || allowInsecureHttp) return
  throw new LlmError(
    `llm-pi-ai: provider "${provider}" baseURL ${JSON.stringify(baseURL)} is plain HTTP to a non-loopback host,`
    + ' so API keys, prompts, and tool output would cross the network in clear text.'
    + ` Serve the endpoint over https://, reach it through an SSH tunnel and point baseURL at the local end`
    + ` (for example ssh -N -L 8080:${url.hostname}:8000 user@server, then baseURL http://127.0.0.1:8080/v1),`
    + ' or set allowInsecureHttp: true on this provider to accept cleartext to this exact endpoint.',
    INSECURE_BASE_URL_CODE,
  )
}
