// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IBaselineWallet {
    event Paid(address indexed to, uint256 amount);
    event DailyCapChanged(uint256 oldCap, uint256 newCap);

    error OnlyAgent();
    error OnlyOperator();
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);

    function cash() external view returns (IERC20);
    function operator() external view returns (address);
    function agent() external view returns (address);
    function dailyCap() external view returns (uint256);
    function spentToday() external view returns (uint256);

    function pay(address to, uint256 amount) external;   // agent only
    function setDailyCap(uint256 newCap) external;       // operator only
}
// constructor(IERC20 cash, address operator, address agent, uint256 dailyCap)
