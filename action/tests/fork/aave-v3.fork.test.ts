/**
 * Forked-mainnet integration test: deploy a fresh Safe + Roles V2 modifier,
 * apply a narrow USDC.approve(AAVE_pool, *) role, then assert:
 *
 *   1. Member can approve the AAVE pool       (happy path).
 *   2. Approving a non-AAVE spender reverts   (ParameterNotAllowed).
 *   3. Calling on DAI (not in the role)       (TargetAddressNotAllowed).
 *   4. Calling transfer() instead of approve  (FunctionNotAllowed).
 *
 * Verbose by design — every step prints what it's doing.
 *
 * Skips cleanly if no upstream RPC is reachable.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { encodeFunctionData, toFunctionSelector, type Address, type Hex } from 'viem';
import { mainnet } from 'viem/chains';
import { parseGenerated, type Generated } from '../../apply/parseGenerated';
import { rolesExecAbi } from './rolesAbi';
import {
  ERC20_ABI,
  TEST_PRIVATE_KEY,
  deployAndConfigureSafeWithRoles,
  killAnvil,
  pickUpstreamRpc,
  revertToInitialSnapshot,
  spawnAnvil,
  takeInitialSnapshot,
  type ForkContext,
  type SafeAndRoles,
} from './setup';
import { applyGeneratedOnFork, decodeRolesRevert, rebindAddresses } from './applyOnFork';

const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const DAI: Address = '0x6B175474E89094C44Da98b954EedeAC495271d0F';
const AAVE_V3_POOL: Address = '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2';
// Lowercase non-checksum form keeps viem's checksum validator happy; the
// modifier doesn't care, only equality vs the configured value matters.
const ATTACKER: Address = '0xdeadbeef00000000000000000000000000000000';

// A second pre-funded anvil signer (index #1). We use this as the role
// member so it's distinct from the deployer/owner key.
const MEMBER_PRIVATE_KEY: Hex =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
// Public address derived from MEMBER_PRIVATE_KEY (anvil account #1).
const MEMBER_ADDRESS: Address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const FIXTURE_PATH = join(__dirname, 'fixtures', 'aave_usdc_only.yaml');

let ctx: ForkContext | null = null;
let deployed: SafeAndRoles | null = null;
let appliedGenerated: Generated | null = null;
let roleKey: Hex = '0x';

const skipReason = 'MAINNET_RPC_URL not set and public fallback unreachable; skipping fork suite';

describe('fork: AAVE V3 USDC role on mainnet fork', () => {
  beforeAll(async () => {
    const upstream = await pickUpstreamRpc();
    if (upstream === null) {
      console.warn(`[fork] ${skipReason}`);
      return;
    }
    ctx = await spawnAnvil(upstream);
    await takeInitialSnapshot(ctx);
  });

  afterAll(async () => {
    await killAnvil();
  });

  beforeEach(async () => {
    if (!ctx) return;
    // Roll the chain back to the initial fork state so each test starts clean.
    await revertToInitialSnapshot(ctx);
    // Re-deploy Safe + modifier and re-apply the role on the fresh state.
    deployed = await deployAndConfigureSafeWithRoles(ctx);
    const fixtureRaw = readFileSync(FIXTURE_PATH, 'utf8');
    console.log(`[fork] fixture YAML:\n${fixtureRaw.replace(/^/gm, '    ')}`);
    const baseGenerated = parseGenerated(FIXTURE_PATH);
    appliedGenerated = rebindAddresses(baseGenerated, deployed.safeAddress, deployed.rolesAddress);
    // Patch the member to the actual on-fork member key (the YAML is a
    // placeholder address; a real apply scenario would have the correct
    // address baked in already).
    const roleName = Object.keys(appliedGenerated.roles)[0];
    if (typeof roleName !== 'string') throw new Error('fixture must have at least one role');
    const role = appliedGenerated.roles[roleName];
    if (!role) throw new Error(`role ${roleName} missing after rebind`);
    role.members = [MEMBER_ADDRESS];
    const sdk = await import('zodiac-roles-sdk');
    roleKey = sdk.encodeKey(roleName);
    console.log(`[fork] roleKey for "${roleName}" = ${roleKey}`);
    await applyGeneratedOnFork(ctx, appliedGenerated);
    // Fund the member with ETH so they can submit transactions.
    await fundMember(ctx);
    // Give the avatar a USDC balance + ourselves USDC for verifying allowance
    // changes — done via anvil_setStorageAt on USDC's balance slot.
    await impersonateUsdcBalance(ctx, deployed.safeAddress, 1_000_000_000n);
    console.log(
      `[fork] beforeEach done; safe=${deployed.safeAddress} modifier=${deployed.rolesAddress}`,
    );
  });

  it('happy: USDC.approve(AAVE_pool, X) succeeds and updates allowance', async () => {
    if (!ctx || !deployed || !appliedGenerated) {
      console.warn(`[fork] ${skipReason}`);
      return;
    }
    const amount = 1_000_000n; // 1 USDC (6 decimals)
    const approveData = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [AAVE_V3_POOL, amount],
    });
    console.log(
      `[scenario:happy] member ${MEMBER_ADDRESS} attempts approve(spender=${AAVE_V3_POOL}, amount=${amount.toString()}) on USDC ${USDC}`,
    );
    console.log(`[scenario:happy] expected outcome: success`);
    const hash = await callViaRole(ctx, deployed.rolesAddress, USDC, approveData);
    const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
    expect(rcpt.status).toBe('success');
    const allowance = await ctx.publicClient.readContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [deployed.safeAddress, AAVE_V3_POOL],
    });
    console.log(`[scenario:happy] actual outcome: success, allowance=${allowance.toString()}`);
    expect(allowance).toBe(amount);
  });

  it('fails: wrong spender reverts with ParameterNotAllowed', async () => {
    if (!ctx || !deployed) {
      console.warn(`[fork] ${skipReason}`);
      return;
    }
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [ATTACKER, 1n],
    });
    console.log(
      `[scenario:bad-spender] member calls approve(spender=${ATTACKER}, 1) on USDC; expected ParameterNotAllowed`,
    );
    const decoded = await callViaRoleExpectingRevert(ctx, deployed.rolesAddress, USDC, data);
    console.log(`[scenario:bad-spender] actual outcome: revert ${describeRevert(decoded)}`);
    expect(decoded.kind).toBe('ConditionViolation');
    if (decoded.kind === 'ConditionViolation') {
      expect(decoded.statusName).toBe('ParameterNotAllowed');
    }
  });

  it('fails: wrong target (DAI) reverts with TargetAddressNotAllowed', async () => {
    if (!ctx || !deployed) {
      console.warn(`[fork] ${skipReason}`);
      return;
    }
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [AAVE_V3_POOL, 1n],
    });
    console.log(
      `[scenario:bad-target] member calls approve(${AAVE_V3_POOL}, 1) on DAI ${DAI}; expected TargetAddressNotAllowed`,
    );
    const decoded = await callViaRoleExpectingRevert(ctx, deployed.rolesAddress, DAI, data);
    console.log(`[scenario:bad-target] actual outcome: revert ${describeRevert(decoded)}`);
    expect(decoded.kind).toBe('ConditionViolation');
    if (decoded.kind === 'ConditionViolation') {
      expect(decoded.statusName).toBe('TargetAddressNotAllowed');
    }
  });

  it('fails: wrong function (USDC.transfer) reverts with FunctionNotAllowed', async () => {
    if (!ctx || !deployed) {
      console.warn(`[fork] ${skipReason}`);
      return;
    }
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: 'transfer',
      args: [ATTACKER, 1n],
    });
    const transferSelector = toFunctionSelector('transfer(address,uint256)');
    console.log(
      `[scenario:bad-fn] member calls USDC.transfer(${ATTACKER}, 1) (selector ${transferSelector}); expected FunctionNotAllowed`,
    );
    const decoded = await callViaRoleExpectingRevert(ctx, deployed.rolesAddress, USDC, data);
    console.log(`[scenario:bad-fn] actual outcome: revert ${describeRevert(decoded)}`);
    expect(decoded.kind).toBe('ConditionViolation');
    if (decoded.kind === 'ConditionViolation') {
      expect(decoded.statusName).toBe('FunctionNotAllowed');
    }
  });
});

// ---------------------------------------------------------------------------
// helpers used only by this test file
// ---------------------------------------------------------------------------

function describeRevert(decoded: ReturnType<typeof decodeRolesRevert>): string {
  switch (decoded.kind) {
    case 'ConditionViolation':
      return `ConditionViolation(status=${String(decoded.status)} ${decoded.statusName})`;
    case 'OtherError':
      return `${decoded.name}()`;
    case 'Unknown':
      return `Unknown(${decoded.data.slice(0, 10)}…)`;
  }
}

async function callViaRole(
  ctx: ForkContext,
  modifier: Address,
  target: Address,
  data: Hex,
): Promise<Hex> {
  // The member is a separate signer from ctx.account; build a wallet for it.
  const { createWalletClient, http, privateKeyToAccount } = await loadViem();
  const memberAccount = privateKeyToAccount(MEMBER_PRIVATE_KEY);
  const wallet = createWalletClient({
    chain: mainnet,
    transport: http(ctx.rpcUrl),
    account: memberAccount,
  });
  return wallet.writeContract({
    chain: mainnet,
    account: memberAccount,
    address: modifier,
    abi: rolesExecAbi,
    functionName: 'execTransactionWithRole',
    args: [target, 0n, data, 0, roleKey, true /* shouldRevert */],
  });
}

