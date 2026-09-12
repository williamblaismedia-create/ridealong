import { homedir } from 'node:os';

export interface Config {
  cdpUrl: string;
  dataDir: string;
  viewport: { width: number; height: number };
  defaultTimeoutMs: number;
  readBudgetChars: number;
  /** SCRY_LIVE_SECRET. Required for the live view; no default is invented — unset means live-view stays off. */
  secret: string | undefined;
  liveViewPort: number;
  /**
   * SCRY_LIVE_PUBLIC_URL. Public base (e.g. https://scry.wautomatisations.com)
   * the live link is minted from so it works behind the Cloudflare tunnel.
   * Optional, no default: unset falls back to 127.0.0.1:<port> (loopback).
   */
  livePublicUrl: string | undefined;
  /**
   * SCRY_LIVE_QUALITY. JPEG quality (1-100) of the live-view screencast
   * frames. Default 85. Frame SIZE is not configured here: it follows each
   * viewer's own screen (see LiveView / screencastParams).
   */
  liveQuality: number;
  /**
   * Video path (H.264 fMP4 over the live-view websocket, encoded by ffmpeg).
   * SCRY_VIDEO=off disables it (viewers get JPEG frames only). SCRY_FFMPEG
   * (binary), SCRY_VIDEO_ENCODER (h264_nvenc default; libx264 on a box
   * without an NVIDIA GPU), SCRY_VIDEO_KBPS (3000), SCRY_VIDEO_FPS (20).
   */
  video: false | { ffmpeg?: string; encoder?: string; bitrateKbps?: number; fps?: number };
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function intOr(v: string | undefined, dflt: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : dflt;
}

/**
 * A live-view secret must be real. An empty/whitespace value — or the runbook's
 * `CHANGE_ME` placeholder left in place — is treated as UNSET (live-view stays
 * off, gracefully) so the HMAC is never keyed on a guessable literal and tokens
 * can't be forged (N3). The launcher also warns on stderr in this case.
 */
function realSecret(v: string | undefined): string | undefined {
  const s = v?.trim();
  return !s || s === 'CHANGE_ME' ? undefined : s;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    cdpUrl: env.SCRY_CDP_URL ?? 'http://127.0.0.1:9222',
    dataDir: expandHome(env.SCRY_DATA_DIR ?? '~/scry-donnees'),
    viewport: {
      width: intOr(env.SCRY_VIEWPORT_WIDTH, 1440),
      height: intOr(env.SCRY_VIEWPORT_HEIGHT, 900),
    },
    defaultTimeoutMs: intOr(env.SCRY_DEFAULT_TIMEOUT_MS, 15000),
    readBudgetChars: intOr(env.SCRY_READ_BUDGET_CHARS, 8000),
    secret: realSecret(env.SCRY_LIVE_SECRET),
    liveViewPort: intOr(env.SCRY_LIVE_PORT, 9400),
    livePublicUrl: env.SCRY_LIVE_PUBLIC_URL,
    liveQuality: Math.min(100, Math.max(1, intOr(env.SCRY_LIVE_QUALITY, 85))),
    video: (env.SCRY_VIDEO ?? 'on').toLowerCase() === 'off' ? false : {
      ffmpeg: env.SCRY_FFMPEG || undefined,
      encoder: env.SCRY_VIDEO_ENCODER || undefined,
      bitrateKbps: intOr(env.SCRY_VIDEO_KBPS, 3000),
      fps: intOr(env.SCRY_VIDEO_FPS, 20),
    },
  };
}
