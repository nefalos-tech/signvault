// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {TBillSignVault} from "./TBillSignVault.sol";

/// TBillSignVault with a tripwire. The agent can pull every T-bill share back to cash and lock
/// sweeping; only an owner approval unlocks it.
contract TripwireVault is TBillSignVault {
    using SafeERC20 for IERC20;

    bytes32 public constant REARM_TYPEHASH = keccak256("Rearm(uint256 nonce)");

    bool public tripped;

    error SweepLocked();

    event Tripped(uint256 shares, uint256 assets);
    event Rearmed(uint256 nonce);

    constructor(
        IERC20 cash_,
        address owner_,
        address agent_,
        uint64 periodSeconds_,
        Payee[] memory initial,
        IERC4626 tbill_
    ) TBillSignVault(cash_, owner_, agent_, periodSeconds_, initial, tbill_) {}

    function trip() external {
        if (msg.sender != agent) revert OnlyAgent();
        uint256 shares = tbill.balanceOf(address(this));
        uint256 assets = tbill.redeem(shares, address(this), address(this));
        tripped = true;
        emit Tripped(shares, assets);
    }

    /// Shares the nonce with setPayee, so each owner approval is spent once, whichever kind it is.
    function rearm(bytes calldata approval) external {
        uint256 signedNonce = nonce;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(REARM_TYPEHASH, signedNonce)));
        if (!_isOwnerApproval(digest, approval)) revert OwnerApprovalRequired();

        nonce = signedNonce + 1;
        tripped = false;
        emit Rearmed(signedNonce);
    }

    /// TBillSignVault.sweep is external, so it cannot be reached through super: same rules, plus the lock.
    function sweep(uint256 assets) external override {
        if (tripped) revert SweepLocked();
        if (msg.sender != agent) revert OnlyAgent();
        uint256 available = cash.balanceOf(address(this));
        uint256 owed = owedThisPeriod();
        if (assets > available || available - assets < owed) revert SweepDipsIntoPayroll(assets, available, owed);

        cash.forceApprove(address(tbill), assets);
        tbill.deposit(assets, address(this));
    }
}