/**
 * Same as callViaRole but expects the call to revert; returns the decoded
 * Roles error for assertions.
 */
async function callViaRoleExpectingRevert(
  ctx: ForkContext,
  modifier: Address,
  target: Address,
  data: Hex,
): ReturnType<typeof decodeRolesRevert> extends infer R ? Promise<Awaited<R>> : never {
  const { createPublicClient, http, privateKeyToAccount } = await loadViem();
  const memberAccount = privateKeyToAccount(MEMBER_PRIVATE_KEY);
  const pub = createPublicClient({ chain: mainnet, transport: http(ctx.rpcUrl) });
  // simulateContract throws on revert with a `data` we can decode.
  try {
    await pub.simulateContract({
      account: memberAccount,
      address: modifier,
      abi: rolesExecAbi,
      functionName: 'execTransactionWithRole',
      args: [target, 0n, data, 0, roleKey, true],
    });
    throw new Error('expected revert but call succeeded');
  } catch (err) {
    const data = extractRevertData(err);
    return decodeRolesRevert(data) as never;
  }
}

function extractRevertData(err: unknown): Hex {
  // Walk viem's nested error chain looking for a `data` field that's a hex string.
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (typeof cursor === 'object' && cursor !== null) {
      const obj = cursor as Record<string, unknown>;
      const d = obj['data'];
      if (typeof d === 'string' && d.startsWith('0x')) return d as Hex;
      if (typeof d === 'object' && d !== null) {
        const nested = (d as Record<string, unknown>)['data'];
        if (typeof nested === 'string' && nested.startsWith('0x')) return nested as Hex;
      }
      cursor = obj['cause'];
    } else {
      break;
    }
  }
  throw new Error(`no revert data found on error: ${String(err)}`);
}

