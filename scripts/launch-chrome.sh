#!/usr/bin/env bash
#
# Scry — Chrome host launcher.
#
# Starts (or reuses) a virtual framebuffer, then execs a real Google
# Chrome, headful, against it. Headful-under-Xvfb — never --headless —
# because the proprietary H.264/AAC codecs (Timeliner's video would come
# back black under headless/chromium) and the CDP screencast that feeds
# the live view both need a real GPU-less-but-headful display pipeline.
# Spec: docs/specs/2026-09-11-scry-design.md §5.1 (chrome-host), §10
# (CDP local-only).
#
# Run by scry-chrome.service (a systemd --user unit) — see that file's
# header for the enable-linger requirement.
set -euo pipefail

# --- Fixed display + paths -------------------------------------------------
DISPLAY_NUM=99
DISPLAY_ADDR=":${DISPLAY_NUM}"
X_SOCKET="/tmp/.X11-unix/X${DISPLAY_NUM}"
PROFILE_DIR="${HOME}/scry-donnees/profile"

# --- Xvfb: start it only if display :99 isn't already up. Guarding on the
# socket file makes this script safe to re-run by hand (e.g. after a
# manual restart) without spawning a second, conflicting Xvfb. -------------
if [ ! -e "${X_SOCKET}" ]; then
  Xvfb "${DISPLAY_ADDR}" -screen 0 1440x900x24 &

  # Bounded wait for the X socket to appear before Chrome tries to attach
  # to it, instead of a fixed sleep: usually near-instant, but this avoids
  # a race on a slow/cold boot without slowing down the common case.
  for _ in {1..50}; do
    [ -e "${X_SOCKET}" ] && break
    sleep 0.1
  done
fi

export DISPLAY="${DISPLAY_ADDR}"

# --- Make sure the persistent profile dir exists (first run on a fresh
# host; ~/scry-donnees itself may not exist yet either). --------------------
mkdir -p "${PROFILE_DIR}"

# --- Google Chrome (NOT chromium — proprietary H.264/AAC codecs), headful
# under the Xvfb display above, CDP bound to loopback only (spec §10: the
# debug port is never exposed to the network; only the local Scry server
# connects to it). `exec` replaces this script's own process with Chrome's,
# so systemd (Restart=always in scry-chrome.service) supervises Chrome
# itself rather than a wrapper shell. ---------------------------------------
exec google-chrome \
  --user-data-dir="${PROFILE_DIR}" \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  --window-size=1440,900 \
  about:blank
