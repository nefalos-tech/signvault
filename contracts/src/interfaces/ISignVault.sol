// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface ISignVault {
    struct Payee { address to; uint256 amount; }

    event Paid(address indexed to, uint256 amount, uint256 indexed period);
    event PayeeSet(address indexed to, uint256 amount, uint256 nonce);

    error OnlyAgent();
    error NotOnTheList(address to);
    error AlreadyPaidThisPeriod(address to);
    error OwnerApprovalRequired();

    function cash() external view returns (IERC20);
    function owner() external view returns (address);
    function agent() external view returns (address);
    function startTime() external view returns (uint64);
    function periodSeconds() external view returns (uint64);
    function currentPeriod() external view returns (uint256);
    function nonce() external view returns (uint256);
    function amountOf(address to) external view returns (uint256);   // 0 means not on the list
    function paidInPeriod(address to, uint256 period) external view returns (bool);
    function payees() external view returns (Payee[] memory);

    function pay(address to) external;                                               // agent only
    function setPayee(address to, uint256 amount, bytes calldata approval) external; // anyone may relay
}
// constructor(IERC20 cash, address owner, address agent, uint64 periodSeconds, Payee[] memory initial)
