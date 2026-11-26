// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockUSDY} from "../src/MockUSDY.sol";
import {TBillSignVault} from "../src/TBillSignVault.sol";

contract TBillSignVaultTest is Test {
    uint256 constant AMOUNT = 10_000_000_000_000_000;
    uint256 constant FUNDS = 10_000_000_000_000_000_000;
    uint256 constant OWED = 3 * AMOUNT; // vendor1 is owed AMOUNT, vendor2 2 * AMOUNT
    uint256 constant SPARE = FUNDS - OWED;
    uint64 constant PERIOD = 1 days;
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant SET_PAYEE_TYPEHASH = keccak256("SetPayee(address to,uint256 amount,uint256 nonce)");

    MockUSD usd;
    MockUSDY usdy;
    TBillSignVault vault;
    address owner;
    uint256 ownerKey;
    address agent;
    address vendor1;
    address vendor2;
    address vendor3;
    address stranger;

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        agent = makeAddr("agent");
        vendor1 = makeAddr("vendor1");
        vendor2 = makeAddr("vendor2");
        vendor3 = makeAddr("vendor3");
        stranger = makeAddr("stranger");
        usd = new MockUSD();
        usdy = new MockUSDY(usd);
        ISignVault.Payee[] memory list = new ISignVault.Payee[](2);
        list[0] = ISignVault.Payee(vendor1, AMOUNT);
        list[1] = ISignVault.Payee(vendor2, 2 * AMOUNT);
        vault = new TBillSignVault(usd, owner, agent, PERIOD, list, usdy);
        usd.mint(address(vault), FUNDS);
    }

    function test_SweepThatDipsIntoPayrollIsRefused() public {
        assertEq(vault.owedThisPeriod(), OWED);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, SPARE + 1, FUNDS, OWED));
        vault.sweep(SPARE + 1);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, FUNDS + 1, FUNDS, OWED));
        vault.sweep(FUNDS + 1);

        assertEq(usd.balanceOf(address(vault)), FUNDS);
        assertEq(usdy.balanceOf(address(vault)), 0);
    }

    function test_AgentCanSweepSpareCash() public {
        vm.prank(agent);
        vault.sweep(SPARE);

        assertEq(usd.balanceOf(address(vault)), OWED);
        assertEq(usdy.convertToAssets(usdy.balanceOf(address(vault))), SPARE);

        vm.startPrank(agent);
        vault.pay(vendor1);
        vault.pay(vendor2);
        vm.stopPrank();
        assertEq(usd.balanceOf(vendor1), AMOUNT);
        assertEq(usd.balanceOf(vendor2), 2 * AMOUNT);
    }

    function test_OnlyAgentCanSweepOrRedeem() public {
        address[2] memory others = [stranger, owner];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OnlyAgent.selector));
            vault.sweep(1);
        }
        vm.prank(agent);
        vault.sweep(SPARE);
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OnlyAgent.selector));
            vault.redeem(1);
        }
    }

    function test_RedeemBringsCashBack() public {
        vm.prank(agent);
        vault.sweep(SPARE);
        uint256 shares = usdy.balanceOf(address(vault));

        vm.prank(agent);
        vault.redeem(shares / 2);
        assertEq(usd.balanceOf(address(vault)), OWED + SPARE / 2);

        vm.prank(agent);
        vault.redeem(shares - shares / 2);
        assertEq(usd.balanceOf(address(vault)), FUNDS);
        assertEq(usdy.balanceOf(address(vault)), 0);
    }

    function test_FloorCountsOnlyPayeesNotYetPaidThisPeriod() public {
        vm.prank(agent);
        vault.pay(vendor1);
        assertEq(vault.owedThisPeriod(), 2 * AMOUNT);

        vm.prank(agent);
        vault.sweep(FUNDS - AMOUNT - 2 * AMOUNT);
        assertEq(usd.balanceOf(address(vault)), 2 * AMOUNT);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, 1, 2 * AMOUNT, 2 * AMOUNT));
        vault.sweep(1);

        // A new period owes everyone again, so nothing more can be swept until cash comes back.
        vm.warp(vault.startTime() + PERIOD);
        assertEq(vault.owedThisPeriod(), OWED);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, 0, 2 * AMOUNT, OWED));
        vault.sweep(0);
    }

    function test_FloorFollowsTheOwnersList() public {
        vault.setPayee(vendor3, 5 * AMOUNT, _sign(vendor3, 5 * AMOUNT, 0));
        assertEq(vault.owedThisPeriod(), 8 * AMOUNT);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, SPARE, FUNDS, 8 * AMOUNT));
        vault.sweep(SPARE);

        vault.setPayee(vendor2, 0, _sign(vendor2, 0, 1));
        assertEq(vault.owedThisPeriod(), 6 * AMOUNT);
        vm.prank(agent);
        vault.sweep(FUNDS - 6 * AMOUNT);
        assertEq(usd.balanceOf(address(vault)), 6 * AMOUNT);
    }

    function test_SharesAreWorthMoreAfterAccrual() public {
        vm.prank(agent);
        vault.sweep(SPARE);
        uint256 shares = usdy.balanceOf(address(vault));
        uint256 yield = SPARE / 20;

        vm.prank(stranger);
        usdy.accrue(yield);

        assertGt(usdy.convertToAssets(shares), SPARE);
        assertApproxEqAbs(usdy.convertToAssets(shares), SPARE + yield, 1);
        assertEq(usd.balanceOf(address(usdy)), SPARE + yield);

        vm.prank(agent);
        vault.redeem(shares);
        assertApproxEqAbs(usd.balanceOf(address(vault)), FUNDS + yield, 1);
    }

    function test_SweepAndRedeemOnlyMoveValueBetweenTheVaultsOwnBalances() public {
        vm.prank(agent);
        vault.sweep(SPARE);
        usdy.accrue(SPARE / 20);
        uint256 third = usdy.balanceOf(address(vault)) / 3;
        vm.prank(agent);
        vault.redeem(third);

        address[3] memory outsiders = [agent, stranger, owner];
        for (uint256 i; i < outsiders.length; i++) {
            assertEq(usd.balanceOf(outsiders[i]), 0);
            assertEq(usdy.balanceOf(outsiders[i]), 0);
        }
        assertEq(usdy.balanceOf(address(vault)), usdy.totalSupply());
    }

    function _sign(address to, uint256 amount, uint256 nonce) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SignVault"), keccak256("1"), block.chainid, address(vault))
        );
        bytes32 structHash = keccak256(abi.encode(SET_PAYEE_TYPEHASH, to, amount, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
