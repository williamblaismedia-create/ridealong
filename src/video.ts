import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import type { Driver } from './driver.js';

/**
 * H.264 live stream of the primary tab, encoded on the host GPU.
 *
 * Pipeline: CDP Page.screencast (JPEG frames, viewport-sized) -> ffmpeg
 * stdin as an MJPEG stream -> h264_nvenc (or any H.264 encoder) -> fragmented
 * MP4 on stdout -> split into an INIT segment (ftyp+moov) and media
 * fragments (moof+mdat) -> pushed to viewers as binary websocket messages,
 * decoded natively in the page through Media Source Extensions.
 *
 * Why not x11grab: the screencast already follows the cast tab and its
 * viewport exactly (no tab strip, no other window), and it costs nothing
 * on a static page (Chrome emits no frame, ffmpeg gets no input).
 *
 * One encoder per LiveView, shared by every video viewer. A late joiner
 * needs an init segment AND a keyframe: the cheap, correct answer is to
 * restart the encoder when someone joins (a few hundred ms), which gives
 * everyone a fresh init + IDR; viewers reset their SourceBuffer on init.
 *
 * Timestamps are wall-clock and passed through (no CFR duplication), so a
 * long static period produces no output instead of a burst of copies.
 */
export interface VideoOpts {
  width: number;
  height: number;
  fps?: number;          // input cap; default 30
  bitrateKbps?: number;  // default 3000
  ffmpeg?: string;       // binary; default 'ffmpeg'
  encoder?: string;      // default: detectEncoder() (nvenc > videotoolbox > libx264); tests pin 'libx264'
  jpegQuality?: number;  // screencast JPEG quality fed to the encoder
}

export const VIDEO_MIME = 'video/mp4; codecs="avc1.42E01E"'; // Constrained Baseline 3.0

/** Preferred H.264 encoders, best first: NVIDIA GPU, Apple GPU, software. */
export const ENCODER_PREFERENCE = ['h264_nvenc', 'h264_videotoolbox', 'libx264'] as const;

const detected = new Map<string, Promise<string | undefined>>();
/**
 * Pick the best H.264 encoder this ffmpeg has (cached per binary). Undefined
 * when ffmpeg is missing or has none: the live view then serves JPEG only.
 */
export function detectEncoder(ffmpeg = 'ffmpeg'): Promise<string | undefined> {
  let p = detected.get(ffmpeg);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(ffmpeg, ['-hide_banner', '-encoders'], { timeout: 10_000 }, (err, stdout) => {
        if (err) return resolve(undefined);
        const have = String(stdout);
        resolve(ENCODER_PREFERENCE.find((e) => new RegExp(`\\s${e}\\s`).test(have)));
      });
    });
    detected.set(ffmpeg, p);
  }
  return p;
}

/** Default target bitrate scaled to the frame: ~5 Mb/s at 1440x900, ~8 Mb/s at 1920x1080 (UI text needs it; VBR spends less on static pages). */
export function defaultBitrateKbps(width: number, height: number): number {
  return Math.round(5000 * (width * height) / (1440 * 900));
}

/** ffmpeg argv for the pipeline; exported for tests/inspection. */
export function ffmpegArgs(o: Required<Pick<VideoOpts, 'fps' | 'bitrateKbps' | 'encoder'>>): string[] {
  // NVENC: quality-first. p4 + VBR driven by a constant-quality target with
  // spatial/temporal AQ keeps UI text crisp and spends bits only on motion
  // (a static page costs almost nothing); the maxrate cap bounds the burst.
  // Compared on w-agent at 1080p against p1/CBR: ~1.7x the bytes on a worst-
  // case test pattern, visibly sharper text.
  const enc = o.encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'vbr', '-cq', '19', '-spatial-aq', '1', '-temporal-aq', '1', '-zerolatency', '1']
    : o.encoder === 'h264_videotoolbox'
      ? ['-c:v', 'h264_videotoolbox', '-realtime', '1', '-allow_sw', '1']
      : o.encoder === 'libx264'
        ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency']
        : ['-c:v', o.encoder];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'mjpeg', '-framerate', String(o.fps), '-use_wallclock_as_timestamps', '1', '-i', 'pipe:0',
    '-fps_mode', 'passthrough',
    '-vf', 'format=yuv420p',
    ...enc,
    '-b:v', `${o.bitrateKbps}k`, '-maxrate', `${Math.round(o.bitrateKbps * 1.75)}k`, '-bufsize', `${Math.round(o.bitrateKbps * 0.9)}k`,
    // No explicit -level: h264_nvenc rejects it ("incorrect parameters") and
    // picks the right one from the size/rate itself. Verified on w-agent.
    '-g', String(o.fps * 2), '-bf', '0', '-profile:v', 'baseline',
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-frag_duration', '100000',
    'pipe:1',
  ];
}

/**
 * Incremental MP4 box splitter: feed bytes, get back the init segment once
 * (ftyp+moov) and then one Buffer per moof+mdat pair.
 */
export class Mp4Splitter {
  private buf: Buffer = Buffer.alloc(0);
  private init: Buffer[] = [];
  private initDone = false;
  private pendingMoof: Buffer | undefined;

