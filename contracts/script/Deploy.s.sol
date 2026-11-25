// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {BaselineWallet} from "../src/BaselineWallet.sol";
import {SignVault} from "../src/SignVault.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";

/// Deploys MockUSD and `PAIRS` funded BaselineWallet + SignVault pairs, then writes deployments/<chainId>.json (spec 6.5).
/// Env: OPERATOR_PRIVATE_KEY (unset: broadcast as --sender), AGENT_ADDRESS or AGENT_PRIVATE_KEY, OWNER_ADDRESS, PAIRS.
contract Deploy is Script {
    uint256 internal constant INVOICE_AMOUNT = 0.01 ether;
    uint256 internal constant STARTING_BALANCE = 10 ether;
    uint64 internal constant PERIOD_SECONDS = 1 days;

    function run() external {
        require(block.chainid == 31337 || block.chainid == 97, "Deploy: anvil (31337) or BSC testnet (97) only");

        uint256 operatorKey = vm.envOr("OPERATOR_PRIVATE_KEY", uint256(0));
        address operator = operatorKey == 0 ? msg.sender : vm.addr(operatorKey);
        address agent = vm.envOr("AGENT_ADDRESS", address(0));
        if (agent == address(0)) {
            uint256 agentKey = vm.envOr("AGENT_PRIVATE_KEY", uint256(0));
            if (agentKey != 0) agent = vm.addr(agentKey);
        }
        address owner = vm.envOr("OWNER_ADDRESS", address(0));
        uint256 pairCount = vm.envOr("PAIRS", uint256(8));

        require(operator != DEFAULT_SENDER, "Deploy: set OPERATOR_PRIVATE_KEY or pass --sender");
        require(agent != address(0), "Deploy: set AGENT_ADDRESS or AGENT_PRIVATE_KEY");
        require(owner != address(0), "Deploy: set OWNER_ADDRESS");
        require(pairCount > 0, "Deploy: PAIRS must be at least 1");

        address vendor1 = _labelAddress("signvault.vendor1");
        ISignVault.Payee[] memory initial = new ISignVault.Payee[](1);
        initial[0] = ISignVault.Payee({to: vendor1, amount: INVOICE_AMOUNT});

        if (operatorKey == 0) vm.startBroadcast();
        else vm.startBroadcast(operatorKey);

        MockUSD mockUsd = new MockUSD();
        string[] memory pairs = new string[](pairCount);
        for (uint256 i; i < pairCount; i++) {
            BaselineWallet baseline = new BaselineWallet(mockUsd, operator, agent, INVOICE_AMOUNT);
            SignVault vault = new SignVault(mockUsd, owner, agent, PERIOD_SECONDS, initial);
            mockUsd.mint(address(baseline), STARTING_BALANCE);
            mockUsd.mint(address(vault), STARTING_BALANCE);

            string memory key = string.concat("pair", vm.toString(i));
            vm.serializeAddress(key, "baselineWallet", address(baseline));
            pairs[i] = vm.serializeAddress(key, "signVault", address(vault));
        }
        vm.stopBroadcast();

        string[] memory vendors = new string[](3);
        vendors[0] = _vendor("Vendor 1", vendor1);
        vendors[1] = _vendor("Vendor 2", _labelAddress("signvault.vendor2"));
        vendors[2] = _vendor("Vendor 3", _labelAddress("signvault.vendor3"));

        string memory root = "deployment";
        vm.serializeUint(root, "chainId", block.chainid);
        vm.serializeString(root, "explorerUrl", block.chainid == 97 ? "https://testnet.bscscan.com" : "");
        vm.serializeAddress(root, "mockUsd", address(mockUsd));
        vm.serializeAddress(root, "owner", owner);
        vm.serializeAddress(root, "agent", agent);
        vm.serializeAddress(root, "operator", operator);
        vm.serializeString(root, "vendors", vendors);
        vm.serializeAddress(root, "attacker", _labelAddress("signvault.attacker"));
        string memory json = vm.serializeString(root, "pairs", pairs);

        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) return;
        vm.writeJson(json, string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json"));
    }

    function _labelAddress(string memory label) internal pure returns (address) {
        return vm.addr(uint256(keccak256(bytes(label))));
    }

    function _vendor(string memory name, address addr) internal returns (string memory) {
        vm.serializeString(name, "name", name);
        return vm.serializeAddress(name, "address", addr);
    }
}
