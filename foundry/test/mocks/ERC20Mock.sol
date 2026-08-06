// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title  ERC20Mock
/// @notice Mintable ERC-20 with configurable decimals, so tests can exercise the 6-decimal USDC case.
contract ERC20Mock is ERC20 {
    uint8 internal immutable DECIMALS;

    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        DECIMALS = decimals_;
    }

    function mint(address to, uint256 amount) public {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) public {
        _burn(from, amount);
    }

    function decimals() public view override returns (uint8) {
        return DECIMALS;
    }
}
