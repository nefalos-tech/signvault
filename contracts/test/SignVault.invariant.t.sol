// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {SignVault} from "../src/SignVault.sol";

uint256 constant AMOUNT = 10_000_000_000_000_000;
uint256 constant FUNDS = 10_000_000_000_000_000_000;
// At most 500 calls per run, so payments stay far below FUNDS and the vault never runs dry.
uint256 constant MAX_AMOUNT = 2 * AMOUNT;
uint64 constant PERIOD = 1 days;
uint256 constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
bytes32 constant DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
bytes32 constant SET_PAYEE_TYPEHASH = keccak256("SetPayee(address to,uint256 amount,uint256 nonce)");

/// Everything someone without the owner's key can do to the vault: the agent key, a stranger relaying
/// anything, and replays or forgeries of the owner's approvals. Valid owner approvals are mixed in so the
/// list really changes. The ghost model counts every outcome that differs from the spec as a surprise.
contract SignVaultHandler is Test {
    struct Approval {
        address to;
        uint256 amount;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    SignVault internal immutable vault;
    address internal immutable otherVault;
    uint256 internal immutable ownerKey;
    address internal immutable agent;
    uint256 internal immutable agentKey;
    address internal immutable attacker;
    uint256 internal immutable attackerKey;

    address[] internal candidates;
    address[] internal pool;
    Approval[] internal applied;

    uint256 internal ghostTime;
    uint256 public ghostNonce;
    mapping(address => uint256) public ghostAmount;
    mapping(address => bool) public everListed;
    mapping(address => uint256) public ghostPaid;
    uint256 public ghostTotalPaid;
    mapping(address => mapping(uint256 => uint256)) internal timesPaidInPeriod;

    uint256 public surprises;
    uint256 public doublePays;
    uint256 public paysMade;
    uint256 public ownerChanges;
    uint256 public forgeriesRefused;
    uint256 public periodsCrossed;

    constructor(
        SignVault vault_,
        address otherVault_,
        uint256 ownerKey_,
        uint256 agentKey_,
        address[] memory candidates_,
        address[] memory others
    ) {
        vault = vault_;
        otherVault = otherVault_;
        ownerKey = ownerKey_;
        agentKey = agentKey_;
        agent = vm.addr(agentKey_);
        (attacker, attackerKey) = makeAddrAndKey("attacker");
        candidates = candidates_;
        pool = candidates_;
        pool.push(attacker);
        for (uint256 i; i < others.length; i++) {
            pool.push(others[i]);
        }
        ghostTime = block.timestamp;
        ISignVault.Payee[] memory initial = vault_.payees();
        for (uint256 i; i < initial.length; i++) {
            ghostAmount[initial[i].to] = initial[i].amount;
            everListed[initial[i].to] = true;
        }
    }

    modifier atGhostTime() {
        vm.warp(ghostTime);
        _;
    }

    function everyone() external view returns (address[] memory) {
        return pool;
    }

    function pay(uint256 pick, address anyone) external atGhostTime {
        uint256 i = pick % (pool.length + 1);
        address to = i == pool.length ? anyone : pool[i];
        uint256 amount = ghostAmount[to];
        uint256 period = (ghostTime - vault.startTime()) / PERIOD;
        bytes memory expectedError;
        if (amount == 0) {
            expectedError = abi.encodeWithSelector(ISignVault.NotOnTheList.selector, to);
        } else if (timesPaidInPeriod[to][period] > 0) {
            expectedError = abi.encodeWithSelector(ISignVault.AlreadyPaidThisPeriod.selector, to);
        }

        vm.prank(agent);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(vault.pay, (to)));
        _expect(ok, ret, expectedError);
        if (!ok) return;
        paysMade++;
        if (timesPaidInPeriod[to][period]++ > 0) doublePays++;
        ghostPaid[to] += amount;
        ghostTotalPaid += amount;
    }

    function warp(uint256 secs, uint8 mode) external {
        uint256 nextBoundary = vault.startTime() + ((ghostTime - vault.startTime()) / PERIOD + 1) * PERIOD;
        if (mode % 3 == 0) {
            ghostTime = nextBoundary;
        } else if (mode % 3 == 1) {
            ghostTime = nextBoundary - 1;
        } else {
            ghostTime += bound(secs, 0, 3 * PERIOD);
        }
        if (ghostTime >= nextBoundary) periodsCrossed++;
        vm.warp(ghostTime);
    }

    function setPayeeWithGarbage(
        uint256 pick,
        uint256 amount,
        bytes calldata junk,
        bytes32 r,
        bytes32 s,
        uint8 v,
        bool shaped
    ) external atGhostTime {
        _relayForgery(_target(pick), amount, shaped ? abi.encodePacked(r, s, v) : junk);
    }

    function setPayeeSignedByNonOwner(uint256 pick, uint256 amount, uint256 keySeed) external atGhostTime {
        uint256 key = keySeed % 3 == 0 ? agentKey : keySeed % 3 == 1 ? attackerKey : bound(keySeed, 1, SECP256K1_N - 1);
        if (key == ownerKey) return;
        address to = _target(pick);
        _relayForgery(to, amount, _sign(key, block.chainid, address(vault), to, amount, ghostNonce));
    }

    function replayOwnerApproval(uint256 index, uint8 form, uint256 pick, uint256 amount) external atGhostTime {
        if (applied.length == 0) return;
        Approval memory a = applied[index % applied.length];
        (address to, uint256 asked) = form % 4 == 3 ? (_target(pick), amount) : (a.to, a.amount);
        _relayForgery(to, asked, _encode(a, form % 4));
    }

    function malleateFreshOwnerApproval(uint256 pick, uint256 amount, bool compact) external atGhostTime {
        address to = _target(pick);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _digest(block.chainid, address(vault), to, amount, ghostNonce));
        _relayForgery(to, amount, _encode(Approval(to, amount, v, r, s), compact ? 2 : 1));
    }

    function setPayeeSignedForAnotherDomain(uint256 pick, uint256 amount, bool otherChain) external atGhostTime {
        address to = _target(pick);
        bytes memory approval = otherChain
            ? _sign(ownerKey, 97, address(vault), to, amount, ghostNonce)
            : _sign(ownerKey, block.chainid, otherVault, to, amount, ghostNonce);
        _relayForgery(to, amount, approval);
    }

    function ownerApproves(uint256 pick, uint256 amount) external atGhostTime {
        address to = candidates[pick % candidates.length];
        amount = amount % 4 == 0 ? 0 : bound(amount, 1, MAX_AMOUNT);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(ownerKey, _digest(block.chainid, address(vault), to, amount, ghostNonce));

        vm.prank(attacker);
        (bool ok, bytes memory ret) =
            address(vault).call(abi.encodeCall(vault.setPayee, (to, amount, abi.encodePacked(r, s, v))));
        _expect(ok, ret, "");
        if (!ok) return;
        ownerChanges++;
        ghostNonce++;
        ghostAmount[to] = amount;
        if (amount > 0) everListed[to] = true;
        applied.push(Approval(to, amount, v, r, s));
    }

    function _relayForgery(address to, uint256 amount, bytes memory approval) internal {
        vm.prank(attacker);
        (bool ok, bytes memory ret) = address(vault).call(abi.encodeCall(vault.setPayee, (to, amount, approval)));
        _expect(ok, ret, abi.encodeWithSelector(ISignVault.OwnerApprovalRequired.selector));
        if (!ok) forgeriesRefused++;
    }

    function _expect(bool ok, bytes memory ret, bytes memory expectedError) internal {
        bool shouldSucceed = expectedError.length == 0;
        if (ok != shouldSucceed || (!ok && keccak256(ret) != keccak256(expectedError))) surprises++;
    }

    function _target(uint256 pick) internal view returns (address) {
        return pool[pick % pool.length];
    }

    function _encode(Approval memory a, uint8 form) internal pure returns (bytes memory) {
        if (form == 1) {
            return abi.encodePacked(a.r, bytes32(SECP256K1_N - uint256(a.s)), a.v == 27 ? uint8(28) : uint8(27));
        }
        if (form == 2) return abi.encodePacked(a.r, bytes32(uint256(a.s) | (uint256(a.v - 27) << 255)));
        return abi.encodePacked(a.r, a.s, a.v);
    }

    function _digest(uint256 chainId, address verifyingContract, address to, uint256 amount, uint256 nonce)
        internal
        pure
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("SignVault"), keccak256("1"), chainId, verifyingContract)
        );
        bytes32 structHash = keccak256(abi.encode(SET_PAYEE_TYPEHASH, to, amount, nonce));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }

    function _sign(uint256 key, uint256 chainId, address verifyingContract, address to, uint256 amount, uint256 nonce)
        internal
        pure
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(chainId, verifyingContract, to, amount, nonce));
        return abi.encodePacked(r, s, v);
    }
}

