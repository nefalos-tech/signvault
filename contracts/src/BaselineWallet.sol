// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBaselineWallet} from "./interfaces/IBaselineWallet.sol";

contract BaselineWallet is IBaselineWallet {
    using SafeERC20 for IERC20;

    IERC20 public immutable cash;
    address public immutable operator;
    address public immutable agent;
    uint256 public dailyCap;

    mapping(uint256 day => uint256 spent) private _spentOn;

    constructor(IERC20 cash_, address operator_, address agent_, uint256 dailyCap_) {
        cash = cash_;
        operator = operator_;
        agent = agent_;
        dailyCap = dailyCap_;
    }

    function spentToday() external view returns (uint256) {
        return _spentOn[_today()];
    }

    function pay(address to, uint256 amount) external {
        if (msg.sender != agent) revert OnlyAgent();
        uint256 day = _today();
        uint256 wouldSpend = _spentOn[day] + amount;
        if (wouldSpend > dailyCap) revert DailyCapExceeded(wouldSpend, dailyCap);
        _spentOn[day] = wouldSpend;
        cash.safeTransfer(to, amount);
        emit Paid(to, amount);
    }

    function setDailyCap(uint256 newCap) external {
        if (msg.sender != operator) revert OnlyOperator();
        emit DailyCapChanged(dailyCap, newCap);
        dailyCap = newCap;
    }

    function _today() private view returns (uint256) {
        return block.timestamp / 1 days;
    }
}
