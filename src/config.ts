import { homedir } from 'node:os';

export interface Config {
  cdpUrl: string;
  dataDir: string;
  viewport: { width: number; height: number };
  defaultTimeoutMs: number;
  readBudgetChars: number;
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
  };
}
