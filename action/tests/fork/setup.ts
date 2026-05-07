/**
 * Fork-test harness: spawn anvil, deploy a fresh Safe + a fresh Roles V2
 * modifier per test, enable the modifier on the Safe, and provide
 * snapshot/restore helpers so the file can hold a single anvil for its whole
 * lifetime.
 *
 * Everything here is verbose by design — every step prints what it's doing
 * so the integration suite reads top-to-bottom in CI logs.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  encodeAbiParameters,
  encodePacked,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { mainnet } from 'viem/chains';
import {
  getSafeSingletonDeployment,
  getProxyFactoryDeployment,
} from '@safe-global/safe-deployments';
import { Roles__factory, Integrity__factory, Packer__factory } from 'zodiac-roles-sdk/typechain';

/** Anvil's first pre-funded key — public knowledge, testing only. */
export const TEST_PRIVATE_KEY: Hex =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

const ANVIL_BINARY = '/Users/isma/.foundry/bin/anvil';
const DEFAULT_FORK_BLOCK = 22_500_000n;
const ANVIL_PORT = 8546;
// Public archive-capable mainnet RPCs to try when MAINNET_RPC_URL isn't set.
// Order matters: we try the user's env first, then drop down this list.
// drpc.org and llamarpc were verified to serve archive state at the pinned
// fork block; merkle.io and publicnode are NOT archive nodes for this block.
const PUBLIC_FALLBACK_RPCS: readonly string[] = [
  'https://eth.drpc.org',
  'https://eth.llamarpc.com',
];

export interface ForkContext {
  rpcUrl: string;
  forkBlock: bigint;
  upstreamRpc: string;
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: PrivateKeyAccount;
}

export interface SafeAndRoles {
  safeAddress: Address;
  rolesAddress: Address;
  packerAddress: Address;
  integrityAddress: Address;
}

let anvilProc: ChildProcess | null = null;
let initialSnapshotId: Hex | null = null;

/**
 * Decide which upstream RPC to fork from. We require an archive-capable node
 * because we pin the fork block in the historical past. Strategy:
 *   1. If MAINNET_RPC_URL is set, prefer that and trust the user picked one
 *      with archive support.
 *   2. Otherwise, walk PUBLIC_FALLBACK_RPCS and pick the first that both
 *      responds to eth_blockNumber AND returns state for the pinned fork
 *      block (eth_getBalance at that block height).
 * Returns null if nothing works, signalling callers to skip gracefully.
 */
export async function pickUpstreamRpc(): Promise<string | null> {
  const envUrl = process.env['MAINNET_RPC_URL'];
  if (typeof envUrl === 'string' && envUrl.length > 0) {
    if (await pingRpc(envUrl)) return envUrl;
  }
  for (const url of PUBLIC_FALLBACK_RPCS) {
    if (!(await pingRpc(url))) continue;
    if (!(await canServeBlock(url, DEFAULT_FORK_BLOCK))) continue;
    return url;
  }
  return null;
}

async function pingRpc(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id: 1 }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string };
    return typeof json.result === 'string' && json.result.startsWith('0x');
  } catch {
    return false;
  }
}

async function canServeBlock(url: string, block: bigint): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_getBalance',
        params: ['0x0000000000000000000000000000000000000000', `0x${block.toString(16)}`],
        id: 1,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const json = (await res.json()) as { result?: string; error?: { message: string } };
    return typeof json.result === 'string' && json.result.startsWith('0x');
  } catch {
    return false;
  }
}

/** Sleep helper — used to wait for anvil to bind its port. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Spawn anvil forking the chosen upstream at DEFAULT_FORK_BLOCK and wait until
 * it accepts RPC. Throws if anvil dies during startup or never becomes ready.
 */
