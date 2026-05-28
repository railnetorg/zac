import { describe, it, expect } from 'vitest';
import { encodeFunctionData } from 'viem';
import { decodeCall } from '../../apply/decodeCall';
import type { DecodeSdk } from '../../apply/decodeCall';
import type { PlanCall } from '../../apply/planSchema';

/**
 * Real fixtures pulled from
 * `/Users/isma/Development/Kiln/CS-ZAC/configs/mainnet/0x40FF.../0x40ff...plan.json`
 * (17-call plan). Each constant is the raw `data` field — `to` is the
 * Roles modifier address and is irrelevant to selector decoding.
 */
const MODIFIER = '0x6a2A4eb8695e501AFD6599020FAB970D6018012a';

const FIX_ASSIGN_ROLES_ETHENA: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x957ed2b30000000000000000000000004ecb4c676e596a5b2b9084c5aec8fce058ce71a6000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000001455448454e415f494e535449545554494f4e414c00000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000',
};

const FIX_REVOKE_TARGET_ETHENA_USDE: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x0172a43a455448454e415f494e535449545554494f4e414c0000000000000000000000000000000000000000000000004c9edd5852cd905f086c759e8383e09bff1e68b3',
};

const FIX_REVOKE_FUNCTION_ETHENA_USDE_APPROVE: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x66523f7d455448454e415f494e535449545554494f4e414c0000000000000000000000000000000000000000000000004c9edd5852cd905f086c759e8383e09bff1e68b3095ea7b300000000000000000000000000000000000000000000000000000000',
};

const FIX_SCOPE_FUNCTION_ONDO_GM: PlanCall = {
  to: MODIFIER,
  value: '0',
  data: '0x7508dd984f4e444f5f474d000000000000000000000000000000000000000000000000000000000000000000000000002c158bc456e027b2affccadf1bdbd9f5fc4c5c8c445df08b0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000011000000000000000000000000000000000000000000000000000000000000022000000000000000000000000000000000000000000000000000000000000002c00000000000000000000000000000000000000000000000000000000000000360000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000000004c00000000000000000000000000000000000000000000000000000000000000560000000000000000000000000000000000000000000000000000000000000060000000000000000000000000000000000000000000000000000000000000006a0000000000000000000000000000000000000000000000000000000000000074000000000000000000000000000000000000000000000000000000000000007e00000000000000000000000000000000000000000000000000000000000000880000000000000000000000000000000000000000000000000000000000000092000000000000000000000000000000000000000000000000000000000000009c00000000000000000000000000000000000000000000000000000000000000a600000000000000000000000000000000000000000000000000000000000000b200000000000000000000000000000000000000000000000000000000000000be00000000000000000000000000000000000000000000000000000000000000ca000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000000500000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000030000000000000000000000000000000000000000000000000000000000000005000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000700000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000000000000000000000000000000000000200000000000000000000000005c424b9b60383fce7fe7069d2a2b1047bcd04a7300000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000992651bfeb9a0dcc4457610e284ba66d86489d4d00000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000a2ec76139028f279a1c790d323c57cc4158098d600000000000000000000000000000000000000000000000000000000000000070000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000800000000000000000000000000000000000000000000000000000000000000020000000000000000000000000ed3618bb8778f8ebbe2f241da532227591771d04',
};

async function loadSdk(): Promise<DecodeSdk> {
  const mod = (await import('zodiac-roles-sdk')) as unknown as DecodeSdk;
  return { decodeKey: mod.decodeKey, rolesAbi: mod.rolesAbi };
}

