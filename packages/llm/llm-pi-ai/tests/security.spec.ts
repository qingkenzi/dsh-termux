import { describe, expect, it } from 'vitest'
import { INSECURE_BASE_URL_CODE, LlmError } from '@deepseek-ai/dsh-llm'
import { assertSecureBaseURL } from '../src/security.ts'

describe('provider endpoint transport', () => {
  it('accepts HTTPS and plain HTTP to this machine', () => {
    for (const baseURL of [
      'https://gateway.example/v1',
      'http://127.0.0.1:8000/v1',
      'http://127.4.3.2:8000',
      'http://localhost:8000/v1',
      'http://[::1]:8000/v1',
    ]) {
      expect(() => { assertSecureBaseURL('acme', baseURL, false) }).not.toThrow()
    }
    expect(() => { assertSecureBaseURL('acme', undefined, false) }).not.toThrow()
  })

  it('refuses plain HTTP to a public host unless the route opts in', () => {
    const refused = (): void => { assertSecureBaseURL('acme', 'http://gateway.example/v1', false) }
    expect(refused).toThrow(LlmError)
    try {
      refused()
    } catch (error) {
      expect(error).toMatchObject({ code: INSECURE_BASE_URL_CODE })
      expect((error as Error).message).toContain('https://')
      expect((error as Error).message).toContain('ssh -N -L')
      expect((error as Error).message).toContain('allowInsecureHttp: true')
    }
    expect(() => { assertSecureBaseURL('acme', 'http://gateway.example/v1', true) }).not.toThrow()
  })

  it('rejects a value that is not an absolute http(s) URL', () => {
    for (const baseURL of ['gateway.example/v1', 'ftp://gateway.example/v1']) {
      expect(() => { assertSecureBaseURL('acme', baseURL, false) }).toThrow(LlmError)
      expect(() => { assertSecureBaseURL('acme', baseURL, true) }).toThrow(LlmError)
    }
  })
})
