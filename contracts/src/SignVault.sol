// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {EnumerableMap} from "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import {ISignVault} from "./interfaces/ISignVault.sol";

contract SignVault is ISignVault, EIP712 {
    using SafeERC20 for IERC20;
    using EnumerableMap for EnumerableMap.AddressToUintMap;

    bytes32 private constant SET_PAYEE_TYPEHASH = keccak256("SetPayee(address to,uint256 amount,uint256 nonce)");

    IERC20 public immutable cash;
    address public immutable owner;
    address public immutable agent;
    uint64 public immutable startTime;
    uint64 public immutable periodSeconds;

    uint256 public nonce;
    mapping(address to => mapping(uint256 period => bool)) public paidInPeriod;
    EnumerableMap.AddressToUintMap private _payees;

    constructor(IERC20 cash_, address owner_, address agent_, uint64 periodSeconds_, Payee[] memory initial)
        EIP712("SignVault", "1")
    {
        cash = cash_;
        owner = owner_;
        agent = agent_;
        startTime = uint64(block.timestamp);
        periodSeconds = periodSeconds_;
        for (uint256 i; i < initial.length; i++) {
            _setPayee(initial[i].to, initial[i].amount);
        }
    }

    function currentPeriod() public view returns (uint256) {
        return (block.timestamp - startTime) / periodSeconds;
    }

    function amountOf(address to) public view returns (uint256 amount) {
        (, amount) = _payees.tryGet(to);
    }

    function payees() external view returns (Payee[] memory list) {
        list = new Payee[](_payees.length());
        for (uint256 i; i < list.length; i++) {
            (list[i].to, list[i].amount) = _payees.at(i);
        }
    }

    function pay(address to) external {
        if (msg.sender != agent) revert OnlyAgent();
        uint256 amount = amountOf(to);
        if (amount == 0) revert NotOnTheList(to);
        uint256 period = currentPeriod();
        if (paidInPeriod[to][period]) revert AlreadyPaidThisPeriod(to);

        paidInPeriod[to][period] = true;
        cash.safeTransfer(to, amount);
        emit Paid(to, amount, period);
    }

    function setPayee(address to, uint256 amount, bytes calldata approval) external {
        uint256 signedNonce = nonce;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(SET_PAYEE_TYPEHASH, to, amount, signedNonce)));
        (address signer, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, approval);
        if (err != ECDSA.RecoverError.NoError || signer != owner) revert OwnerApprovalRequired();

        nonce = signedNonce + 1;
        _setPayee(to, amount);
        emit PayeeSet(to, amount, signedNonce);
    }

    function _setPayee(address to, uint256 amount) private {
        if (amount == 0) {
            _payees.remove(to);
        } else {
            _payees.set(to, amount);
        }
    }
}
