import { describe, it, expect } from 'vitest';
import { homedir } from 'node:os';
import { loadConfig } from '../src/config.js';

describe('loadConfig', () => {
  it('applies defaults when env is empty', () => {
    const c = loadConfig({});
    expect(c.cdpUrl).toBe('http://127.0.0.1:9222');
    expect(c.viewport).toEqual({ width: 1440, height: 900 });
    expect(c.defaultTimeoutMs).toBe(15000);
    expect(c.readBudgetChars).toBe(8000);
    expect(c.dataDir).toBe(`${homedir()}/scry-donnees`);
    // No live-view secret is ever invented — unset means live-view stays off.
    expect(c.secret).toBeUndefined();
    expect(c.liveViewPort).toBe(9400);
    // No public URL is invented either — unset falls back to loopback in url().
    expect(c.livePublicUrl).toBeUndefined();
  });

  it('reads SCRY_LIVE_PUBLIC_URL when set (m6)', () => {
    const c = loadConfig({ SCRY_LIVE_PUBLIC_URL: 'https://scry.wautomatisations.com' });
    expect(c.livePublicUrl).toBe('https://scry.wautomatisations.com');
  });

  it('expands a leading ~ in dataDir and reads overrides', () => {
    const c = loadConfig({ SCRY_DATA_DIR: '~/ailleurs', SCRY_VIEWPORT_WIDTH: '1280', SCRY_CDP_URL: 'http://127.0.0.1:9333' });
    expect(c.dataDir).toBe(`${homedir()}/ailleurs`);
    expect(c.viewport.width).toBe(1280);
    expect(c.cdpUrl).toBe('http://127.0.0.1:9333');
  });

  it('reads SCRY_LIVE_SECRET and SCRY_LIVE_PORT', () => {
    const c = loadConfig({ SCRY_LIVE_SECRET: 'shh', SCRY_LIVE_PORT: '9555' });
    expect(c.secret).toBe('shh');
    expect(c.liveViewPort).toBe(9555);
  });
});