  push(chunk: Buffer, out: { onInit: (b: Buffer) => void; onSegment: (b: Buffer) => void }): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 8) return;
      let size = this.buf.readUInt32BE(0);
      const type = this.buf.toString('latin1', 4, 8);
      if (size === 1) { // 64-bit size
        if (this.buf.length < 16) return;
        size = Number(this.buf.readBigUInt64BE(8));
      } else if (size === 0) { size = this.buf.length; }
      if (size < 8) { this.buf = Buffer.alloc(0); return; } // corrupt: drop
      if (this.buf.length < size) return;
      const box = this.buf.subarray(0, size);
      this.buf = this.buf.subarray(size);
      if (!this.initDone) {
        this.init.push(Buffer.from(box));
        if (type === 'moov') { this.initDone = true; out.onInit(Buffer.concat(this.init)); this.init = []; }
        continue;
      }
      if (type === 'moof') { this.pendingMoof = Buffer.from(box); continue; }
      if (type === 'mdat' && this.pendingMoof) { out.onSegment(Buffer.concat([this.pendingMoof, box])); this.pendingMoof = undefined; continue; }
      // any other top-level box after init (sidx, etc.) is ignored
    }
  }
}

export class VideoStream extends EventEmitter {
  private proc: ChildProcess | undefined;
  private cdp: CDPSession | undefined;
  private splitter = new Mp4Splitter();
  private starting: Promise<void> | undefined;
  private running = false;
  private restartTimer: NodeJS.Timeout | undefined;
  private frames = 0;
  private lastJpeg: Buffer | undefined;
  private lastAt = 0;
  private idleTimer: NodeJS.Timeout | undefined;
  public init: Buffer | undefined;

  constructor(private driver: Driver, private opts: VideoOpts) { super(); }

  get isRunning(): boolean { return this.running; }
  get framesIn(): number { return this.frames; }

  /** Start (idempotent). Emits 'init' (Buffer) then 'segment' (Buffer) events; 'error' (Error); 'exit'. */
  start(): Promise<void> {
    if (this.running) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => { this.starting = undefined; });
    return this.starting;
  }

  private async doStart(): Promise<void> {
    const fps = this.opts.fps ?? 30;
    const encoder = this.opts.encoder ?? (await detectEncoder(this.opts.ffmpeg ?? 'ffmpeg'));
    if (!encoder) throw new Error('aucun encodeur H.264 (ffmpeg absent ?) — vue live en JPEG seulement');
    const args = ffmpegArgs({ fps, bitrateKbps: this.opts.bitrateKbps ?? defaultBitrateKbps(this.opts.width, this.opts.height), encoder });
    const proc = spawn(this.opts.ffmpeg ?? 'ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    this.splitter = new Mp4Splitter();
    this.init = undefined;
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    proc.stdout?.on('data', (d: Buffer) => {
      this.splitter.push(d, {
        onInit: (b) => { this.init = b; this.emit('init', b); },
        onSegment: (b) => this.emit('segment', b),
      });
    });
    proc.stdin?.on('error', () => { /* EPIPE on teardown */ });
    proc.on('exit', (code, signal) => {
      if (this.proc !== proc) return;
      this.running = false;
      this.proc = undefined;
      this.emit('exit', { code, signal, stderr });
    });
    proc.on('error', (e) => { if (this.proc === proc && this.listenerCount('error')) this.emit('error', e); });

    // Feed: one screencast on the primary tab at the encoder's size.
    const cdp = await this.driver.cdpSession();
    this.cdp = cdp;
    const feed = (jpeg: Buffer) => {
      // Backpressure: if ffmpeg falls behind (stdin buffer > ~8 MB), skip
      // the frame rather than grow memory; the next one carries the same picture.
      if (this.proc === proc && proc.stdin?.writable && (proc.stdin.writableLength ?? 0) < 8 * 1024 * 1024) proc.stdin.write(jpeg);
    };
    cdp.on('Page.screencastFrame', async (f) => {
      this.frames++;
      this.lastJpeg = Buffer.from(f.data, 'base64');
      this.lastAt = Date.now();
      feed(this.lastJpeg);
      try { await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }); } catch { /* tearing down */ }
    });
    // Chrome emits a frame only when something changes. A still page would
    // starve ffmpeg (no header, nothing for a viewer who just joined) and
    // stall MSE. Re-feed the last frame at 2 fps while idle: near-free with
    // VBR (identical P-frames), and the stream stays continuous.
    this.idleTimer = setInterval(() => {
      if (this.lastJpeg && Date.now() - this.lastAt >= 450) feed(this.lastJpeg);
    }, 500);
    await this.driver.page().bringToFront().catch(() => {});
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: this.opts.jpegQuality ?? 92, maxWidth: this.opts.width, maxHeight: this.opts.height, everyNthFrame: 1 });
    this.running = true;
  }

  /** Restart soon (coalesced): a fresh init + keyframe for every subscriber. */
  restart(): void {
    if (this.restartTimer) return;
    this.restartTimer = setTimeout(async () => {
      this.restartTimer = undefined;
      await this.stop();
      try { await this.start(); } catch (e) { this.emit('error', e as Error); }
    }, 150);
  }

  async stop(): Promise<void> {
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    if (this.idleTimer) { clearInterval(this.idleTimer); this.idleTimer = undefined; }
    this.lastJpeg = undefined;
    const cdp = this.cdp; this.cdp = undefined;
    if (cdp) {
      await cdp.send('Page.stopScreencast').catch(() => {});
      await cdp.detach().catch(() => {});
    }
    const proc = this.proc; this.proc = undefined;
    this.running = false;
    if (proc) {
      try { proc.stdin?.end(); } catch { /* ignore */ }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* ignore */ } resolve(); }, 1500);
        proc.once('exit', () => { clearTimeout(t); resolve(); });
      });
    }
  }
}
