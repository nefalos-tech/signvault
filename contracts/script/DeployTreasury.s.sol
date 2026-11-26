// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {MockUSDY} from "../src/MockUSDY.sol";
import {BaselineWallet} from "../src/BaselineWallet.sol";
import {TripwireVault} from "../src/TripwireVault.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";

/// Card T3: deploys a MockUSDY over the existing MockUSD, priced at USDY's redemption value, and `PAIRS` fresh
/// BaselineWallet + TripwireVault pairs on top of an existing deployment. Writes deployments/<chainId>-treasury.json:
/// deployments/<chainId>.json plus `mockUsdy`, with new `pairs`, so the server reads it with
/// DEPLOYMENT=<chainId>-treasury.
/// Env: USDY_NAV (required: USD per USDY in 18 decimals, so 1.0842 USD is 1084200000000000000), PAIRS (default 8),
/// OPERATOR_PRIVATE_KEY (unset: --sender).
contract DeployTreasury is Script {
    uint256 internal constant INVOICE_AMOUNT = 0.01 ether;
    uint256 internal constant STARTING_BALANCE = 10 ether;
    uint64 internal constant PERIOD_SECONDS = 1 days;
    /// mUSD the broadcaster deposits before `accrue`, so the share price is yield over a real supply.
    uint256 internal constant SEED = 1 ether;

    struct Base {
        MockUSD mockUsd;
        address owner;
        address agent;
        address operator;
        address vendor1;
    }

    function run() external {
        require(block.chainid == 31337 || block.chainid == 97, "DeployTreasury: anvil (31337) or BSC testnet (97) only");
        uint256 nav = vm.envUint("USDY_NAV");
        uint256 pairCount = vm.envOr("PAIRS", uint256(8));
        uint256 operatorKey = vm.envOr("OPERATOR_PRIVATE_KEY", uint256(0));
        // accrue can only raise the price, and a value past 2 USD is a unit mistake.
        require(
            nav >= 1 ether && nav < 2 ether, "DeployTreasury: USDY_NAV is USD per USDY in 18 decimals, 1e18 to 2e18"
        );
        require(pairCount > 0, "DeployTreasury: PAIRS must be at least 1");

        string memory dir = string.concat(vm.projectRoot(), "/../deployments/");
        string memory baseJson = vm.readFile(string.concat(dir, vm.toString(block.chainid), ".json"));
        Base memory base = _readBase(baseJson);
        require(
            address(base.mockUsd).code.length > 0, "DeployTreasury: no MockUSD on this chain, run Deploy.s.sol first"
        );

        address broadcaster = operatorKey == 0 ? msg.sender : vm.addr(operatorKey);
        if (operatorKey == 0) vm.startBroadcast();
        else vm.startBroadcast(operatorKey);
        MockUSDY mockUsdy = _deployMockUsdy(base.mockUsd, broadcaster, nav);
        string[] memory pairs = new string[](pairCount);
        for (uint256 i; i < pairCount; i++) {
            pairs[i] = _deployPair(base, mockUsdy, i);
        }
        vm.stopBroadcast();

        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) return;
        string memory root = "deployment";
        vm.serializeJson(root, baseJson);
        vm.serializeAddress(root, "mockUsdy", address(mockUsdy));
        string memory json = vm.serializeString(root, "pairs", pairs);
        vm.writeJson(json, string.concat(dir, vm.toString(block.chainid), "-treasury.json"));
    }

    function _readBase(string memory json) internal pure returns (Base memory) {
        return Base({
            mockUsd: MockUSD(vm.parseJsonAddress(json, ".mockUsd")),
            owner: vm.parseJsonAddress(json, ".owner"),
            agent: vm.parseJsonAddress(json, ".agent"),
            operator: vm.parseJsonAddress(json, ".operator"),
            vendor1: vm.parseJsonAddress(json, ".vendors[0].address")
        });
    }

    /// OpenZeppelin's ERC4626 values a share at (totalAssets + 1) / (totalSupply + 1). After a 1:1 seed both sides are
    /// SEED + 1, so a yield of ceil(nav * (SEED + 1) / 1e18) - (SEED + 1) makes convertToAssets(1e18) exactly `nav`.
    function _deployMockUsdy(MockUSD mockUsd, address broadcaster, uint256 nav) internal returns (MockUSDY mockUsdy) {
        mockUsdy = new MockUSDY(mockUsd);
        mockUsd.mint(broadcaster, SEED);
        mockUsd.approve(address(mockUsdy), SEED);
        mockUsdy.deposit(SEED, broadcaster);
        uint256 seeded = SEED + 1;
        mockUsdy.accrue(Math.mulDiv(nav, seeded, 1 ether, Math.Rounding.Ceil) - seeded);
    }

    /// One funded pair, as Deploy.s.sol makes it but with a TripwireVault over `mockUsdy`. Returns the pair as JSON.
    function _deployPair(Base memory base, MockUSDY mockUsdy, uint256 i) internal returns (string memory) {
        ISignVault.Payee[] memory initial = new ISignVault.Payee[](1);
        initial[0] = ISignVault.Payee({to: base.vendor1, amount: INVOICE_AMOUNT});
        BaselineWallet baseline = new BaselineWallet(base.mockUsd, base.operator, base.agent, INVOICE_AMOUNT);
        TripwireVault vault = new TripwireVault(base.mockUsd, base.owner, base.agent, PERIOD_SECONDS, initial, mockUsdy);
        base.mockUsd.mint(address(baseline), STARTING_BALANCE);
        base.mockUsd.mint(address(vault), STARTING_BALANCE);

        string memory key = string.concat("pair", vm.toString(i));
        vm.serializeAddress(key, "baselineWallet", address(baseline));
        return vm.serializeAddress(key, "signVault", address(vault));
    }
}
