# Ridealong examples

Three copy-pasteable scenarios. Each folder has a README with the exact prompt
to paste into Claude Code, what you see on the live view, where you step in,
and the tools the agent will call.

Install once, on the machine Claude drives:

```bash
claude mcp add ridealong -- npx -y -p ridealong-mcp ridealong
```

## [QA after deploy](qa-after-deploy/)

You just shipped. Claude opens the production URL in a real Chrome with the
HTTP cache and service workers bypassed, clicks through the main flow, then
reads `console_errors` and `network_requests` and reports what broke. You
watch it happen on the live view and tap anything it should look at. Comes
with a small `CLAUDE.md` snippet so this runs after every deploy without
asking.

## [Approval-gated purchase](approval-gated-purchase/)

Claude fills a checkout or any form with a consequential final step. It must
call `ask_approval` before submitting; the tool blocks until you tap Approve
or Deny on your phone. Nothing is sent without you, and your quick messages
arrive in Claude's transcript as `[name]` inbox lines.

## [Login handoff](login-handoff/)

Claude hits a login or 2FA wall. It switches the live view to Manual
(`live_mode input`), you type your credentials on your own device, then hand
back. While you have the wheel, Claude's perception tools refuse to run and
the input relay stores nothing, so the agent never sees the keystrokes.
