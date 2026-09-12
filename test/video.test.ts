import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { startBrowser } from './helpers.js';
import { Driver } from '../src/driver.js';
import { Mp4Splitter, VideoStream, ffmpegArgs, defaultBitrateKbps } from '../src/video.js';

function box(type: string, payload: Buffer = Buffer.alloc(0)): Buffer {
  const b = Buffer.alloc(8 + payload.length);
  b.writeUInt32BE(8 + payload.length, 0); b.write(type, 4, 'latin1'); payload.copy(b, 8);
  return b;
}

describe('Mp4Splitter (pure)', () => {
  it('yields ftyp+moov as ONE init segment, then each moof+mdat pair, across arbitrary chunking', () => {
    const stream = Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', Buffer.alloc(40)), box('moof', Buffer.alloc(12)), box('mdat', Buffer.alloc(100)), box('moof', Buffer.alloc(12)), box('mdat', Buffer.alloc(50))]);
    const inits: Buffer[] = []; const segs: Buffer[] = [];
    const s = new Mp4Splitter();
    // feed 7 bytes at a time to exercise partial-header handling
    for (let i = 0; i < stream.length; i += 7) s.push(stream.subarray(i, i + 7), { onInit: (b) => inits.push(b), onSegment: (b) => segs.push(b) });
    expect(inits).toHaveLength(1);
    expect(inits[0].length).toBe(8 + 4 + 8 + 40);
    expect(segs).toHaveLength(2);
    expect(segs[0].length).toBe(8 + 12 + 8 + 100);
    expect(segs[1].length).toBe(8 + 12 + 8 + 50);
  });

  it('default bitrate scales with the frame size (2K gets ~2.8x the 1440x900 budget)', () => {
    expect(defaultBitrateKbps(1440, 900)).toBe(5000);
    expect(defaultBitrateKbps(1920, 1080)).toBe(8000);
  });

  it('ffmpegArgs targets Constrained Baseline fMP4 with 100ms fragments (what MSE on iOS/Chrome decodes)', () => {
    const a = ffmpegArgs({ fps: 20, bitrateKbps: 3000, encoder: 'h264_nvenc' });
    expect(a).toContain('h264_nvenc');
    expect(a.join(' ')).toMatch(/-preset p4 .*-rc vbr -cq 19/); // quality-first
    expect(a.join(' ')).toMatch(/-profile:v baseline/);
    expect(a.join(' ')).toMatch(/frag_keyframe\+empty_moov\+default_base_moof/);
    expect(a.join(' ')).toMatch(/-frag_duration 100000/);
  });
});

const hasFfmpeg = (() => { try { execSync('ffmpeg -version', { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!hasFfmpeg)('VideoStream (integration, libx264 locally)', () => {
  let env: Awaited<ReturnType<typeof startBrowser>>;
  let driver: Driver;
  beforeAll(async () => {
    env = await startBrowser();
    driver = await Driver.connect(env.cdpUrl, { viewport: { width: 640, height: 400 }, defaultTimeoutMs: 15000 });
    await driver.navigate(env.pageUrl);
  });
  afterAll(async () => { await driver.close(); await env.stop(); });

  it('a STILL page still yields an init segment and segments (last frame re-fed while idle)', async () => {
    const vs = new VideoStream(driver, { width: 640, height: 400, fps: 20, bitrateKbps: 800, encoder: 'libx264' });
    let init: Buffer | undefined; let segs = 0;
    vs.on('init', (b) => { init = b; }); vs.on('segment', () => segs++);
    await vs.start();
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (!init || segs < 2)) await new Promise((r) => setTimeout(r, 100));
    await vs.stop();
    expect(init).toBeDefined();
    expect(segs).toBeGreaterThanOrEqual(2);
  }, 20000);

  it('emits an init segment then media segments as the page changes; stop() ends ffmpeg', async () => {
    const vs = new VideoStream(driver, { width: 640, height: 400, fps: 20, bitrateKbps: 800, encoder: 'libx264' });
    const segs: Buffer[] = [];
    let init: Buffer | undefined;
    vs.on('init', (b) => { init = b; });
    vs.on('segment', (b) => segs.push(b));
    await vs.start();
    expect(vs.isRunning).toBe(true);
    // Animate the page so the screencast keeps producing frames.
    const poke = setInterval(() => { void driver.page().evaluate(() => { document.body.style.background = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0'); }).catch(() => {}); }, 60);
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline && (!init || segs.length < 3)) await new Promise((r) => setTimeout(r, 100));
    clearInterval(poke);
    expect(init).toBeDefined();
    expect(init!.toString('latin1', 4, 8)).toBe('ftyp');
    expect(init!.includes('moov')).toBe(true);
    expect(init!.includes('avc1')).toBe(true);
    expect(segs.length).toBeGreaterThanOrEqual(3);
    expect(segs[0].toString('latin1', 4, 8)).toBe('moof');
    expect(vs.framesIn).toBeGreaterThan(0);
    await vs.stop();
    expect(vs.isRunning).toBe(false);
  }, 20000);
});
