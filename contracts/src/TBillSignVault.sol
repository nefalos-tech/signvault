// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {SignVault} from "./SignVault.sol";

/// SignVault plus a T-bill sleeve. The agent may move spare cash into `tbill` and back, and nowhere
/// else: deposits and redemptions always name this vault as receiver and owner.
contract TBillSignVault is SignVault {
    using SafeERC20 for IERC20;

    error SweepDipsIntoPayroll(uint256 assets, uint256 available, uint256 owed);

    IERC4626 public immutable tbill;

    constructor(
        IERC20 cash_,
        address owner_,
        address agent_,
        uint64 periodSeconds_,
        Payee[] memory initial,
        IERC4626 tbill_
    ) SignVault(cash_, owner_, agent_, periodSeconds_, initial) {
        tbill = tbill_;
    }

    /// The cash floor: what listed payees not yet paid this period are owed.
    function owedThisPeriod() public view returns (uint256 owed) {
        Payee[] memory list = this.payees();
        uint256 period = currentPeriod();
        for (uint256 i; i < list.length; i++) {
            if (!paidInPeriod[list[i].to][period]) owed += list[i].amount;
        }
    }

    function sweep(uint256 assets) external virtual {
        if (msg.sender != agent) revert OnlyAgent();
        uint256 available = cash.balanceOf(address(this));
        uint256 owed = owedThisPeriod();
        if (assets > available || available - assets < owed) revert SweepDipsIntoPayroll(assets, available, owed);

        cash.forceApprove(address(tbill), assets);
        tbill.deposit(assets, address(this));
    }

    function redeem(uint256 shares) external {
        if (msg.sender != agent) revert OnlyAgent();
        tbill.redeem(shares, address(this), address(this));
    }
}
