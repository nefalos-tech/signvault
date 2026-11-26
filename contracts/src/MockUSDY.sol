// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {MockUSD} from "./MockUSD.sol";

/// A tokenized T-bill over mUSD. `accrue` mints real mUSD into the pool, so the share price rises
/// and every share still redeems for mUSD the pool holds. Open to anyone, like `MockUSD.mint`.
contract MockUSDY is ERC4626 {
    constructor(MockUSD usd) ERC20("Mock USDY", "mUSDY") ERC4626(usd) {}

    function accrue(uint256 yield) external {
        MockUSD(asset()).mint(address(this), yield);
    }
}
