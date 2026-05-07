import { describe, it, expect } from 'vitest';
import { runGenerate } from '../../runGenerate';
import { ZacError } from '../../errors';

describe('runGenerate (stub)', () => {
  it('T2-9: rejects with ZacError when given a path', async () => {
    await expect(runGenerate({ configPath: '/nonexistent' })).rejects.toBeInstanceOf(ZacError);
  });
});
