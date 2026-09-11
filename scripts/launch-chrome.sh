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
X_LOCK="/tmp/.X${DISPLAY_NUM}-lock"
PROFILE_DIR="${HOME}/scry-donnees/profile"

# --- Is display :99 actually SERVING? -------------------------------------
# Guarding on the socket FILE was a trap: an unclean Xvfb death leaves the
# socket behind, the old guard then skipped Xvfb, Chrome couldn't open the
# display, exited, and systemd (Restart=always) crash-looped in silence.
# Probe liveness instead: xdpyinfo when present (authoritative), else a
# live Xvfb process on this display.
display_up() {
  if command -v xdpyinfo >/dev/null 2>&1; then
    xdpyinfo -display "${DISPLAY_ADDR}" >/dev/null 2>&1
  else
    pgrep -f "Xvfb ${DISPLAY_ADDR}([[:space:]]|\$)" >/dev/null 2>&1
  fi
}

if ! display_up; then
  # No live server: clear any stale socket/lock from an unclean death,
  # then start a fresh Xvfb. -nolisten tcp: the framebuffer never opens a
  # TCP port (local X only).
  rm -f "${X_SOCKET}" "${X_LOCK}" 2>/dev/null || true
  Xvfb "${DISPLAY_ADDR}" -screen 0 1440x900x24 -nolisten tcp &

  # Bounded wait for the display to actually answer (not just for the
  # socket file to appear) before Chrome attaches — near-instant usually,
  # but avoids a cold-boot race without slowing the common case.
  for _ in {1..50}; do
    display_up && break
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
# itself rather than a wrapper shell.
#
# --password-store=basic is LOAD-BEARING: on Linux, Chrome encrypts the
# cookie store with a key from whichever backend it auto-picks (gnome
# keyring, kwallet, or basic). If that choice differs between runs — which
# it can, headless-of-a-keyring on a server — the stored cookies become
# undecryptable and William's persistent sessions VANISH, the one thing
# this host exists to keep. Pinning "basic" makes the key choice stable.
#
# --window-size=1440,900 matches the driver's fixed viewport, but the
# window includes toolbar chrome, so the content area is a little shorter;
# check at acceptance that the live cast isn't cropped/letterboxed.
exec google-chrome \
  --user-data-dir="${PROFILE_DIR}" \
  --password-store=basic \
  --remote-debugging-port=9222 \
  --remote-debugging-address=127.0.0.1 \
  --no-first-run \
  --no-default-browser-check \
  --disable-features=Translate \
  --window-size=1440,900 \
  about:blank
