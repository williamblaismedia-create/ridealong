import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../src/artifact-store.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'scry-')); });

describe('ArtifactStore', () => {
  it('saves bytes under artifacts/ and returns path + size + summary', async () => {
    const store = new ArtifactStore(dir);
    const r = await store.save('dom', '<html>hi</html>', 'html');
    expect(r.path.startsWith(join(dir, 'artifacts'))).toBe(true);
    expect(r.path.endsWith('.html')).toBe(true);
    expect(r.bytes).toBe(15);
    expect(existsSync(r.path)).toBe(true);
    expect(readFileSync(r.path, 'utf8')).toBe('<html>hi</html>');
    expect(r.summary).toContain('15');
  });

  it('reads back what it saved', async () => {
    const store = new ArtifactStore(dir);
    const r = await store.save('img', Buffer.from([1, 2, 3]), 'png');
    const back = await store.read(r.path);
    expect([...back]).toEqual([1, 2, 3]);
  });
});