describe('decodeCall', () => {
  it('decodes assignRoles into member + roleKeys[] + assigned[]', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall(FIX_ASSIGN_ROLES_ETHENA, sdk);
    expect(decoded.kind).toBe('assignRoles');
    if (decoded.kind !== 'assignRoles') return;
    // EIP-55 checksummed by viem.
    expect(decoded.member.toLowerCase()).toBe('0x4ecb4c676e596a5b2b9084c5aec8fce058ce71a6');
    expect(decoded.roleKeys).toEqual(['ETHENA_INSTITUTIONAL']);
    expect(decoded.assigned).toEqual([false]);
  });

  it('decodes revokeTarget into roleKey + target', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall(FIX_REVOKE_TARGET_ETHENA_USDE, sdk);
    expect(decoded.kind).toBe('revokeTarget');
    if (decoded.kind !== 'revokeTarget') return;
    expect(decoded.roleKey).toBe('ETHENA_INSTITUTIONAL');
    expect(decoded.target.toLowerCase()).toBe('0x4c9edd5852cd905f086c759e8383e09bff1e68b3');
  });

  it('decodes revokeFunction into roleKey + target + fnSelector + fnName(approve)', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall(FIX_REVOKE_FUNCTION_ETHENA_USDE_APPROVE, sdk);
    expect(decoded.kind).toBe('revokeFunction');
    if (decoded.kind !== 'revokeFunction') return;
    expect(decoded.roleKey).toBe('ETHENA_INSTITUTIONAL');
    expect(decoded.target.toLowerCase()).toBe('0x4c9edd5852cd905f086c759e8383e09bff1e68b3');
    expect(decoded.fnSelector).toBe('0x095ea7b3');
    expect(decoded.fnName).toBe('approve');
  });

  it('decodes scopeFunction into roleKey + target + fnSelector; fnName undefined for unknown selector', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall(FIX_SCOPE_FUNCTION_ONDO_GM, sdk);
    expect(decoded.kind).toBe('scopeFunction');
    if (decoded.kind !== 'scopeFunction') return;
    expect(decoded.roleKey).toBe('ONDO_GM');
    expect(decoded.target.toLowerCase()).toBe('0x2c158bc456e027b2affccadf1bdbd9f5fc4c5c8c');
    expect(decoded.fnSelector).toBe('0x445df08b');
    expect(decoded.fnName).toBeUndefined();
  });

  // Fixture from the all-pass repro plan
  // (examples/mainnet/0x40FF…DE58/allpass_safe.plan.json) — the SDK emits
  // `allowFunction` (selector `0xb3dd25c7`) for functions with no calldata
  // condition, i.e. the `if (allPass) return null` optimization in
  // buildPositionalScoping. Role `ALL_PASS`, target USDC, selector
  // `0x1bca4f52` = `tag(bytes32 id, uint256 nonce)`.
  const FIX_ALLOW_FUNCTION_ALL_PASS_TAG: PlanCall = {
    to: MODIFIER,
    value: '0',
    data: '0xb3dd25c7414c4c5f50415353000000000000000000000000000000000000000000000000000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb481bca4f52000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000',
  };

  it('decodes allowFunction (no-condition function permission) into roleKey + target + fnSelector', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall(FIX_ALLOW_FUNCTION_ALL_PASS_TAG, sdk);
    expect(decoded.kind).toBe('allowFunction');
    if (decoded.kind !== 'allowFunction') return;
    expect(decoded.roleKey).toBe('ALL_PASS');
    expect(decoded.target.toLowerCase()).toBe('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48');
    expect(decoded.fnSelector).toBe('0x1bca4f52');
    expect(decoded.fnName).toBeUndefined();
  });

  it('honors caller-provided selectorMap for allowFunction (fnName resolves to the source-defined signature)', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall(FIX_ALLOW_FUNCTION_ALL_PASS_TAG, sdk, { '0x1bca4f52': 'tag' });
    expect(decoded.kind).toBe('allowFunction');
    if (decoded.kind !== 'allowFunction') return;
    expect(decoded.fnName).toBe('tag');
  });

  it('unknown selector → kind=unknown with raw selector + dataLen', async () => {
    const sdk = await loadSdk();
    // `0xdeadbeef` is not in `rolesAbi` → decodeFunctionData throws → fallback.
    const decoded = decodeCall({ to: MODIFIER, value: '0', data: '0xdeadbeef' }, sdk);
    expect(decoded.kind).toBe('unknown');
    if (decoded.kind !== 'unknown') return;
    expect(decoded.selector).toBe('0xdeadbeef');
    expect(decoded.dataLen).toBe(4);
  });

  it('short data (< 4 bytes) → kind=unknown with right-padded bytes4 selector + raw dataLen', async () => {
    const sdk = await loadSdk();
    const decoded = decodeCall({ to: MODIFIER, value: '0', data: '0x0102' }, sdk);
    expect(decoded.kind).toBe('unknown');
    if (decoded.kind !== 'unknown') return;
    // 2 bytes of data → padded out to a full 4-byte selector for display.
    expect(decoded.selector).toBe('0x01020000');
    expect(decoded.dataLen).toBe(2);
  });

  // --- Safe-ABI dispatch (gated on `to === safeAddress`) ---

  const SAFE = '0x40FF9A84a5Da941A060E2925DA228aab328DDe58';
  const GUARD = '0x1234567890123456789012345678901234567890';
  const FALLBACK = '0xabcdefabcdef1234567890123456789012345678';
  const MODULE_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const MODULE_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const PREV_MODULE = '0xcccccccccccccccccccccccccccccccccccccccc';

  const SAFE_ABI = [
    {
      type: 'function',
      name: 'setGuard',
      inputs: [{ type: 'address', name: 'guard' }],
      outputs: [],
    },
    {
      type: 'function',
      name: 'setFallbackHandler',
      inputs: [{ type: 'address', name: 'handler' }],
      outputs: [],
    },
    {
      type: 'function',
      name: 'enableModule',
      inputs: [{ type: 'address', name: 'module' }],
      outputs: [],
    },
    {
      type: 'function',
      name: 'disableModule',
      inputs: [
        { type: 'address', name: 'prevModule' },
        { type: 'address', name: 'module' },
      ],
      outputs: [],
    },
  ] as const;

  function safeCalldata(
    fn: 'setGuard' | 'setFallbackHandler' | 'enableModule' | 'disableModule',
    a: string,
    b?: string,
  ): PlanCall {
    const args = b === undefined ? [a as `0x${string}`] : [a as `0x${string}`, b as `0x${string}`];
    const data = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: fn,
      args: args as never,
    });
    return { to: SAFE, value: '0', data };
  }

  it('decodes setGuard (Safe-ABI) when call.to === safeAddress', async () => {
    const sdk = await loadSdk();
    const call = safeCalldata('setGuard', GUARD);
    const decoded = decodeCall(call, sdk, undefined, SAFE);
    expect(decoded.kind).toBe('setGuard');
    if (decoded.kind !== 'setGuard') return;
    expect(decoded.target.toLowerCase()).toBe(SAFE.toLowerCase());
    expect(decoded.guardAddress.toLowerCase()).toBe(GUARD.toLowerCase());
  });

  it('decodes setFallbackHandler (Safe-ABI) when call.to === safeAddress', async () => {
    const sdk = await loadSdk();
    const call = safeCalldata('setFallbackHandler', FALLBACK);
    const decoded = decodeCall(call, sdk, undefined, SAFE);
    expect(decoded.kind).toBe('setFallbackHandler');
    if (decoded.kind !== 'setFallbackHandler') return;
    expect(decoded.fallbackAddress.toLowerCase()).toBe(FALLBACK.toLowerCase());
  });

  it('decodes enableModule (Safe-ABI) when call.to === safeAddress', async () => {
    const sdk = await loadSdk();
    const call = safeCalldata('enableModule', MODULE_A);
    const decoded = decodeCall(call, sdk, undefined, SAFE);
    expect(decoded.kind).toBe('enableModule');
    if (decoded.kind !== 'enableModule') return;
    expect(decoded.target.toLowerCase()).toBe(SAFE.toLowerCase());
    expect(decoded.moduleAddress.toLowerCase()).toBe(MODULE_A.toLowerCase());
  });

  it('decodes disableModule (Safe-ABI) with prevModule + moduleAddress', async () => {
    const sdk = await loadSdk();
    const call = safeCalldata('disableModule', PREV_MODULE, MODULE_B);
    const decoded = decodeCall(call, sdk, undefined, SAFE);
    expect(decoded.kind).toBe('disableModule');
    if (decoded.kind !== 'disableModule') return;
    expect(decoded.prevModule.toLowerCase()).toBe(PREV_MODULE.toLowerCase());
    expect(decoded.moduleAddress.toLowerCase()).toBe(MODULE_B.toLowerCase());
  });

  it('selector-collision gate: enableModule selector on MODIFIER (to !== safeAddress) decodes via roles path, NOT Safe-ABI', async () => {
    // Both Safe and Roles modifier ABIs expose `enableModule(address)` with
    // the SAME 4-byte selector (0x610b5925). Without the safeAddress gate,
    // a Roles `enableModule` call would misclassify as a Safe call.
    // Encode the calldata against the SAME signature but address the MODIFIER.
    const sdk = await loadSdk();
    const data = encodeFunctionData({
      abi: SAFE_ABI,
      functionName: 'enableModule',
      args: [MODULE_A as `0x${string}`],
    });
    // Selector check — both ABIs share this selector.
    expect(data.slice(0, 10)).toBe('0x610b5925');
    const callToModifier: PlanCall = { to: MODIFIER, value: '0', data };
    // Pass safeAddress (SAFE) — the gate sees to=MODIFIER ≠ SAFE and skips
    // the Safe-ABI path, falling through to the rolesAbi decoder.
    const decoded = decodeCall(callToModifier, sdk, undefined, SAFE);
    // MUST NOT be the Safe-side `enableModule` kind. (Rolesabi may decode
    // this to its own `enableModule` shape with different fields, or to
    // unknown — either way it's NOT the Safe-ABI variant.)
    expect(decoded.kind).not.toBe('setGuard');
    expect(decoded.kind).not.toBe('setFallbackHandler');
    expect(decoded.kind).not.toBe('disableModule');
    // If the roles decoder did surface an enableModule, it would have
    // different fields (no `target` set to SAFE etc.). The critical
    // assertion is no false-positive Safe-side dispatch.
    if (decoded.kind === 'enableModule') {
      // Safe-side variant has target === SAFE (call.to=SAFE). Roles-side
      // (if it ever produces this kind) would have target === MODIFIER.
      // Either the kind isn't 'enableModule' or the target is MODIFIER.
      expect(decoded.target.toLowerCase()).not.toBe(SAFE.toLowerCase());
    }
  });

  it('Safe-ABI dispatch is skipped entirely when safeAddress is undefined (legacy callers)', async () => {
    const sdk = await loadSdk();
    const call = safeCalldata('setGuard', GUARD);
    // No safeAddress argument → no Safe-ABI attempt → falls through to
    // rolesAbi which doesn't define setGuard, producing `unknown`.
    const decoded = decodeCall(call, sdk);
    expect(decoded.kind).toBe('unknown');
  });

  it('decodeKey throws (binary garbage in roleKey bytes) → falls back to raw hex', async () => {
    const sdk = await loadSdk();
    // Wrap decodeKey to throw — exercises the safeDecodeKey try/catch.
    const throwingSdk: DecodeSdk = {
      rolesAbi: sdk.rolesAbi,
      decodeKey: () => {
        throw new Error('binary garbage');
      },
    };
    const decoded = decodeCall(FIX_REVOKE_TARGET_ETHENA_USDE, throwingSdk);
    expect(decoded.kind).toBe('revokeTarget');
    if (decoded.kind !== 'revokeTarget') return;
    // Raw bytes32 hex fallback (case preserved as produced by viem).
    expect(decoded.roleKey.toLowerCase()).toBe(
      '0x455448454e415f494e535449545554494f4e414c000000000000000000000000',
    );
  });
});
