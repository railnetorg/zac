import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planRoleCalls, type PlanApplyRoleFn } from '../../apply/planRoleCalls';
import { parseGenerated } from '../../apply/parseGenerated';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const REPO_ROOT = resolve(__dirname, '../../..');
const CLI = resolve(REPO_ROOT, 'action/cli.ts');

describe('morpho-blue composite ops — end-to-end', () => {
  it('TC-10: examples/mainnet/morpho_blue_safe.zac.yaml renders, validates, and routes through planRoleCalls against the REAL SDK without throwing', async () => {
    const sourcePath = 'examples/mainnet/morpho_blue_safe.zac.yaml';
    const generatedPath = resolve(REPO_ROOT, 'examples/mainnet/morpho_blue_safe.yaml');
    if (existsSync(generatedPath)) unlinkSync(generatedPath);
    try {
      // Step 1: render the morpho-blue config via the real `zac generate`.
      execFileSync('bun', [CLI, 'generate', sourcePath], {
        cwd: REPO_ROOT,
        stdio: 'pipe',
      });

      const yaml = readFileSync(generatedPath, 'utf8');
      // Smoke checks that the composite ops survived rendering.
      expect(yaml).toContain('operator: or');
      expect(yaml).toContain('operator: matches');

      // Step 2: parse to Generated shape — exercises parseGenerated validation.
      const generated = parseGenerated(generatedPath);
      expect(generated.roles['MORPHO_BLUE']).toBeDefined();

      // Step 3: route through planRoleCalls with the REAL SDK builders.
      // We inject a stub `planApplyRole` so we don't talk to chain — what we
      // need to verify is that `toSdkTargets` produces a target[] shape that
      // the SDK's `processPermissions` accepts. If our recursion emits
      // something the SDK rejects (RC1 in the plan), this throws.
      let planApplyRoleCalled = false;
      const stubPlanApplyRole: PlanApplyRoleFn = async (desired) => {
        planApplyRoleCalled = true;
        // The desired.targets here was produced by `toSdkTargets` against
        // the REAL SDK builders and run through the REAL `processPermissions`.
        expect(Array.isArray(desired.targets)).toBe(true);
        expect(desired.targets.length).toBeGreaterThan(0);
        // No on-chain calls for this test; pretend the role state is already in sync minus one call.
        return [
          {
            to: '0x4444444444444444444444444444444444444444' as `0x${string}`,
            data: '0xdeadbeef' as `0x${string}`,
          },
        ];
      };

      const calls = await planRoleCalls({
        generated,
        planApplyRole: stubPlanApplyRole,
      });

      expect(planApplyRoleCalled).toBe(true);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.data).toBe('0xdeadbeef');
    } finally {
      if (existsSync(generatedPath)) unlinkSync(generatedPath);
    }
  });
});
