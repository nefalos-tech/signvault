// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {WebAuthn} from "@openzeppelin/contracts/utils/cryptography/WebAuthn.sol";

/// Checks a passkey (WebAuthn, P-256) approval of an EIP-712 digest with OpenZeppelin's WebAuthn.verify,
/// which uses the secp256r1 precompile at 0x100 where the chain has one (BSC does).
///
/// `approval` is abi.encode(bytes32 r, bytes32 s, uint256 challengeIndex, uint256 typeIndex,
/// bytes authenticatorData, string clientDataJSON), the layout WebAuthn.tryDecodeAuth reads. The assertion's
/// challenge must be the digest itself, `s` must be at most n/2, and the user-verified flag must be set.
library PasskeyApproval {
    /// True only for a valid assertion over `digest` by the key (qx, qy). Malformed bytes return false.
    function isValid(bytes32 digest, bytes calldata approval, bytes32 qx, bytes32 qy) internal view returns (bool) {
        (bool decoded, WebAuthn.WebAuthnAuth calldata auth) = WebAuthn.tryDecodeAuth(approval);
        if (!decoded) return false;
        // WebAuthn.verify reads clientDataJSON at typeIndex in assembly without a bounds check, so an index far
        // past the end runs out of gas instead of returning false.
        if (auth.typeIndex >= bytes(auth.clientDataJSON).length) return false;
        return WebAuthn.verify(abi.encodePacked(digest), auth, qx, qy);
    }
}
