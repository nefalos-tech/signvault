// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {MockUSD} from "../src/MockUSD.sol";
import {BaselineWallet} from "../src/BaselineWallet.sol";
import {PasskeySignVault} from "../src/PasskeySignVault.sol";
import {ISignVault} from "../src/interfaces/ISignVault.sol";

/// Card T1: deploys `PAIRS` fresh BaselineWallet + PasskeySignVault pairs on top of an existing deployment, and writes
/// deployments/<chainId>-passkey.json. That file is deployments/<chainId>.json with new `pairs`, so the token, owner,
/// agent, operator and vendors carry over and the server reads it as is (DEPLOYMENT=<chainId>-passkey).
/// Env: PASSKEY_X and PASSKEY_Y (from /approve-passkey), PAIRS (default 8), OPERATOR_PRIVATE_KEY (unset: --sender).
contract DeployPasskey is Script {
    uint256 internal constant INVOICE_AMOUNT = 0.01 ether;
    uint256 internal constant STARTING_BALANCE = 10 ether;
    uint64 internal constant PERIOD_SECONDS = 1 days;

    struct Base {
        MockUSD mockUsd;
        address owner;
        address agent;
        address operator;
        address vendor1;
    }

    function run() external {
        require(block.chainid == 31337 || block.chainid == 97, "DeployPasskey: anvil (31337) or BSC testnet (97) only");
        bytes32 passkeyX = vm.envBytes32("PASSKEY_X");
        bytes32 passkeyY = vm.envBytes32("PASSKEY_Y");
        uint256 pairCount = vm.envOr("PAIRS", uint256(8));
        uint256 operatorKey = vm.envOr("OPERATOR_PRIVATE_KEY", uint256(0));
        require(pairCount > 0, "DeployPasskey: PAIRS must be at least 1");

        string memory dir = string.concat(vm.projectRoot(), "/../deployments/");
        string memory basePath = string.concat(dir, vm.toString(block.chainid), ".json");
        Base memory base = _readBase(vm.readFile(basePath));
        require(address(base.mockUsd).code.length > 0, "DeployPasskey: no MockUSD on this chain, run Deploy.s.sol first");

        if (operatorKey == 0) vm.startBroadcast();
        else vm.startBroadcast(operatorKey);
        string memory pairs = "[";
        for (uint256 i; i < pairCount; i++) {
            pairs = string.concat(pairs, i == 0 ? "" : ",", _deployPair(base, passkeyX, passkeyY, i));
        }
        vm.stopBroadcast();

        if (vm.isContext(VmSafe.ForgeContext.ScriptDryRun)) return;
        string memory out = string.concat(dir, vm.toString(block.chainid), "-passkey.json");
        vm.copyFile(basePath, out);
        vm.writeJson(string.concat(pairs, "]"), out, ".pairs");
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

    /// One funded pair, as Deploy.s.sol makes it but with a PasskeySignVault. Returns the pair as JSON.
    function _deployPair(Base memory base, bytes32 passkeyX, bytes32 passkeyY, uint256 i)
        internal
        returns (string memory)
    {
        ISignVault.Payee[] memory initial = new ISignVault.Payee[](1);
        initial[0] = ISignVault.Payee({to: base.vendor1, amount: INVOICE_AMOUNT});
        BaselineWallet baseline = new BaselineWallet(base.mockUsd, base.operator, base.agent, INVOICE_AMOUNT);
        PasskeySignVault vault =
            new PasskeySignVault(base.mockUsd, base.owner, base.agent, PERIOD_SECONDS, initial, passkeyX, passkeyY);
        base.mockUsd.mint(address(baseline), STARTING_BALANCE);
        base.mockUsd.mint(address(vault), STARTING_BALANCE);

        string memory key = string.concat("pair", vm.toString(i));
        vm.serializeAddress(key, "baselineWallet", address(baseline));
        return vm.serializeAddress(key, "signVault", address(vault));
    }
}
