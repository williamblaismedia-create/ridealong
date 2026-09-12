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
  /** SCRY_LIVE_BIND: interface for the live-view server. Default loopback (a tunnel/relay fronts it); 0.0.0.0 in Docker. */
  liveBind: string;
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
  /** SCRY_BROWSER_CACHE=on keeps Chrome's HTTP cache / service workers. Default: bypassed (fresh content after every deploy). */
  browserCache: boolean;
  /**
   * Video path (H.264 fMP4 over the live-view websocket, encoded by ffmpeg).
   * SCRY_VIDEO=off disables it (viewers get JPEG frames only). SCRY_FFMPEG
   * (binary), SCRY_VIDEO_ENCODER (default: auto — h264_nvenc, else
   * h264_videotoolbox on a Mac, else libx264), SCRY_VIDEO_KBPS (default scales with the viewport:
   * ~5000 at 1440x900, ~8000 at 1920x1080), SCRY_VIDEO_FPS (30).
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

/** RIDEALONG_* is the public name of every variable; SCRY_* (the original name) keeps working. */
function withAliases(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith('RIDEALONG_') && v !== undefined) out['SCRY_' + k.slice('RIDEALONG_'.length)] = v;
  }
  return out;
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  const env = withAliases(rawEnv);
  return {
    cdpUrl: env.SCRY_CDP_URL ?? 'http://127.0.0.1:9222',
    dataDir: expandHome(env.SCRY_DATA_DIR ?? '~/ridealong-data'),
    viewport: {
      width: intOr(env.SCRY_VIEWPORT_WIDTH, 1440),
      height: intOr(env.SCRY_VIEWPORT_HEIGHT, 900),
    },
    defaultTimeoutMs: intOr(env.SCRY_DEFAULT_TIMEOUT_MS, 15000),
    readBudgetChars: intOr(env.SCRY_READ_BUDGET_CHARS, 8000),
    secret: realSecret(env.SCRY_LIVE_SECRET),
    liveViewPort: intOr(env.SCRY_LIVE_PORT, 9400),
    liveBind: env.SCRY_LIVE_BIND || '127.0.0.1',
    livePublicUrl: env.SCRY_LIVE_PUBLIC_URL,
    liveQuality: Math.min(100, Math.max(1, intOr(env.SCRY_LIVE_QUALITY, 85))),
    browserCache: (env.SCRY_BROWSER_CACHE ?? 'off').toLowerCase() === 'on',
    video: (env.SCRY_VIDEO ?? 'on').toLowerCase() === 'off' ? false : {
      ffmpeg: env.SCRY_FFMPEG || undefined,
      encoder: env.SCRY_VIDEO_ENCODER || undefined,
      bitrateKbps: env.SCRY_VIDEO_KBPS ? intOr(env.SCRY_VIDEO_KBPS, 0) || undefined : undefined, // unset: scales with the viewport
      fps: intOr(env.SCRY_VIDEO_FPS, 30),
    },
  };
}
