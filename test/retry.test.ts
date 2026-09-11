import { describe, it, expect } from 'vitest';
import { withRetry } from '../src/driver.js';

describe('withRetry', () => {
  it('retries a transient failure then succeeds', async () => {
    let n = 0;
    const r = await withRetry(async () => { if (n++ < 2) throw new Error('Target closed'); return 'ok'; }, { tries: 3, baseMs: 1 });
    expect(r).toBe('ok');
    expect(n).toBe(3);
  });
  it('rethrows a non-transient error without retrying', async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new Error('boom logic'); }, { tries: 3, baseMs: 1 })).rejects.toThrow('boom logic');
    expect(n).toBe(1);
  });
});
