# Login handoff

## Scenario

Claude is working in a site and hits a login form, a 2FA prompt or a
CAPTCHA. Instead of asking you to paste a password into the chat, it hands
you the wheel: you type on your own device, straight into the same Chrome,
and give control back when the session is authenticated.

## Prerequisites

`claude mcp add ridealong -- npx -y -p ridealong-mcp ridealong`, and the live
view open on the device you will type from (phone or laptop).

## Prompt

Paste into Claude Code, replacing the app and the task:

```text
Use Ridealong to export last month's invoices from https://billing.example.com.

- Start the live view and give me the link.
- Navigate there. If you land on a login page or a 2FA / CAPTCHA screen,
  do NOT ask me for credentials. Call live_mode with mode "input", tell me
  you have handed over, then wait on inbox until I say "done".
- When I say done, call live_mode with mode "read", snapshot the page to
  confirm I am logged in, and continue: open Invoices, filter on last month,
  download the CSV, and tell me where the file is.
- Never type into a password field yourself.
```

## What you see, where you step in

- You watch Claude reach the login wall on the live view. The journal shows
  `live_mode input` and the viewer toggle flips from **Auto** to **Manual**.
- In Manual, your taps, keyboard, trackpad scroll and pinch are relayed into
  the page. Type your email and password, approve the push notification or
  enter the one-time code, solve the CAPTCHA if there is one. The page you
  are typing into is the real Chrome Claude was driving; the session cookies
  stay there.
- When the dashboard appears, send Claude the message "done" from the live
  view (or flip the toggle back yourself). Claude switches back to `read`,
  takes a snapshot and carries on with the cookies you just earned.
- You can also take the wheel without being asked: flip **Auto | Manual** on
  the viewer at any moment. Claude is told you took control and is expected
  to wait.

## What Claude never sees

While the live view is in `input` mode:

- `snapshot`, `find`, `read`, `screenshot` and `diff` refuse to run and
  return an error saying perception is suspended. No snapshot of the
  password field, no screenshot of a "show password" toggle, no reading of a
  one-time code on screen.
- The input relay forwards your events to Chrome and retains nothing: no
  buffer, no log, nothing in the transcript. Password fields never expose
  their values in snapshots, in any mode.
- The MCP server's own instructions tell Claude to wait when you have the
  wheel, and the test suite pins the no-capture behaviour down.

After you hand back, Claude sees a logged-in page and a session, not the
credentials that produced it.

## Tools the agent calls

`live_start`, `navigate`, `snapshot` or `state` to recognise the login wall
(`title`, `url`, a "Sign in" heading), `live_mode` (`mode: "input"`),
`inbox` (`waitSec` up to 600) to wait for your "done", `live_mode`
(`mode: "read"`), `snapshot` again (refs from before the handoff are stale),
then the actual work: `find`, `act`, `fill`, `network_requests` or
`fetch_with_session` to pull the CSV with the browser's cookies.

## What makes this different from plain browser automation

Headless tools stop at the login page, or make you store secrets in an env
file, or ask you to paste a 2FA code into the chat where it sits in the
transcript forever. Here the browser is real and shared: you authenticate in
it exactly as you would in your own tab, on your own phone, and the agent
inherits the session without ever being able to look while you type. The
handoff is one tool call in each direction.
