# Approval-gated purchase

## Scenario

Claude fills a checkout, a booking, or any form whose last step spends money
or cannot be undone. It does everything up to the final button, then calls
`ask_approval`; the tool blocks until you tap Approve or Deny on your phone,
and Claude only submits on Approve.

## Prerequisites

`claude mcp add ridealong -- npx -y -p ridealong-mcp ridealong`, and the live
view open on any device (the approval card is shown there).

## Prompt

Paste into Claude Code, adjusting the store and the item:

```text
Use Ridealong to order the item at https://shop.example.com/p/usb-c-hub-7in1.

- Start the live view and give me the link; I will watch from my phone.
- Add one unit to the cart, go to checkout, choose standard shipping and the
  saved address "Home". Use the saved card ending in 4242 if one is offered;
  do not type card numbers.
- Before you click the final "Place order" button, call ask_approval with the
  exact total, the shipping option and the last 4 digits of the card, and
  wait for me. Submit only if I approve. If I deny or you get no answer, stop
  and tell me where you left the cart.
- If anything on the page differs from what I described (price, out of
  stock, extra fee), do not guess: ask me through ask_approval or wait on
  inbox for my instruction.
```

## What you see, where you step in

- On the live view you follow Claude's cursor through the cart and the
  checkout form. Each field it fills shows up in the journal.
- When Claude calls `ask_approval`, a card appears over the video with the
  question and two buttons, **Approve** and **Deny**. Claude's tool call is
  blocked until you answer (default 300 s, up to 1800 s). On timeout the tool
  tells Claude not to act and to ask again later.
- You can also **point** at an element or **message** Claude from the page at
  any time. These reach Claude as `[name]` lines at the foot of its next tool
  result (or instantly with `--dangerously-load-development-channels
  server:ridealong`). In the current build the label is the author's first
  name, and part of the wording is French; the shape is what matters
  (role, accessible name, then page coordinates for a pointed element):

  ```text
  [state] url=https://shop.example.com/checkout title="Checkout" ready=true dialog=false
  [william] William dit : use the express shipping instead
  [william] William pointe : button « Apply coupon » (412,388) ...
  ```

- If nobody has the live view open when Claude asks, the tool does not fail
  silently: it returns a fresh link for Claude to hand you, then asks again.
- `ask_approval` returns one of four strings and Claude acts only on the
  first: approved, denied, no answer, no viewer connected.

## Tools the agent calls

`live_start`, `navigate`, `snapshot` / `find`, `act` (`click`), `fill` (the
shipping and contact fields in one call), `diff` after each step to confirm
the cart changed, `read` to extract the total, `ask_approval`
(`question` up to 300 chars, optional `timeoutSec`), then `act` on the submit
button, `screenshot` of the confirmation, `inbox` (`waitSec`) when it needs
to wait for your instruction rather than a yes/no.

## What makes this different from plain browser automation

Most agents either refuse to touch money or do it and tell you afterwards.
Here the sensitive click is a first-class tool with a wait built in: the
agent literally cannot proceed until a human on a phone says so, and the
question it asks carries the amount you are approving. You are not
supervising a log; you are in the loop at the one step that matters, and you
can still redirect everything before it.