async function fundMember(ctx: ForkContext): Promise<void> {
  // Top up the member with 10 ETH via anvil_setBalance so they can pay gas.
  const tenEth = `0x${(10n * 10n ** 18n).toString(16)}`;
  await ctx.publicClient.request({
    method: 'anvil_setBalance' as const,
    params: [MEMBER_ADDRESS, tenEth],
  } as never);
  console.log(`[fork] funded member ${MEMBER_ADDRESS} with 10 ETH`);
}

/**
 * Mainnet USDC's balanceOf is implemented in the proxy delegating to a v2
 * implementation; balances live at slot 9 keyed by holder address. We
 * overwrite the holder's balance directly via anvil_setStorageAt — much
 * simpler than spinning up a real swap.
 */
async function impersonateUsdcBalance(
  ctx: ForkContext,
  holder: Address,
  amount: bigint,
): Promise<void> {
  // USDC is a Fiat Token v2 proxy: balances live in mapping(address => uint256)
  // at slot 9 of the implementation. Slot key for `balances[holder]` is
  // keccak256(abi.encode(holder, 9)) — i.e. 32-byte left-padded address
  // concatenated with the 32-byte slot index.
  const { keccak256, encodeAbiParameters, pad, toHex } = await loadViem();
  const slot = keccak256(
    encodeAbiParameters(
      [
        { type: 'address', name: 'holder' },
        { type: 'uint256', name: 'slot' },
      ],
      [holder, 9n],
    ),
  );
  const value = pad(toHex(amount), { size: 32 });
  await ctx.publicClient.request({
    method: 'anvil_setStorageAt' as const,
    params: [USDC, slot, value],
  } as never);
  // Confirm by reading balanceOf back — if our slot is wrong this surfaces
  // immediately instead of confusing later assertions.
  const got = await ctx.publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [holder],
  });
  console.log(`[fork] USDC.balanceOf(${holder}) = ${got.toString()} (set to ${amount.toString()})`);
  if (got !== amount) {
    throw new Error(`USDC balance set failed: got ${got.toString()} want ${amount.toString()}`);
  }
}

// Tiny in-test wrapper to avoid top-level await constraints with vitest's loader.
async function loadViem(): Promise<typeof import('viem') & typeof import('viem/accounts')> {
  const [v, a] = await Promise.all([import('viem'), import('viem/accounts')]);
  return { ...v, ...a } as typeof import('viem') & typeof import('viem/accounts');
}

// `MEMBER_PRIVATE_KEY` is unused if a test skips; keep eslint quiet by
// referencing it once at module scope.
void TEST_PRIVATE_KEY;
