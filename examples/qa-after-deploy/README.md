# QA after deploy

## Scenario

You just deployed a web app and want to know within a minute whether the
thing you shipped actually works, not whether the build passed. Claude opens
the production URL in a real Chrome, clicks through the primary flow while
you watch, and reports every console error and failed request it saw.

## Prerequisites

`claude mcp add ridealong -- npx -y -p ridealong-mcp ridealong` (Chrome and
Node 20+ on the machine Claude drives; `ffmpeg` optional, for video instead
of JPEG frames).

## Prompt

Paste into Claude Code, replacing the URL and the flow:

```text
I just deployed https://app.example.com. Use Ridealong to smoke-test it:

1. Start the live view and give me the link.
2. Navigate to the URL, then reload once so nothing comes from cache.
3. Clear console_errors, then walk this flow: open the pricing page, click
   "Start free trial", fill the signup form with test+ridealong@example.com,
   submit, and land on the dashboard.
4. After each step, check diff for what changed and console_errors for
   anything new. At the end, list network_requests filtered on "/api/" and
   flag every non-2xx.
5. Report: steps that passed, steps that failed (with the exact error text),
   and a screenshot of the final page. Do not fix anything, just report.
```

## What you see, where you step in

- Open the link Claude gives you (`http://127.0.0.1:9400/#token=...`, or your
  public URL if you set one). You see Chrome as Claude sees it, its cursor
  moving to each target, a ripple on click, and a timestamped journal on the
  side.
- Left alone, this runs end to end. You intervene when you want to:
  - **Point.** In Auto mode, tap an element on the live view. Claude gets a
    `[name]` inbox line naming the element (`button « Start free trial »`)
    at the foot of its next tool result and can act on it. Useful when it is about to click the wrong
    button or you want it to inspect a widget it skipped.
  - **Message.** Type a one-liner from the page ("also try the dark mode
    toggle"). Same delivery path.
  - **Pause.** Freeze Claude without taking control. Tools that change the
    page block until you resume; looking is still allowed.
- Point and message lines arrive with the next tool result. Start Claude with
  `claude --dangerously-load-development-channels server:ridealong` and they
  arrive instantly instead, even while Claude is thinking.

## Tools the agent calls

`live_start`, `navigate`, `reload`, `console_errors` (with `clear: true`
first), `snapshot` or `find` to get `[ref]`s, `act` (`click`, `type`,
`press`), `fill` for the form, `diff` after each action, `network_requests`
(with `filter: "/api/"`), `screenshot`, `state`. If the flow spans tabs:
`tabs_list`, `tabs_select`.

Note that `reload` and `navigate` already bypass Chrome's HTTP cache and
service workers on every target tab, so a stale build is never what Claude is
looking at. `console_errors` includes `console.error`/`warn`, uncaught
exceptions, failed requests and HTTP 4xx/5xx responses since the last clear.

## Optional: run it after every deploy

Drop this in your project's `CLAUDE.md` so Claude does the check without
being asked:

```markdown
## After a deploy

After any command that deploys (`npm run deploy`, `vercel --prod`,
`wrangler deploy`, `fly deploy`), verify with Ridealong before reporting done:

1. `live_start` and print the link.
2. `navigate` to the production URL, then `reload`.
3. `console_errors` with `clear: true`, then click through the primary flow
   described in docs/smoke-flow.md using `snapshot`/`find` + `act`/`fill`.
4. `console_errors` and `network_requests` (filter `/api/`). Any error or
   non-2xx is a failed deploy: report it with the exact text, do not fix it
   silently.
```

## What makes this different from plain browser automation

A Playwright script tests what you wrote the script for. Here you describe
the flow in one paragraph, watch a real Chrome (your codecs, your extensions,
your profile) execute it, and redirect it mid-run by tapping the screen. When
something looks off, you do not read a log after the fact: you are already
looking at the page, and Claude has the console and the network log in the
same transcript as the click that caused them.
