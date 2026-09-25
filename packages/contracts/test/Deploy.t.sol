// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test, Vm } from "forge-std/Test.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { Deploy } from "../script/Deploy.s.sol";
import { BaseStocks } from "../script/Stocks.sol";
import { MockFeed } from "./mocks/MockStock.sol";

/// The deploy script as it behaves under `forge script --broadcast`, which a test cannot enter.
contract BroadcastingDeploy is Deploy {
    function _broadcasting() internal pure override returns (bool) {
        return true;
    }
}

/// Runs the deploy script against a local stand-in for Base: the PoolManager at its Base address
/// and an 8-decimal feed at every registered feed address. Nothing leaves this process.
contract DeployTest is Test {
    address constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    Deploy script;

    function setUp() public {
        vm.chainId(8453);
        vm.roll(1); // far below any real deploy block, so no committed record can collide
        deployCodeTo("PoolManager.sol:PoolManager", abi.encode(address(this)), BASE_POOL_MANAGER);
        bytes memory feedCode = address(new MockFeed("feed", 1e8)).code;
        BaseStocks.Entry[] memory list = BaseStocks.all();
        for (uint256 i; i < list.length; i++) {
            vm.etch(list[i].feed, feedCode);
        }
        // The broadcaster is tx.origin; make it the owner so the script's owner-only calls land.
        vm.setEnv("OWNER", vm.toString(tx.origin));
        script = new Deploy();
    }

    function test_RecordIsLabelledByBlock() public {
        assertEq(script.recordPath(), "deployments/base-1.json");
        vm.roll(50_932_763);
        assertEq(script.recordPath(), "deployments/base-50932763.json");
    }

    /// A dry run deploys and wires everything but records nothing.
    function test_DryRunWiresTheDeploymentAndWritesNoRecord() public {
        vm.recordLogs();
        script.run();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertFalse(vm.exists(script.recordPath()), "a dry run writes no record");
        address factory;
        uint256 added;
        uint256 disabled;
        for (uint256 i; i < logs.length; i++) {
            bytes32 topic = logs[i].topics[0];
            if (topic == StockPairFactory.HookSet.selector) factory = logs[i].emitter;
            if (topic == StockPairFactory.StockAdded.selector) added++;
            if (topic == StockPairFactory.StockEnabled.selector) disabled++;
        }
        assertTrue(factory != address(0), "setHook ran");
        StockPairFactory f = StockPairFactory(factory);
        assertTrue(address(f.hook()) != address(0));
        assertEq(added, BaseStocks.all().length, "every stock re-added");
        assertEq(disabled, 3, "unissued stocks closed");
        assertEq(f.stockInfo(BaseStocks.all()[0].token).decimals, 8);
    }

    /// A broadcast writes the record before forge sends anything, so the record must not claim
    /// the deployment happened: `confirmed` is false until apply-deployment checks the chain.
    function test_BroadcastRecordIsWrittenUnconfirmed() public {
        // Its own block, so its own file: tests share the filesystem and run in parallel.
        vm.roll(2);
        Deploy broadcasting = new BroadcastingDeploy();
        string memory path = broadcasting.recordPath();
        assertEq(path, "deployments/base-2.json");
        assertFalse(vm.exists(path), "no stale record from an earlier run");
        broadcasting.run();
        string memory json = vm.readFile(path);
        vm.removeFile(path);

        assertFalse(vm.parseJsonBool(json, ".confirmed"), "unconfirmed when written");
        assertEq(vm.parseJsonUint(json, ".chainId"), 8453);
        assertEq(vm.parseJsonUint(json, ".block"), 2);
        StockPairFactory factory = StockPairFactory(vm.parseJsonAddress(json, ".factory"));
        address hook = vm.parseJsonAddress(json, ".hook");
        address router = vm.parseJsonAddress(json, ".router");
        assertGt(address(factory).code.length, 0, "factory");
        assertEq(address(factory.hook()), hook, "hook");
        assertGt(router.code.length, 0, "router");
        assertEq(factory.owner(), vm.parseJsonAddress(json, ".owner"));
        assertEq(factory.treasury(), vm.parseJsonAddress(json, ".treasury"));
        // Exactly the documented fields, so apply-deployment can rely on the format.
        string[] memory keys = vm.parseJsonKeys(json, "$");
        string[8] memory documented =
            ["block", "chainId", "confirmed", "factory", "hook", "owner", "router", "treasury"];
        assertEq(keys.length, documented.length, "field count");
        for (uint256 i; i < documented.length; i++) {
            assertTrue(vm.keyExistsJson(json, string.concat(".", documented[i])), documented[i]);
        }
    }

    /// The first deployment's record (STOCK and every token before it) must stay on file as it is.
    function test_FirstDeploymentRecordIsKept() public view {
        string memory json = vm.readFile("deployments/base.json");
        assertEq(vm.parseJsonUint(json, ".chainId"), 8453);
        assertEq(vm.parseJsonUint(json, ".block"), 50_932_763);
        assertEq(vm.parseJsonAddress(json, ".factory"), 0x888BC129704A4158C07614C234bb7EB8126aAD47);
        assertEq(vm.parseJsonAddress(json, ".hook"), 0xC81a728c6F4034e9249bB905f30E3013CA95E0Cc);
        assertEq(vm.parseJsonAddress(json, ".router"), 0x7Cb00fACE8a634FC0A2A953a562C15f3F67F96a8);
        assertFalse(vm.keyExistsJson(json, ".confirmed"), "predates the field; untouched");
    }

    /// An existing record for the block stops the script before anything is deployed.
    function test_NeverOverwritesARecord() public {
        vm.roll(3); // its own file, so the dry run's "no record" check cannot see this one
        string memory path = script.recordPath();
        assertFalse(vm.exists(path), "no stale record from an earlier run");
        vm.writeFile(path, "{}");
        bytes memory err;
        try script.run() { } catch (bytes memory reason) {
            err = reason;
        }
        string memory kept = vm.readFile(path);
        vm.removeFile(path);
        assertEq(kept, "{}", "the record is untouched");
        assertEq(
            err,
            abi.encodeWithSignature(
                "Error(string)", "Deploy: a deployment record for this block already exists"
            )
        );
    }
}
