// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

/// Builds the approval bytes a browser passkey produces, signed with a software P-256 key in place of Face ID.
abstract contract PasskeyAssertion is Test {
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    bytes1 internal constant USER_PRESENT_AND_VERIFIED = 0x05;
    bytes1 internal constant USER_PRESENT_ONLY = 0x01;

    /// The fields of OpenZeppelin's WebAuthn.WebAuthnAuth, in its order.
    struct Assertion {
        bytes32 r;
        bytes32 s;
        uint256 challengeIndex;
        uint256 typeIndex;
        bytes authenticatorData;
        string clientDataJSON;
    }

    function passkeyOf(uint256 key) internal pure returns (bytes32 qx, bytes32 qy) {
        (uint256 x, uint256 y) = vm.publicKeyP256(key);
        return (bytes32(x), bytes32(y));
    }

    /// What `navigator.credentials.get` returns for `challenge`, with `s` made low the way the browser side does.
    function assertion(uint256 key, bytes32 challenge, bytes1 flags) internal pure returns (Assertion memory a) {
        a.authenticatorData = abi.encodePacked(sha256("localhost"), flags, uint32(0));
        a.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"http://localhost:3000","crossOrigin":false}'
        );
        a.typeIndex = 1;
        a.challengeIndex = 23;
        bytes32 signed = sha256(abi.encodePacked(a.authenticatorData, sha256(bytes(a.clientDataJSON))));
        (a.r, a.s) = vm.signP256(key, signed);
        if (uint256(a.s) > P256_N / 2) a.s = bytes32(P256_N - uint256(a.s));
    }

    /// The approval layout WebAuthn.tryDecodeAuth reads: the six fields ABI-encoded as flat parameters.
    function encode(Assertion memory a) internal pure returns (bytes memory) {
        return abi.encode(a.r, a.s, a.challengeIndex, a.typeIndex, a.authenticatorData, a.clientDataJSON);
    }

    function passkeyApproval(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        return encode(assertion(key, digest, USER_PRESENT_AND_VERIFIED));
    }
}
