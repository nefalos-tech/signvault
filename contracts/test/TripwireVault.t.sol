// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockUSDY} from "../src/MockUSDY.sol";
import {TBillSignVault} from "../src/TBillSignVault.sol";
import {TripwireVault} from "../src/TripwireVault.sol";

contract TripwireVaultTest is Test {
    uint256 constant AMOUNT = 10_000_000_000_000_000;
    uint256 constant FUNDS = 10_000_000_000_000_000_000;
    uint256 constant OWED = 3 * AMOUNT; // vendor1 is owed AMOUNT, vendor2 2 * AMOUNT
    uint256 constant SPARE = FUNDS - OWED;
    uint256 constant YIELD = SPARE / 20;
    uint64 constant PERIOD = 1 days;
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant SET_PAYEE_TYPEHASH = keccak256("SetPayee(address to,uint256 amount,uint256 nonce)");
    bytes32 constant REARM_TYPEHASH = keccak256("Rearm(uint256 nonce)");

    MockUSD usd;
    MockUSDY usdy;
    TripwireVault vault;
    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address vendor1;
    address vendor2;
    address vendor3;
    address stranger;

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        vendor1 = makeAddr("vendor1");
        vendor2 = makeAddr("vendor2");
        vendor3 = makeAddr("vendor3");
        stranger = makeAddr("stranger");
        usd = new MockUSD();
        usdy = new MockUSDY(usd);
        ISignVault.Payee[] memory list = new ISignVault.Payee[](2);
        list[0] = ISignVault.Payee(vendor1, AMOUNT);
        list[1] = ISignVault.Payee(vendor2, 2 * AMOUNT);
        vault = new TripwireVault(usd, owner, agent, PERIOD, list, usdy);
        usd.mint(address(vault), FUNDS);
    }

    function test_TheAgentTripsAndEverythingReturnsToCash() public {
        vm.prank(agent);
        vault.sweep(SPARE);
        usdy.accrue(YIELD);
        uint256 shares = usdy.balanceOf(address(vault));
        uint256 assets = usdy.previewRedeem(shares);
        assertGt(assets, SPARE);

        vm.expectEmit(address(vault));
        emit TripwireVault.Tripped(shares, assets);
        vm.prank(agent);
        vault.trip();

        assertTrue(vault.tripped());
        assertEq(usdy.balanceOf(address(vault)), 0);
        assertEq(usd.balanceOf(address(vault)), OWED + assets);
        assertApproxEqAbs(usd.balanceOf(address(vault)), FUNDS + YIELD, 1);
    }

    function test_ATripWithNothingSweptStillLocks() public {
        vm.expectEmit(address(vault));
        emit TripwireVault.Tripped(0, 0);
        vm.prank(agent);
        vault.trip();

        assertTrue(vault.tripped());
        assertEq(usd.balanceOf(address(vault)), FUNDS);
    }

    function test_ASweepWhileTrippedIsRefused() public {
        vm.prank(agent);
        vault.trip();

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TripwireVault.SweepLocked.selector));
        vault.sweep(1);
        assertEq(usdy.balanceOf(address(vault)), 0);
    }

    function test_RedeemStillBringsCashBackWhileTripped() public {
        vm.prank(agent);
        vault.trip();
        usd.mint(stranger, AMOUNT);
        vm.startPrank(stranger);
        usd.approve(address(usdy), AMOUNT);
        uint256 shares = usdy.deposit(AMOUNT, address(vault));
        vm.stopPrank();

        vm.prank(agent);
        vault.redeem(shares);
        assertEq(usdy.balanceOf(address(vault)), 0);
        assertEq(usd.balanceOf(address(vault)), FUNDS + AMOUNT);
    }

    function test_AStrangerCannotTrip() public {
        address[2] memory others = [stranger, owner];
        for (uint256 i; i < others.length; i++) {
            vm.prank(others[i]);
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OnlyAgent.selector));
            vault.trip();
        }
        assertFalse(vault.tripped());
    }

    function test_OnlyTheOwnersSignatureRearms() public {
        vm.prank(agent);
        vault.trip();

        bytes[4] memory refused = [
            _sign(agentKey, _rearm(0), address(vault)),
            _sign(ownerKey, _rearm(0), address(0xBEEF)),
            hex"deadbeef",
            new bytes(65)
        ];
        for (uint256 i; i < refused.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
            vault.rearm(refused[i]);
        }
        assertTrue(vault.tripped());
        assertEq(vault.nonce(), 0);

        vm.expectEmit(address(vault));
        emit TripwireVault.Rearmed(0);
        vm.prank(stranger);
        vault.rearm(_sign(ownerKey, _rearm(0), address(vault)));

        assertFalse(vault.tripped());
        assertEq(vault.nonce(), 1);
        vm.prank(agent);
        vault.sweep(SPARE);
        assertEq(usd.balanceOf(address(vault)), OWED);
    }

    function test_ARearmCannotBeReplayed() public {
        bytes memory approval = _sign(ownerKey, _rearm(0), address(vault));
        vm.prank(agent);
        vault.trip();
        vault.rearm(approval);

        vm.prank(agent);
        vault.trip();
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.rearm(approval);
        assertTrue(vault.tripped());
        assertEq(vault.nonce(), 1);
    }

    function test_ASweepThatDipsIntoPayrollIsStillRefused() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OnlyAgent.selector));
        vault.sweep(1);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, SPARE + 1, FUNDS, OWED));
        vault.sweep(SPARE + 1);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(TBillSignVault.SweepDipsIntoPayroll.selector, FUNDS + 1, FUNDS, OWED));
        vault.sweep(FUNDS + 1);
        assertEq(usdy.balanceOf(address(vault)), 0);

        vm.prank(agent);
        vault.sweep(SPARE);
        assertEq(usd.balanceOf(address(vault)), OWED);
        assertEq(usdy.convertToAssets(usdy.balanceOf(address(vault))), SPARE);
    }

    function test_SetPayeeAndRearmApprovalsCannotBeSwapped() public {
        bytes memory setPayeeApproval = _sign(ownerKey, _setPayee(vendor3, AMOUNT, 0), address(vault));
        bytes memory rearmApproval = _sign(ownerKey, _rearm(0), address(vault));
        vm.prank(agent);
        vault.trip();

        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.rearm(setPayeeApproval);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor3, AMOUNT, rearmApproval);

        // Both used nonce 0, so the one that lands first spends the other.
        vault.rearm(rearmApproval);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor3, AMOUNT, setPayeeApproval);
        assertEq(vault.amountOf(vendor3), 0);
    }

    function _rearm(uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(REARM_TYPEHASH, nonce));
    }

    function _setPayee(address to, uint256 amount, uint256 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(SET_PAYEE_TYPEHASH, to, amount, nonce));
    }

    function _sign(uint256 key, bytes32 structHash, address verifyingContract) internal view returns (bytes memory) {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SignVault"), keccak256("1"), block.chainid, verifyingContract)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash)));
        return abi.encodePacked(r, s, v);
    }
}
