// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {SignVault} from "../src/SignVault.sol";

contract SignVaultTest is Test {
    uint256 constant AMOUNT = 10_000_000_000_000_000;
    uint256 constant FUNDS = 10_000_000_000_000_000_000;
    uint64 constant PERIOD = 1 days;
    uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant SET_PAYEE_TYPEHASH = keccak256("SetPayee(address to,uint256 amount,uint256 nonce)");

    MockUSD cash;
    SignVault vault;
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
        cash = new MockUSD();
        vault = new SignVault(cash, owner, agent, PERIOD, _vendor1Only());
        cash.mint(address(vault), FUNDS);
    }

    function test_AgentCanPayAListedPayeeOncePerPeriod() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OnlyAgent.selector));
        vault.pay(vendor1);

        vm.expectEmit(address(vault));
        emit ISignVault.Paid(vendor1, AMOUNT, 0);
        vm.prank(agent);
        vault.pay(vendor1);

        assertEq(cash.balanceOf(vendor1), AMOUNT);
        assertEq(cash.balanceOf(address(vault)), FUNDS - AMOUNT);
        assertTrue(vault.paidInPeriod(vendor1, 0));
    }

    function test_PayingAStrangerIsRefused() public {
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.NotOnTheList.selector, stranger));
        vault.pay(stranger);
    }

    function test_PayingTwiceInAPeriodIsRefused() public {
        vm.prank(agent);
        vault.pay(vendor1);

        vm.warp(vault.startTime() + PERIOD - 1);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.AlreadyPaidThisPeriod.selector, vendor1));
        vault.pay(vendor1);
    }

    function test_PayeeCanBePaidAgainNextPeriod() public {
        vm.prank(agent);
        vault.pay(vendor1);

        vm.warp(vault.startTime() + PERIOD);
        assertEq(vault.currentPeriod(), 1);
        vm.expectEmit(address(vault));
        emit ISignVault.Paid(vendor1, AMOUNT, 1);
        vm.prank(agent);
        vault.pay(vendor1);

        assertEq(cash.balanceOf(vendor1), 2 * AMOUNT);
    }

    function test_AgentCannotChangeTheRules() public {
        bytes memory agentApproval = _sign(agentKey, address(vault), vendor2, AMOUNT, 0);

        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor2, AMOUNT, agentApproval);
    }

    function test_GarbageApprovalIsRefusedWithOurError() public {
        bytes32 digest = _digest(address(vault), vendor2, AMOUNT, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flippedV = v == 27 ? 28 : 27;
        assertEq(ecrecover(digest, flippedV, r, highS), owner);
        bytes32 compactVs = bytes32(uint256(s) | (uint256(v - 27) << 255));

        bytes[] memory garbage = new bytes[](7);
        garbage[0] = "";
        garbage[1] = abi.encodePacked(r, compactVs);
        garbage[2] = abi.encodePacked(r, s, v, uint8(0));
        garbage[3] = abi.encodePacked(r, s, uint8(29));
        garbage[4] = abi.encodePacked(r, highS, flippedV);
        garbage[5] = abi.encodePacked(bytes32(0), s, v);
        garbage[6] = abi.encodePacked(keccak256("not"), keccak256("a signature"), uint8(27));

        for (uint256 i; i < garbage.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
            vault.setPayee(vendor2, AMOUNT, garbage[i]);
        }
    }

    function test_OwnerSignatureAddsAPayee() public {
        bytes memory approval = _sign(ownerKey, address(vault), vendor2, AMOUNT, 0);

        vm.expectEmit(address(vault));
        emit ISignVault.PayeeSet(vendor2, AMOUNT, 0);
        vault.setPayee(vendor2, AMOUNT, approval);

        assertEq(vault.amountOf(vendor2), AMOUNT);
        assertEq(vault.nonce(), 1);
        assertEq(vault.payees().length, 2);
        assertEq(_timesListed(vendor1), 1);
        assertEq(_timesListed(vendor2), 1);
        vm.prank(agent);
        vault.pay(vendor2);
        assertEq(cash.balanceOf(vendor2), AMOUNT);
    }

    function test_OwnerSignatureChangesAndRemovesAPayee() public {
        vault.setPayee(vendor1, 2 * AMOUNT, _sign(ownerKey, address(vault), vendor1, 2 * AMOUNT, 0));
        assertEq(vault.amountOf(vendor1), 2 * AMOUNT);
        assertEq(vault.payees().length, 1);
        assertEq(_timesListed(vendor1), 1);

        vault.setPayee(vendor1, 0, _sign(ownerKey, address(vault), vendor1, 0, 1));
        assertEq(vault.amountOf(vendor1), 0);
        assertEq(vault.payees().length, 0);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.NotOnTheList.selector, vendor1));
        vault.pay(vendor1);
    }

    function test_AnyoneCanRelayTheOwnersApproval() public {
        vm.prank(stranger);
        vault.setPayee(vendor2, AMOUNT, _sign(ownerKey, address(vault), vendor2, AMOUNT, 0));
        assertEq(vault.amountOf(vendor2), AMOUNT);

        vm.prank(agent);
        vault.setPayee(vendor3, AMOUNT, _sign(ownerKey, address(vault), vendor3, AMOUNT, 1));
        assertEq(vault.amountOf(vendor3), AMOUNT);
    }

    function test_ApprovalCannotBeReplayed() public {
        bytes memory addVendor2 = _sign(ownerKey, address(vault), vendor2, AMOUNT, 0);
        vault.setPayee(vendor2, AMOUNT, addVendor2);
        vault.setPayee(vendor2, 0, _sign(ownerKey, address(vault), vendor2, 0, 1));

        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor2, AMOUNT, addVendor2);
    }

    function test_ApprovalForAnotherVaultIsRefused() public {
        SignVault other = new SignVault(cash, owner, agent, PERIOD, _vendor1Only());
        bytes memory forOther = _sign(ownerKey, address(other), vendor2, AMOUNT, 0);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor2, AMOUNT, forOther);
        other.setPayee(vendor2, AMOUNT, forOther);

        // A deployer key with the same nonce puts the vault at the same address on every chain.
        bytes memory forThisChain = _sign(ownerKey, address(vault), vendor2, AMOUNT, 0);
        vm.chainId(97);
        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor2, AMOUNT, forThisChain);
        vm.chainId(31337);
        vault.setPayee(vendor2, AMOUNT, forThisChain);
    }

    function _vendor1Only() internal view returns (ISignVault.Payee[] memory list) {
        list = new ISignVault.Payee[](1);
        list[0] = ISignVault.Payee(vendor1, AMOUNT);
    }

    function _digest(address vaultAddress, address to, uint256 amount, uint256 nonce) internal view returns (bytes32) {
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("SignVault"), keccak256("1"), block.chainid, vaultAddress));
        bytes32 structHash = keccak256(abi.encode(SET_PAYEE_TYPEHASH, to, amount, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(uint256 key, address vaultAddress, address to, uint256 amount, uint256 nonce)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(vaultAddress, to, amount, nonce));
        return abi.encodePacked(r, s, v);
    }

    function _timesListed(address to) internal view returns (uint256 count) {
        ISignVault.Payee[] memory list = vault.payees();
        for (uint256 i; i < list.length; i++) {
            if (list[i].to == to) count++;
        }
    }
}
