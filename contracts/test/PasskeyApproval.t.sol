// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {PasskeyApproval} from "../src/PasskeyApproval.sol";
import {PasskeyAssertion} from "./PasskeyAssertion.sol";

contract PasskeyApprovalHarness {
    function isValid(bytes32 digest, bytes calldata approval, bytes32 qx, bytes32 qy) external view returns (bool) {
        return PasskeyApproval.isValid(digest, approval, qx, qy);
    }
}

contract PasskeyApprovalTest is PasskeyAssertion {
    uint256 constant OWNER_PASSKEY = uint256(keccak256("signvault.test.owner-passkey"));
    uint256 constant OTHER_PASSKEY = uint256(keccak256("signvault.test.other-passkey"));
    bytes32 constant DIGEST = keccak256("a SetPayee digest");

    PasskeyApprovalHarness harness;
    bytes32 qx;
    bytes32 qy;

    function setUp() public {
        harness = new PasskeyApprovalHarness();
        (qx, qy) = passkeyOf(OWNER_PASSKEY);
    }

    function test_AnAssertionOverTheDigestPasses() public view {
        assertTrue(harness.isValid(DIGEST, passkeyApproval(OWNER_PASSKEY, DIGEST), qx, qy));
    }

    function test_AnAssertionOverAnotherDigestFails() public view {
        bytes memory approval = passkeyApproval(OWNER_PASSKEY, keccak256("another digest"));
        assertFalse(harness.isValid(DIGEST, approval, qx, qy));
    }

    function test_AnAssertionFromAnotherKeyFails() public view {
        assertFalse(harness.isValid(DIGEST, passkeyApproval(OTHER_PASSKEY, DIGEST), qx, qy));
        (bytes32 otherX, bytes32 otherY) = passkeyOf(OTHER_PASSKEY);
        assertFalse(harness.isValid(DIGEST, passkeyApproval(OWNER_PASSKEY, DIGEST), otherX, otherY));
    }

    function test_AnAssertionWithoutUserVerificationFails() public view {
        bytes memory approval = encode(assertion(OWNER_PASSKEY, DIGEST, USER_PRESENT_ONLY));
        assertFalse(harness.isValid(DIGEST, approval, qx, qy));
    }

    /// OpenZeppelin's P256 takes only s <= n/2, and authenticators sign with any s, so the browser side flips it.
    function test_AHighSIsRefusedSoTheBrowserMustNormalizeIt() public view {
        Assertion memory a = assertion(OWNER_PASSKEY, DIGEST, USER_PRESENT_AND_VERIFIED);
        a.s = bytes32(P256_N - uint256(a.s));
        assertFalse(harness.isValid(DIGEST, encode(a), qx, qy));
    }

    function test_MalformedBytesReturnFalseWithoutReverting() public view {
        bytes memory valid = passkeyApproval(OWNER_PASSKEY, DIGEST);
        bytes[] memory bad = new bytes[](7);
        bad[0] = "";
        bad[1] = abi.encodePacked(bytes32(uint256(1)), bytes32(uint256(2)), uint8(27));
        bad[2] = new bytes(191);
        bad[3] = new bytes(192);
        bad[4] = _withWord(valid, 0x80, valid.length); // authenticatorData starts past the end
        bad[5] = _withWord(valid, 0xa0, type(uint256).max); // clientDataJSON starts past the end
        Assertion memory short = assertion(OWNER_PASSKEY, DIGEST, USER_PRESENT_AND_VERIFIED);
        short.authenticatorData = new bytes(36);
        bad[6] = encode(short);
        for (uint256 i; i < bad.length; i++) {
            assertFalse(harness.isValid(DIGEST, bad[i], qx, qy));
        }
    }

    function test_AnIndexPastTheEndOfClientDataReturnsFalse() public view {
        uint256 length = bytes(assertion(OWNER_PASSKEY, DIGEST, USER_PRESENT_AND_VERIFIED).clientDataJSON).length;
        uint256[3] memory indices = [length, uint256(1) << 64, type(uint256).max];
        for (uint256 i; i < indices.length; i++) {
            Assertion memory a = assertion(OWNER_PASSKEY, DIGEST, USER_PRESENT_AND_VERIFIED);
            a.typeIndex = indices[i];
            assertFalse(harness.isValid(DIGEST, encode(a), qx, qy));
            a = assertion(OWNER_PASSKEY, DIGEST, USER_PRESENT_AND_VERIFIED);
            a.challengeIndex = indices[i];
            assertFalse(harness.isValid(DIGEST, encode(a), qx, qy));
        }
    }

    function _withWord(bytes memory b, uint256 at, uint256 word) private pure returns (bytes memory out) {
        out = bytes.concat(b);
        assembly ("memory-safe") {
            mstore(add(add(out, 0x20), at), word)
        }
    }
}
