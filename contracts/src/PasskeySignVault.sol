// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {PasskeyApproval} from "./PasskeyApproval.sol";
import {SignVault} from "./SignVault.sol";

/// A SignVault whose owner can also approve a rule change with a passkey (Face ID, Touch ID), checked on chain.
/// The approval signs the same SetPayee digest as the owner's wallet, so the nonce and the vault's
/// address still stop a replay. See PasskeyApproval for the byte layout.
contract PasskeySignVault is SignVault {
    error InvalidPasskey();

    /// The owner's passkey public key, a P-256 point.
    bytes32 public immutable passkeyX;
    bytes32 public immutable passkeyY;

    constructor(
        IERC20 cash_,
        address owner_,
        address agent_,
        uint64 periodSeconds_,
        Payee[] memory initial,
        bytes32 passkeyX_,
        bytes32 passkeyY_
    ) SignVault(cash_, owner_, agent_, periodSeconds_, initial) {
        if (!P256.isValidPublicKey(passkeyX_, passkeyY_)) revert InvalidPasskey();
        passkeyX = passkeyX_;
        passkeyY = passkeyY_;
    }

    /// 65 bytes is the owner wallet's signature, checked as before. Anything else is a passkey assertion.
    function _isOwnerApproval(bytes32 digest, bytes calldata approval) internal view override returns (bool) {
        if (approval.length == 65) return super._isOwnerApproval(digest, approval);
        return PasskeyApproval.isValid(digest, approval, passkeyX, passkeyY);
    }
}
