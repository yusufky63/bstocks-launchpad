// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { HookMiner } from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { StockPairHook } from "../src/StockPairHook.sol";
import { StockPairRouter } from "../src/StockPairRouter.sol";
import { BaseStocks } from "./Stocks.sol";

/// @notice Deploys the StockPair contracts to Base mainnet and registers the Coinbase stocks.
///
///   forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC_URL --broadcast \
///     --private-key $DEPLOYER_PRIVATE_KEY --verify --etherscan-api-key $BASESCAN_API_KEY
///
///   Optional env: TREASURY (defaults to the deployer), OWNER (defaults to the deployer).
///
///   Each deployment is recorded in its own file, deployments/base-<block>.json, and an existing
///   record is never overwritten: earlier factories stay live, so their addresses must stay on
///   file. A dry run just prints the record; a `--broadcast` run writes it.
///
///   The record is written while forge runs this script locally, BEFORE any transaction is sent:
///   forge treats the whole `--broadcast` run as broadcast context. A broadcast that then fails
///   (no gas funds, an RPC or nonce error, a partial send) leaves the file behind with addresses
///   that may hold no code, so the record never claims the deployment happened. It is still
///   written here because `forge script --resume` finishes a broadcast without re-running this.
///   One JSON object:
///     chainId    8453
///     block      the block the script simulated against, not where the contracts landed (the
///                receipts in broadcast/Deploy.s.sol/8453/run-latest.json say that)
///     factory, hook, router   the addresses the broadcast deploys to
///     owner, treasury         what the factory was configured with
///     confirmed  always false here. scripts/apply-deployment.mjs confirms a record before it
///                lists the deployment: a successful receipt for every transaction in
///                run-latest.json, or failing that, code onchain at factory, hook and router.
///   deployments/base.json, the first deployment (STOCK's), predates `confirmed`; it is live.
contract Deploy is Script {
    address constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    /// @dev Deterministic CREATE2 proxy used by forge for `new C{salt: ...}` inside broadcasts.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        require(block.chainid == 8453, "Deploy: Base mainnet only");
        // Checked before anything is sent, so a clash can never leave a deployment unrecorded.
        require(
            !vm.exists(recordPath()), "Deploy: a deployment record for this block already exists"
        );
        address deployer = msg.sender;
        address owner = vm.envOr("OWNER", deployer);
        address treasury = vm.envOr("TREASURY", deployer);

        vm.startBroadcast();

        StockPairFactory factory =
            new StockPairFactory(IPoolManager(BASE_POOL_MANAGER), owner, treasury);

        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address predicted, bytes32 salt) = HookMiner.find(
            CREATE2_DEPLOYER,
            flags,
            type(StockPairHook).creationCode,
            abi.encode(IPoolManager(BASE_POOL_MANAGER), address(factory))
        );
        StockPairHook hook =
            new StockPairHook{ salt: salt }(IPoolManager(BASE_POOL_MANAGER), address(factory));
        require(address(hook) == predicted, "Deploy: hook address mismatch");

        factory.setHook(hook);
        StockPairRouter router = new StockPairRouter(IPoolManager(BASE_POOL_MANAGER));

        BaseStocks.Entry[] memory stocks = BaseStocks.all();
        for (uint256 i = 0; i < stocks.length; i++) {
            // All Coinbase stock tokens use 8 decimals (verified onchain, see docs.base.org).
            factory.addStock(stocks[i].token, stocks[i].feed, stocks[i].symbol, 8);
        }
        // Registered but closed for launches until Coinbase mints them on Base (supply is 0 today).
        address[3] memory unissued = [
            0xb200000000000000000000c85a31389D71F3ecfb, // COINc
            0xB20000000000000000000019f6E7C675b73C2e4D, // CRCLc
            0xB2000000000000000000004AFF16039bA04bdFBc // INTCc
        ];
        for (uint256 i = 0; i < unissued.length; i++) {
            factory.setStockEnabled(unissued[i], false);
        }

        vm.stopBroadcast();

        _record(address(factory), address(hook), address(router), owner, treasury);

        console2.log("factory", address(factory));
        console2.log("hook", address(hook));
        console2.log("router", address(router));
        console2.log("deploy block", block.number);
    }

    /// @notice Where this run records its deployment: labelled by block, never by version.
    function recordPath() public view returns (string memory) {
        return string.concat("deployments/base-", vm.toString(block.number), ".json");
    }

    function _record(address factory, address hook, address router, address owner, address treasury)
        private
    {
        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "factory", factory);
        vm.serializeAddress(json, "hook", hook);
        vm.serializeAddress(json, "router", router);
        vm.serializeAddress(json, "owner", owner);
        vm.serializeAddress(json, "treasury", treasury);
        // Nothing has been sent yet when this runs; see the contract notes.
        string memory out = vm.serializeBool(json, "confirmed", false);
        if (_broadcasting()) {
            vm.writeJson(out, recordPath());
            console2.log("recorded, unconfirmed until the broadcast lands:", recordPath());
        } else {
            console2.log("dry run, not recorded:", out);
        }
    }

    /// @dev Whether this run writes the record. A seam for the tests, which cannot enter forge's
    ///      broadcast context themselves.
    function _broadcasting() internal view virtual returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
    }
}
