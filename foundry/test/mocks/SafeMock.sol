// SPDX-License-Identifier: MIT
pragma solidity 0.8.34;

/// @title  SafeMock
/// @notice Minimal Safe module-execution surface.
/// @dev    Reproduces the one Safe behaviour the NAV manager depends on: a call issued by an enabled module
///         executes with the Safe as `msg.sender`. Everything the manager does to Maple relies on that -- Maple's
///         pools are permissioned on the caller -- so a mock that merely forwarded from itself would test the
///         wrong caller identity.
contract SafeMock {
    mapping(address => bool) public modules;

    error NotAModule(address caller);

    receive() external payable {}

    function enableModule(address module_) external {
        modules[module_] = true;
    }

    function disableModule(address module_) external {
        modules[module_] = false;
    }

    /// @notice Executes a call from the Safe on behalf of an enabled module.
    /// @dev `operation` is accepted and ignored: the manager only ever issues CALL (0).
    function execTransactionFromModule(address to_, uint256 value_, bytes calldata data_, uint8)
        external
        returns (bool success)
    {
        if (!modules[msg.sender]) revert NotAModule(msg.sender);
        // solhint-disable-next-line avoid-low-level-calls
        (success,) = to_.call{value: value_}(data_);
    }
}