export async function spawnAnvil(upstreamRpc: string): Promise<ForkContext> {
  if (!existsSync(ANVIL_BINARY)) {
    throw new Error(`anvil binary not found at ${ANVIL_BINARY}`);
  }
  const forkBlock = DEFAULT_FORK_BLOCK;
  const rpcUrl = `http://127.0.0.1:${String(ANVIL_PORT)}`;
  console.log(`[fork-setup] spawning anvil`);
  console.log(`[fork-setup]   upstream:    ${upstreamRpc}`);
  console.log(`[fork-setup]   fork block:  ${forkBlock.toString()}`);
  console.log(`[fork-setup]   listen:      ${rpcUrl}`);
  anvilProc = spawn(
    ANVIL_BINARY,
    [
      '--fork-url',
      upstreamRpc,
      '--fork-block-number',
      forkBlock.toString(),
      '--port',
      String(ANVIL_PORT),
      // The Roles V2 mastercopy is larger than EIP-170's 24KB ceiling, so
      // deploying it as a non-proxy on a forked chain hits CreateContractSizeLimit.
      // Mainnet ships the mastercopy via a pre-deploy at a fixed address; we
      // mimic that by lifting the limit on anvil. Keeps the rest of the chain
      // semantics unchanged for everything our tests touch.
      '--disable-code-size-limit',
      '--silent',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let exited = false;
  let exitInfo = '';
  anvilProc.on('exit', (code, signal) => {
    exited = true;
    exitInfo = `code=${String(code)} signal=${String(signal)}`;
  });
  // Capture stderr so we can surface anvil's complaints if startup fails.
  let stderrBuf = '';
  anvilProc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString();
  });

  // Poll eth_blockNumber until anvil answers.
  const account = privateKeyToAccount(TEST_PRIVATE_KEY);
  const publicClient = createPublicClient({ chain: mainnet, transport: http(rpcUrl) });
  const walletClient = createWalletClient({
    chain: mainnet,
    transport: http(rpcUrl),
    account,
  });
  const deadline = Date.now() + 30_000;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(
        `anvil exited during startup (${exitInfo}); stderr:\n${stderrBuf || '(empty)'}`,
      );
    }
    try {
      const bn = await publicClient.getBlockNumber();
      console.log(`[fork-setup] anvil ready at block ${bn.toString()} (signer=${account.address})`);
      return { rpcUrl, forkBlock, upstreamRpc, publicClient, walletClient, account };
    } catch (err) {
      lastErr = err;
      await sleep(250);
    }
  }
  throw new Error(`anvil never became ready: ${String(lastErr)}`);
}

export async function killAnvil(): Promise<void> {
  if (anvilProc && !anvilProc.killed) {
    anvilProc.kill('SIGTERM');
    // Give it a beat to actually die before the process group tears down.
    await sleep(100);
  }
  anvilProc = null;
  initialSnapshotId = null;
}

/**
 * Take an evm_snapshot now and remember it as the "clean" point. Each test
 * calls `revertToInitialSnapshot()` in beforeEach to get back here.
 */
export async function takeInitialSnapshot(ctx: ForkContext): Promise<void> {
  initialSnapshotId = await rpcCall<Hex>(ctx.rpcUrl, 'evm_snapshot', []);
  console.log(`[fork-setup] initial snapshot id=${initialSnapshotId}`);
}

export async function revertToInitialSnapshot(ctx: ForkContext): Promise<void> {
  if (!initialSnapshotId) {
    throw new Error('takeInitialSnapshot must be called before revertToInitialSnapshot');
  }
  const ok = await rpcCall<boolean>(ctx.rpcUrl, 'evm_revert', [initialSnapshotId]);
  if (!ok) throw new Error(`evm_revert returned false for ${initialSnapshotId}`);
  // After a revert the snapshot id is consumed; immediately re-snapshot so
  // subsequent tests can revert again.
  initialSnapshotId = await rpcCall<Hex>(ctx.rpcUrl, 'evm_snapshot', []);
}

async function rpcCall<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  });
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`${method} failed: ${json.error.message}`);
  return json.result as T;
}

// ---------------------------------------------------------------------------
// Safe + Roles deployment
// ---------------------------------------------------------------------------

const SAFE_ABI = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver) external',
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) external returns (bool)',
  'function nonce() external view returns (uint256)',
  'function getThreshold() external view returns (uint256)',
  'function getOwners() external view returns (address[])',
  'function isModuleEnabled(address module) external view returns (bool)',
  'function enableModule(address module) external',
]);

const PROXY_FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address singleton, bytes initializer, uint256 saltNonce) external returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]);

