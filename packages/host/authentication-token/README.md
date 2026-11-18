---
description: "Sign in through the default launch token and retain browser access through authority-bound Cookies."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-authentication-token

English | [中文](README.zh.md)

## Summary

Open the tokenized launch URL to sign a browser Cookie, then continue accessing the application with that Cookie. API clients exchange the same process token through `/connect` for their connection credential. The launch token is a ten-minute, single-use capability; Cookies are signed with a process-memory secret, so restarting the process revokes every browser session. The plugin registers through the common ConnectionAuthentication service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this function plugin beside Connection and Credentials. It also injects `connection.authentication`, which the Connection plugin provides. A WebServer adds HTTP exchange routes; the authentication provider also works in compositions without a Web listener. The plugin contributes a signed `dsh web` entry through `webserver/entry-url`; WebApp owns printing and browser opening. The package's runtime entry exports `name`, `inject`, `Config`, and `apply`. `Config` accepts no fields: the ten-minute launch-token lifetime and the one-day Cookie lifetime are security invariants, not deployment settings.

Configure `printUrl` and `openBrowser` on the WebApp runtime, not this plugin. Authentication remains available without startup publication.

A root request carrying the launch-token query is handled by the original token exchange: successful `GET /` returns 303 with a Cookie and redirects to `./`; invalid credentials return 401. Requests on other paths continue to their route owner. When WebApp collects entries after readiness, this plugin appends its process token to the supplied base URL while preserving its authority, path, and other query fields. The contributed entry is eligible for automatic opening. Token neither reads WebApp services nor owns printing, readiness, or the native browser opener.

Browser v3 Cookies authenticate to one shared Peer owned by this plugin. `/connect` declares anonymous route admission: Connection checks the source, then the handler verifies the launch token, creates an API Peer, and signs its ID in a v3 Cookie. A v3 Cookie without an operator ID authenticates pages, and one carrying an ID authenticates API requests through the same Provider. The Peer's principal and RemoteAccess determine permissions; there is no page/API purpose level. The index exchange and `/connect` each spend their launch token once; replay returns 401. Token permits one `/api/remote.mux` Socket per API Peer: duplicate attachment returns 409 without revoking the first connection. Closing that Socket revokes the credential synchronously, then disposes the Peer; later requests using that Cookie are refused. Other upgrade routes, including Inspector CDP, neither claim the Peer nor revoke it on closure.

Cookies are signed by a random 32-byte secret held in process memory per root Context; no credential record is written or read. The Cookie name binds the signing input to the request authority, the payload carries issued and absolute expiry times for one day, and the receiving listener decides whether `Secure` is present. At startup the plugin deletes the retired `client-connection/browser-session` grant record when one exists, warns, and leaves every other credential record untouched; Cookies minted under that retired secret are refused. Reloading the plugin keeps this process's launch token and signing secret, while a restart replaces both. Same-origin `POST /_dsh/auth/refresh` renews the current browser Cookie up to the day after first login: it requires a matching `Origin`, a `Sec-Fetch-Site` of `same-origin` or `none` when present, and an unexpired browser Cookie. Token activation failure may leave the application running without this verifier; it does not permit unauthenticated access to protected routes. Desktop can mount this Provider alongside its private-credential Provider.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The plugin reads or removes the retired browser-session record, derives one process state (launch token plus HMAC secret) from the root Context, creates a shared Peer through Connection, and registers through `ctx.connection.authentication` a verifier returning that Peer for a browser v3 Cookie or resolving a verified operator ID through its own API Peer map. It uses the same verification for pages and API calls. Its WebServer request listener owns root token exchange, while anonymous exact routes own `/connect` and `/_dsh/auth/refresh`.

Beside that route, a `webserver/upgrade` listener delegates non-mux paths and recognizes owned API Peers on `/api/remote.mux` by `apiPeers.get(peer.id) === peer`; shared browser Peers and other Providers delegate with `next()`. This listener runs after route admission and before protocol handling. Socket close, error, and upgrade failure revoke the API credential before asynchronous disposal. Peer disposal also closes its Socket. Cleanup is idempotent; the Web integration scope removes its listeners, revokes its API credentials, destroys only its owned API Sockets, and awaits Socket closure and Peer cleanup. Late middleware cannot restore a revoked Peer. A synchronous `webserver/entry-url` listener contributes the signed URL; its event and entry type are declared by WebServer, without a dependency on the WebApp bundle.

The launch-token lifetime, Cookie algorithms, and refresh checks stay in the internal [BrowserAuth implementation](src/browser-auth.ts). The [plugin entry](src/index.ts) supplies the Connection, ConnectionAuthentication, and WebServer integration, and [internal types](src/types.ts) describe the HTTP operations used by the signer.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../../client/connection/README.md) — ConnectionAuthentication registration and existing Peer lifecycle.
- [WebServer](../webserver/README.md) — HTTP routes and request events.
- [Credentials](../../credentials/credentials/README.md) — persistent signing-key records.

<a id="model-experience"></a>
## Model Experience

None, as the plugin authenticates HTTP callers and contributes no model input.

#### KV Cache effect

None; authentication does not modify model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser Cookies share one plugin-owned Peer; ending the plugin scope ends its live connections together.
- The launch token is single-use per exchange path, so one process mints one browser Cookie exchange and one API operator. Reopening a spent URL returns 401; restarting `dsh web` mints a new token.
- No client schedules `POST /_dsh/auth/refresh` yet. Renewal is available to a page that calls it, but an expired Cookie otherwise requires restarting the server.
- Plain HTTP transports bearer Cookies without encryption. Listener TLS determines the Cookie's `Secure` attribute.
- The token middleware owns only the root token exchange. Other HTML or product paths keep their route owner's handling, including any token query on those paths.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
