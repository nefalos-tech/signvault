// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {IBaselineWallet} from "../src/interfaces/IBaselineWallet.sol";
import {BaselineWallet} from "../src/BaselineWallet.sol";
import {MockUSD} from "../src/MockUSD.sol";

contract BaselineWalletTest is Test {
    uint256 constant INVOICE = 0.01e18;
    uint256 constant STARTING_BALANCE = 10e18;

    address operator = makeAddr("operator");
    address agent = makeAddr("agent");
    address vendor1 = vm.addr(uint256(keccak256("signvault.vendor1")));
    address vendor2 = vm.addr(uint256(keccak256("signvault.vendor2")));
    address vendor3 = vm.addr(uint256(keccak256("signvault.vendor3")));
    address attacker = vm.addr(uint256(keccak256("signvault.attacker")));

    MockUSD musd;
    BaselineWallet wallet;

    function setUp() public {
        musd = new MockUSD();
        wallet = new BaselineWallet(musd, operator, agent, INVOICE);
        musd.mint(address(wallet), STARTING_BALANCE);
    }

    function test_AgentCanPayWithinTheCap() public {
        vm.expectEmit(address(wallet));
        emit IBaselineWallet.Paid(vendor1, INVOICE);
        vm.prank(agent);
        wallet.pay(vendor1, INVOICE);

        assertEq(musd.balanceOf(vendor1), INVOICE);
        assertEq(musd.balanceOf(address(wallet)), STARTING_BALANCE - INVOICE);
        assertEq(wallet.spentToday(), INVOICE);

        vm.prank(operator);
        vm.expectRevert(IBaselineWallet.OnlyAgent.selector);
        wallet.pay(operator, INVOICE);
    }

    function test_PayOverTheCapIsRefused() public {
        vm.startPrank(agent);
        wallet.pay(vendor1, INVOICE);

        vm.expectRevert(abi.encodeWithSelector(IBaselineWallet.DailyCapExceeded.selector, 2 * INVOICE, INVOICE));
        wallet.pay(vendor2, INVOICE);

        vm.warp(block.timestamp + 1 days);
        assertEq(wallet.spentToday(), 0);
        wallet.pay(vendor2, INVOICE);
        vm.stopPrank();

        assertEq(musd.balanceOf(vendor2), INVOICE);
    }

    function test_OnlyOperatorCanChangeTheCap() public {
        vm.prank(agent);
        vm.expectRevert(IBaselineWallet.OnlyOperator.selector);
        wallet.setDailyCap(STARTING_BALANCE);

        vm.expectEmit(address(wallet));
        emit IBaselineWallet.DailyCapChanged(INVOICE, STARTING_BALANCE);
        vm.prank(operator);
        wallet.setDailyCap(STARTING_BALANCE);

        assertEq(wallet.dailyCap(), STARTING_BALANCE);
    }

    function test_AfterACapRaiseTheAgentCanDrainIt() public {
        vm.prank(agent);
        wallet.pay(vendor1, INVOICE);

        vm.prank(operator);
        wallet.setDailyCap(STARTING_BALANCE);

        vm.startPrank(agent);
        wallet.pay(vendor2, INVOICE);
        wallet.pay(vendor3, INVOICE);
        wallet.pay(attacker, musd.balanceOf(address(wallet)));
        vm.stopPrank();

        assertEq(musd.balanceOf(address(wallet)), 0);
        assertEq(musd.balanceOf(attacker), STARTING_BALANCE - 3 * INVOICE);
        assertEq(wallet.spentToday(), STARTING_BALANCE);
    }
}
