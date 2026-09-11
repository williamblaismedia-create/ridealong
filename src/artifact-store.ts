import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export class ArtifactStore {
  constructor(private dataDir: string) {}

  async save(kind: string, bytes: Buffer | string, ext: string): Promise<{ path: string; bytes: number; summary: string }> {
    // Validate kind and ext to prevent path traversal
    const validPattern = /^[a-zA-Z0-9_-]+$/;
    if (!validPattern.test(kind) || !validPattern.test(ext)) {
      throw new Error(`kind/ext invalide: kind="${kind}" ext="${ext}"`);
    }

    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
    const hash = createHash('sha1').update(buf).digest('hex').slice(0, 8);
    const dir = join(this.dataDir, 'artifacts');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${kind}-${hash}.${ext}`);
    await writeFile(path, buf);
    return { path, bytes: buf.length, summary: `${kind} ${buf.length} octets -> ${path}` };
  }

  async read(path: string): Promise<Buffer> {
    return readFile(path);
  }
}
