// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ISignVault} from "../src/interfaces/ISignVault.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {PasskeySignVault} from "../src/PasskeySignVault.sol";
import {PasskeyAssertion} from "./PasskeyAssertion.sol";

contract PasskeySignVaultTest is PasskeyAssertion {
    uint256 constant AMOUNT = 10_000_000_000_000_000;
    uint256 constant FUNDS = 10_000_000_000_000_000_000;
    uint64 constant PERIOD = 1 days;
    uint256 constant OWNER_PASSKEY = uint256(keccak256("signvault.test.owner-passkey"));
    uint256 constant AGENT_PASSKEY = uint256(keccak256("signvault.test.agent-passkey"));
    bytes32 constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 constant SET_PAYEE_TYPEHASH = keccak256("SetPayee(address to,uint256 amount,uint256 nonce)");

    MockUSD cash;
    PasskeySignVault vault;
    address owner;
    uint256 ownerKey;
    address agent;
    uint256 agentKey;
    address vendor1;
    address vendor2;
    address stranger;
    bytes32 qx;
    bytes32 qy;

    function setUp() public {
        (owner, ownerKey) = makeAddrAndKey("owner");
        (agent, agentKey) = makeAddrAndKey("agent");
        vendor1 = makeAddr("vendor1");
        vendor2 = makeAddr("vendor2");
        stranger = makeAddr("stranger");
        (qx, qy) = passkeyOf(OWNER_PASSKEY);
        cash = new MockUSD();
        vault = _deploy(qx, qy);
        cash.mint(address(vault), FUNDS);
    }

    function test_StoresTheOwnersPasskey() public view {
        assertEq(vault.passkeyX(), qx);
        assertEq(vault.passkeyY(), qy);
    }

    function test_OwnerPasskeyAddsAPayee() public {
        bytes memory approval = passkeyApproval(OWNER_PASSKEY, _digest(address(vault), vendor2, AMOUNT, 0));

        vm.expectEmit(address(vault));
        emit ISignVault.PayeeSet(vendor2, AMOUNT, 0);
        vm.prank(stranger);
        vault.setPayee(vendor2, AMOUNT, approval);

        assertEq(vault.amountOf(vendor2), AMOUNT);
        assertEq(vault.nonce(), 1);
        vm.prank(agent);
        vault.pay(vendor2);
        assertEq(cash.balanceOf(vendor2), AMOUNT);
    }

    function test_OwnerWalletSignatureStillWorks() public {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, _digest(address(vault), vendor2, AMOUNT, 0));

        vm.expectEmit(address(vault));
        emit ISignVault.PayeeSet(vendor2, AMOUNT, 0);
        vault.setPayee(vendor2, AMOUNT, abi.encodePacked(r, s, v));
    }

    function test_AgentCannotApproveWithItsOwnKeys() public {
        bytes32 digest = _digest(address(vault), vendor2, AMOUNT, 0);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(agentKey, digest);
        bytes[2] memory approvals = [passkeyApproval(AGENT_PASSKEY, digest), abi.encodePacked(r, s, v)];
        for (uint256 i; i < approvals.length; i++) {
            vm.prank(agent);
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
            vault.setPayee(vendor2, AMOUNT, approvals[i]);
        }
    }

    function test_PasskeyApprovalCannotBeReplayed() public {
        bytes memory approval = passkeyApproval(OWNER_PASSKEY, _digest(address(vault), vendor2, AMOUNT, 0));
        vault.setPayee(vendor2, AMOUNT, approval);
        vault.setPayee(vendor2, 0, passkeyApproval(OWNER_PASSKEY, _digest(address(vault), vendor2, 0, 1)));

        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        vault.setPayee(vendor2, AMOUNT, approval);
    }

    function test_PasskeyApprovalForAnotherVaultIsRefused() public {
        PasskeySignVault other = _deploy(qx, qy);
        bytes memory approval = passkeyApproval(OWNER_PASSKEY, _digest(address(vault), vendor2, AMOUNT, 0));

        vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        other.setPayee(vendor2, AMOUNT, approval);
    }

    function test_BadPasskeyApprovalIsRefusedWithOurError() public {
        bytes32 digest = _digest(address(vault), vendor2, AMOUNT, 0);
        Assertion memory farIndex = assertion(OWNER_PASSKEY, digest, USER_PRESENT_AND_VERIFIED);
        farIndex.typeIndex = uint256(1) << 64;
        bytes[5] memory bad = [
            new bytes(192),
            new bytes(64),
            encode(assertion(OWNER_PASSKEY, digest, USER_PRESENT_ONLY)),
            encode(farIndex),
            passkeyApproval(OWNER_PASSKEY, _digest(address(vault), vendor2, AMOUNT + 1, 0))
        ];
        for (uint256 i; i < bad.length; i++) {
            vm.expectRevert(abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
            vault.setPayee(vendor2, AMOUNT, bad[i]);
        }
    }

    function test_DeployRefusesAPasskeyNotOnTheCurve() public {
        vm.expectRevert(abi.encodeWithSelector(PasskeySignVault.InvalidPasskey.selector));
        _deploy(qx, bytes32(uint256(qy) + 1));
    }

    function _deploy(bytes32 x, bytes32 y) internal returns (PasskeySignVault) {
        ISignVault.Payee[] memory initial = new ISignVault.Payee[](1);
        initial[0] = ISignVault.Payee({to: vendor1, amount: AMOUNT});
        return new PasskeySignVault(cash, owner, agent, PERIOD, initial, x, y);
    }

    function _digest(address vaultAddress, address to, uint256 amount, uint256 nonce) internal view returns (bytes32) {
        bytes32 domainSeparator =
            keccak256(abi.encode(DOMAIN_TYPEHASH, keccak256("SignVault"), keccak256("1"), block.chainid, vaultAddress));
        bytes32 structHash = keccak256(abi.encode(SET_PAYEE_TYPEHASH, to, amount, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
