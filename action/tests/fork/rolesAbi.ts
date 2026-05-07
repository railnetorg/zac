/**
 * Minimal ABI surface used by the fork tests:
 *  - execTransactionWithRole / execTransactionWithRoleReturnData (member entrypoint)
 *  - the custom errors emitted on permission violations, so we can decode
 *    the Status enum out of revert data and assert against it.
 *
 * The full Roles ABI is also exported by `zodiac-roles-sdk` (`rolesAbi`) and
 * is used in applyOnFork.ts for decoding scoping calls. We keep this trimmed
 * version separate so tests can pin exactly the surface they assert against.
 */
export const rolesExecAbi = [
  {
    type: 'function',
    name: 'execTransactionWithRole',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'roleKey', type: 'bytes32' },
      { name: 'shouldRevert', type: 'bool' },
    ],
    outputs: [{ name: 'success', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'execTransactionWithRoleReturnData',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
      { name: 'operation', type: 'uint8' },
      { name: 'roleKey', type: 'bytes32' },
      { name: 'shouldRevert', type: 'bool' },
    ],
    outputs: [
      { name: 'success', type: 'bool' },
      { name: 'returnData', type: 'bytes' },
    ],
  },
  {
    type: 'function',
    name: 'assignRoles',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'module', type: 'address' },
      { name: 'roleKeys', type: 'bytes32[]' },
      { name: 'memberOf', type: 'bool[]' },
    ],
    outputs: [],
  },
  // ConditionViolation(Status,bytes32) is the canonical revert when a member
  // call doesn't satisfy a function's scoping condition. The Status enum is
  // exported by zodiac-roles-deployments; the trailing bytes32 is an internal
  // tag (the failing condition's location).
  {
    type: 'error',
    name: 'ConditionViolation',
    inputs: [
      { name: 'status', type: 'uint8' },
      { name: 'info', type: 'bytes32' },
    ],
  },
  // Other Roles errors that surface in our negative tests:
  { type: 'error', name: 'NoMembership', inputs: [] },
  { type: 'error', name: 'ModuleTransactionFailed', inputs: [] },
] as const;