/// forge-config: default.invariant.runs = 256
/// forge-config: default.invariant.depth = 500
/// forge-config: default.invariant.show-metrics = true
contract SignVaultInvariantTest is Test {
    MockUSD cash;
    SignVault vault;
    SignVaultHandler handler;

    function setUp() public {
        (address owner, uint256 ownerKey) = makeAddrAndKey("owner");
        (address agent, uint256 agentKey) = makeAddrAndKey("agent");
        address[] memory vendors = new address[](4);
        for (uint256 i; i < vendors.length; i++) {
            vendors[i] = makeAddr(string.concat("vendor", vm.toString(i + 1)));
        }
        address[] memory others = new address[](4);
        others[0] = owner;
        others[1] = agent;
        others[2] = makeAddr("stranger1");
        others[3] = makeAddr("stranger2");

        ISignVault.Payee[] memory initial = new ISignVault.Payee[](1);
        initial[0] = ISignVault.Payee(vendors[0], AMOUNT);
        cash = new MockUSD();
        vault = new SignVault(cash, owner, agent, PERIOD, initial);
        SignVault other = new SignVault(cash, owner, agent, PERIOD, initial);
        cash.mint(address(vault), FUNDS);

        handler = new SignVaultHandler(vault, address(other), ownerKey, agentKey, vendors, others);
        targetContract(address(handler));

        bytes4[] memory direct = new bytes4[](2);
        direct[0] = SignVault.pay.selector;
        direct[1] = SignVault.setPayee.selector;
        targetSelector(FuzzSelector(address(vault), direct));
        excludeSender(agent);
    }

    function invariant_OnlyListedPayeesEverReceiveMUSD() public view {
        address[] memory pool = handler.everyone();
        uint256 accounted = cash.balanceOf(address(vault));
        for (uint256 i; i < pool.length; i++) {
            uint256 balance = cash.balanceOf(pool[i]);
            if (!handler.everListed(pool[i])) assertEq(balance, 0, "never listed, yet holds mUSD");
            assertEq(balance, handler.ghostPaid(pool[i]), "received a different amount than the list allowed");
            accounted += balance;
        }
        assertEq(cash.totalSupply(), FUNDS);
        assertEq(accounted, FUNDS, "mUSD went to an address outside the pool");
    }

    function invariant_PayeeListChangesOnlyWithAValidOwnerSignature() public view {
        assertEq(vault.nonce(), handler.ghostNonce(), "nonce moved without an owner approval");
        address[] memory pool = handler.everyone();
        uint256 listed;
        for (uint256 i; i < pool.length; i++) {
            assertEq(vault.amountOf(pool[i]), handler.ghostAmount(pool[i]), "amountOf differs from owner approvals");
            if (handler.ghostAmount(pool[i]) > 0) listed++;
        }
        ISignVault.Payee[] memory list = vault.payees();
        assertEq(list.length, listed, "payees() length differs from owner approvals");
        for (uint256 i; i < list.length; i++) {
            assertGt(list[i].amount, 0);
            assertEq(list[i].amount, handler.ghostAmount(list[i].to), "payees() entry differs from owner approvals");
            for (uint256 j; j < i; j++) {
                assertNotEq(list[i].to, list[j].to, "payee listed twice");
            }
        }
    }

    function invariant_VaultBalancePlusPaidIsStartingBalance() public view {
        assertEq(cash.balanceOf(address(vault)) + handler.ghostTotalPaid(), FUNDS);
    }

    function invariant_NoPayeeIsPaidTwiceInOnePeriod() public view {
        assertEq(handler.doublePays(), 0);
    }

    function invariant_EveryCallEndsTheWayTheSpecSays() public view {
        assertEq(handler.surprises(), 0, "a call succeeded or reverted differently from the spec");
    }

    function afterInvariant() public view {
        assertGt(handler.paysMade(), 0, "no payment went through");
        assertGt(handler.ownerChanges(), 0, "the owner never changed the list");
        assertGt(handler.forgeriesRefused(), 0, "no forgery was tried");
        assertGt(handler.periodsCrossed(), 0, "time never crossed a period boundary");
    }
}