function getSafeAddrs(): { singleton: Address; factory: Address } {
  const singletonDep = getSafeSingletonDeployment({ version: '1.4.1', network: '1' });
  const factoryDep = getProxyFactoryDeployment({ version: '1.4.1', network: '1' });
  if (!singletonDep || !factoryDep) {
    throw new Error('safe v1.4.1 mainnet deployments missing in @safe-global/safe-deployments');
  }
  const singleton = singletonDep.networkAddresses['1'];
  const factory = factoryDep.networkAddresses['1'];
  if (typeof singleton !== 'string' || typeof factory !== 'string') {
    throw new Error('safe v1.4.1 addresses for chainId=1 are not strings');
  }
  return { singleton: singleton as Address, factory: factory as Address };
}

/**
 * Deploy a fresh Safe v1.4.1 proxy whose only owner is `account` and whose
 * threshold is 1. We watch ProxyCreation for the deployed address.
 */
export async function deploySafe(ctx: ForkContext): Promise<Address> {
  const { singleton, factory } = getSafeAddrs();
  console.log(`[fork-setup] deploying Safe v1.4.1 proxy via factory ${factory}`);
  const initializer = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'setup',
    args: [[ctx.account.address], 1n, zeroAddress, '0x', zeroAddress, zeroAddress, 0n, zeroAddress],
  });
  // Salt = current ms timestamp keeps each deploy unique even across tests
  // that don't reset (we still always reset, but defense-in-depth).
  const saltNonce = BigInt(Date.now());
  const hash = await ctx.walletClient.writeContract({
    chain: mainnet,
    account: ctx.account,
    address: factory,
    abi: PROXY_FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [singleton, initializer, saltNonce],
  });
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  // ProxyCreation(address indexed proxy, address singleton)
  const log = receipt.logs.find(
    (l) => l.address.toLowerCase() === factory.toLowerCase() && l.topics[0] !== undefined,
  );
  if (!log || !log.topics[1]) {
    throw new Error('ProxyCreation log not found in receipt');
  }
  // topic[1] is `address proxy` left-padded to 32 bytes.
  const proxyAddr = `0x${log.topics[1].slice(-40)}` as Address;
  console.log(`[fork-setup] Safe deployed at ${proxyAddr}`);
  return proxyAddr;
}

/** Deploy the Integrity / Packer libraries the Roles bytecode is linked against. */
async function deployRolesLibraries(ctx: ForkContext): Promise<{
  integrity: Address;
  packer: Address;
}> {
  console.log(`[fork-setup] deploying Integrity library`);
  const integrityHash = await ctx.walletClient.deployContract({
    chain: mainnet,
    account: ctx.account,
    abi: Integrity__factory.abi,
    bytecode: Integrity__factory.bytecode as Hex,
  });
  const integrityRcpt = await ctx.publicClient.waitForTransactionReceipt({ hash: integrityHash });
  if (!integrityRcpt.contractAddress) throw new Error('Integrity deploy missing contractAddress');
  const integrity = integrityRcpt.contractAddress;
  console.log(`[fork-setup]   Integrity at ${integrity}`);

  console.log(`[fork-setup] deploying Packer library`);
  const packerHash = await ctx.walletClient.deployContract({
    chain: mainnet,
    account: ctx.account,
    abi: Packer__factory.abi,
    bytecode: Packer__factory.bytecode as Hex,
  });
  const packerRcpt = await ctx.publicClient.waitForTransactionReceipt({ hash: packerHash });
  if (!packerRcpt.contractAddress) throw new Error('Packer deploy missing contractAddress');
  const packer = packerRcpt.contractAddress;
  console.log(`[fork-setup]   Packer at ${packer}`);

  return { integrity, packer };
}

/**
 * Deploy a fresh Roles V2 modifier with constructor args
 * (owner=signer, avatar=safe, target=safe).
 */
