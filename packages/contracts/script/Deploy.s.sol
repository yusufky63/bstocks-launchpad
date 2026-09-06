// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Script, console2 } from "forge-std/Script.sol";
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
contract Deploy is Script {
    address constant BASE_POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    /// @dev Deterministic CREATE2 proxy used by forge for `new C{salt: ...}` inside broadcasts.
    address constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;

    function run() external {
        require(block.chainid == 8453, "Deploy: Base mainnet only");
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

        string memory json = "deployment";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeUint(json, "block", block.number);
        vm.serializeAddress(json, "factory", address(factory));
        vm.serializeAddress(json, "hook", address(hook));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeAddress(json, "owner", owner);
        string memory out = vm.serializeAddress(json, "treasury", treasury);
        vm.writeJson(out, "deployments/base.json");

        console2.log("factory", address(factory));
        console2.log("hook", address(hook));
        console2.log("router", address(router));
        console2.log("deploy block", block.number);
    }
}
