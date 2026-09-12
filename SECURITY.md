# Security

Ridealong relays a human's keyboard into a browser and streams that browser's
screen. Treat it accordingly.

## Report a vulnerability

Email security@wautomatisations.com. Please do not open a public issue for
anything that could expose a session, a token, or typed input. You will get
an answer within 72 hours.

## Model

- The live view is gated by HMAC-signed, expiring tokens minted from
  `SCRY_LIVE_SECRET`. Viewer tokens live 30 s – 1 h; device tokens 30 days;
  control tokens (second session) use a distinct key derivation. Rotating
  the secret revokes all of them.
- Tokens travel in the URL fragment (never sent to the server as a path or
  query on page load) and are scrubbed from history; the page keeps them in
  session/local storage only.
- The server binds to loopback unless `SCRY_LIVE_BIND` says otherwise.
- Manual-mode input is forwarded to CDP and never retained, logged, or
  exposed to the model. Perception tools are refused while Manual is on.
- `fetch_with_session` and `act` run with the browser's cookies: whoever
  drives Ridealong drives your logged-in sessions. Use a dedicated Chrome profile.