export async function deployRolesModifier(
  ctx: ForkContext,
  safeAddress: Address,
  libs: { integrity: Address; packer: Address },
): Promise<Address> {
  console.log(
    `[fork-setup] deploying Roles V2 modifier (owner=${ctx.account.address}, avatar=${safeAddress}, target=${safeAddress})`,
  );
  const linked = Roles__factory.linkBytecode({
    'contracts/Integrity.sol:Integrity': libs.integrity,
    'contracts/packers/Packer.sol:Packer': libs.packer,
  });
  // After linking, all __$...$__ placeholders should be replaced by 40-hex
  // address chars. Sanity-check before we ship a doomed deploy.
  if (linked.includes('__$') || linked.includes('$__')) {
    throw new Error(`Roles bytecode still contains library placeholders after link`);
  }
  const hash = await ctx.walletClient.deployContract({
    chain: mainnet,
    account: ctx.account,
    abi: Roles__factory.abi,
    bytecode: linked as Hex,
    args: [ctx.account.address, safeAddress, safeAddress],
  });
  const rcpt = await ctx.publicClient.waitForTransactionReceipt({ hash });
  if (!rcpt.contractAddress) throw new Error('Roles deploy missing contractAddress');
  console.log(`[fork-setup] Roles modifier at ${rcpt.contractAddress}`);
  return rcpt.contractAddress;
}

/**
 * Build a Safe `execTransaction` payload signed with the single owner's
 * pre-validated signature pattern (v=1 means "owner has approved by being
 * the sender"). Threshold-1 single-owner Safe makes this trivial: the
 * message of the transaction needn't actually be signed off-chain because
 * the call is sent on-chain by the owner itself.
 *
 * Returns the writeContract transaction hash.
 */
export async function execAsSafe(
  ctx: ForkContext,
  safeAddress: Address,
  to: Address,
  data: Hex,
  value = 0n,
  operation: 0 | 1 = 0,
): Promise<Hex> {
  // Pre-validated owner signature for Safe v1.4.1's checkNSignatures:
  //   r = owner address, left-padded to 32 bytes (64 hex chars)
  //   s = 32 zero bytes
  //   v = 1  (signals "msg.sender == r" pre-approval; only valid when the
  //          owner is also the on-chain caller, which is true here because
  //          ctx.account is the only owner and the writeContract sender)
  const ownerR = ctx.account.address.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  const sig = `0x${ownerR}${'00'.repeat(32)}01` as Hex;
  return ctx.walletClient.writeContract({
    chain: mainnet,
    account: ctx.account,
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'execTransaction',
    args: [to, value, data, operation, 0n, 0n, 0n, zeroAddress, zeroAddress, sig],
  });
}

/** Enable the Roles modifier on the Safe. */
export async function enableModule(
  ctx: ForkContext,
  safeAddress: Address,
  moduleAddress: Address,
): Promise<void> {
  console.log(`[fork-setup] enabling module ${moduleAddress} on Safe ${safeAddress}`);
  const data = encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'enableModule',
    args: [moduleAddress],
  });
  const hash = await execAsSafe(ctx, safeAddress, safeAddress, data);
  await ctx.publicClient.waitForTransactionReceipt({ hash });
  // Sanity: confirm enabled.
  const enabled = await ctx.publicClient.readContract({
    address: safeAddress,
    abi: SAFE_ABI,
    functionName: 'isModuleEnabled',
    args: [moduleAddress],
  });
  if (!enabled) throw new Error(`enableModule returned but isModuleEnabled() is false`);
  console.log(`[fork-setup]   module enabled OK`);
}

/**
 * Convenience: deploy + configure everything we need, end-to-end. Returns
 * the deployed addresses for use by tests.
 */
export async function deployAndConfigureSafeWithRoles(ctx: ForkContext): Promise<SafeAndRoles> {
  const safeAddress = await deploySafe(ctx);
  const libs = await deployRolesLibraries(ctx);
  const rolesAddress = await deployRolesModifier(ctx, safeAddress, libs);
  await enableModule(ctx, safeAddress, rolesAddress);
  return {
    safeAddress,
    rolesAddress,
    packerAddress: libs.packer,
    integrityAddress: libs.integrity,
  };
}

// Re-export a tiny helper used by tests that need to assert allowance changes.
export const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function transfer(address to, uint256 amount) external returns (bool)',
  'function balanceOf(address account) external view returns (uint256)',
]);

/** Encodes Safe's enableModule selector + arg — used in setup. Exported for tests. */
export function encodeEnableModuleData(module: Address): Hex {
  return encodeFunctionData({
    abi: SAFE_ABI,
    functionName: 'enableModule',
    args: [module],
  });
}

// `encodeAbiParameters` and `encodePacked` are re-exported as utilities that
// fork tests use without re-importing them everywhere.
export { encodeAbiParameters, encodePacked };
