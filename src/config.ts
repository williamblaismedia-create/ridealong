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
}

function expandHome(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, homedir()) : p;
}

function intOr(v: string | undefined, dflt: number): number {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : dflt;
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
    secret: env.SCRY_LIVE_SECRET,
    liveViewPort: intOr(env.SCRY_LIVE_PORT, 9400),
    livePublicUrl: env.SCRY_LIVE_PUBLIC_URL,
  };
}
