// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

// Canonical Ethereum mainnet addresses for contract fork tests. Centralized here so fork tests
// import rather than re-declare. As fork coverage expands to other chains, add sibling files
// (e.g. BaseAddresses.sol) rather than overloading this one.

/// @dev Safe v1.4.1 singleton (mastercopy). safe-global/safe-deployments, 1.4.1, chainId 1.
address constant SAFE_SINGLETON_V1_4_1 = 0x41675C099F32341bf84BFc5382aF534df5C7461a;

/// @dev Safe v1.4.1 proxy factory. safe-global/safe-deployments, 1.4.1, chainId 1.
address constant SAFE_PROXY_FACTORY_V1_4_1 = 0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67;

/// @dev Aave V3 Pool — Ethereum Core market. https://aave.com/docs/resources/addresses
address constant AAVE_V3_POOL = 0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2;

/// @dev Morpho Blue singleton. https://docs.morpho.org/getting-started/resources/addresses
address constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;

/// @dev USDC (6 decimals). Circle, Ethereum mainnet.
address constant USDC = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
