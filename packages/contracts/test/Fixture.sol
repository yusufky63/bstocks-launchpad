// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { PoolManager } from "@uniswap/v4-core/src/PoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { HookMiner } from "@uniswap/v4-periphery/test/shared/HookMiner.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { StockPairHook } from "../src/StockPairHook.sol";
import { StockPairRouter } from "../src/StockPairRouter.sol";
import { MockB20Factory } from "./mocks/MockB20.sol";
import { MockFeed, MockStock } from "./mocks/MockStock.sol";

/// @notice Shared deployment for every suite: PoolManager, the mock B20 precompile etched at its
///         canonical address, two 8-decimal stocks (one sorting below any token, one above),
///         one feed, and the factory, hook and router wired as Deploy.s.sol wires them.
abstract contract Fixture is Test {
    address constant B20_FACTORY = 0xB20f000000000000000000000000000000000000;
    address constant STOCK_LOW = 0x0000000000000000000000000000000000001000;
    address constant STOCK_HIGH = 0xffffFfFFFFfffFfFfffFffFffFfFfFfFfFFFf000;
    int256 constant NVDA_USD8 = 229_95730000; // 229.9573 USD
    uint256 constant Q96 = 1 << 96;
    uint256 constant SUPPLY = 1_000_000_000e18;

    PoolManager manager;
    PoolSwapTest swapper;
    MockFeed feed;
    StockPairFactory factory;
    StockPairHook hook;
    StockPairRouter router;
    address owner = makeAddr("owner");
    address treasury = makeAddr("treasury");
    address creator = makeAddr("creator");
    address trader = makeAddr("trader");
    uint256 FEE;
    /// Cached so building options makes no external call (which would consume vm.prank).
    uint256 FDV;

    function setUp() public virtual {
        vm.warp(1_757_000_000);
        manager = new PoolManager(address(this));
        swapper = new PoolSwapTest(manager);
        MockB20Factory impl = new MockB20Factory();
        vm.etch(B20_FACTORY, address(impl).code);
        deployCodeTo("MockStock.sol:MockStock", abi.encode("NVIDIA", "NVDAc"), STOCK_LOW);
        deployCodeTo("MockStock.sol:MockStock", abi.encode("Tesla", "TSLAc"), STOCK_HIGH);
        feed = new MockFeed("NVDA", NVDA_USD8);
        factory = new StockPairFactory(manager, owner, treasury);
        FEE = factory.creationFee();
        FDV = factory.openingFdvUsd8();
        uint160 flags = uint160(
            Hooks.BEFORE_INITIALIZE_FLAG | Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_SWAP_FLAG
                | Hooks.BEFORE_SWAP_RETURNS_DELTA_FLAG | Hooks.AFTER_SWAP_RETURNS_DELTA_FLAG
        );
        (address predicted, bytes32 salt) = HookMiner.find(
            address(this), flags, type(StockPairHook).creationCode, abi.encode(manager, address(factory))
        );
        hook = new StockPairHook{ salt: salt }(manager, address(factory));
        assertEq(address(hook), predicted, "mined hook address");
        router = new StockPairRouter(manager);
        vm.startPrank(owner);
        factory.setHook(hook);
        factory.addStock(STOCK_LOW, address(feed), "NVDAc", 8);
        factory.addStock(STOCK_HIGH, address(feed), "TSLAc", 8);
        vm.stopPrank();
        vm.deal(creator, 1 ether);
        vm.deal(trader, 1 ether);
    }

    // ---- params -------------------------------------------------------------------------------

    function _params(address stock, bytes32 salt)
        internal
        pure
        returns (StockPairFactory.LaunchParams memory)
    {
        return StockPairFactory.LaunchParams("Test Token", "TEST", "ipfs://bafkreitest", stock, salt);
    }

    function _options(bool editable) internal view returns (StockPairFactory.LaunchOptions memory) {
        return StockPairFactory.LaunchOptions({
            metadataEditable: editable,
            openingFdvUsd8: FDV,
            deadline: block.timestamp + 30 minutes
        });
    }

    function _editable(address token) internal view returns (bool) {
        return factory.metadataStatus(token) == StockPairFactory.MetadataStatus.Editable;
    }

    /// The pool key a launch of `token` against `stock` will use, built without asking the factory.
    function _keyFor(address token, address stock) internal view returns (PoolKey memory) {
        bool c0 = token < stock;
        return PoolKey({
            currency0: Currency.wrap(c0 ? token : stock),
            currency1: Currency.wrap(c0 ? stock : token),
            fee: 0,
            tickSpacing: 100,
            hooks: IHooks(address(hook))
        });
    }

    function _fund(address who, address stock, uint256 amount, address spender) internal {
        MockStock(stock).mint(who, amount);
        vm.prank(who);
        MockStock(stock).approve(spender, amount);
    }

    // ---- reference math: exact replay of Pool.swap for the first exact-in buy ------------------
    // The TypeScript port in packages/core must reproduce this to the wei (vectors from forge).

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a / b + (a % b == 0 ? 0 : 1);
    }

    function _amount0Down(uint160 a, uint160 b, uint128 L) internal pure returns (uint256) {
        return FullMath.mulDiv(uint256(L) << 96, b - a, b) / a;
    }

    function _amount0Up(uint160 a, uint160 b, uint128 L) internal pure returns (uint256) {
        return _ceilDiv(FullMath.mulDivRoundingUp(uint256(L) << 96, b - a, b), a);
    }

    function _amount1Down(uint160 a, uint160 b, uint128 L) internal pure returns (uint256) {
        return FullMath.mulDiv(L, b - a, Q96);
    }

    function _amount1Up(uint160 a, uint160 b, uint128 L) internal pure returns (uint256) {
        return FullMath.mulDivRoundingUp(L, b - a, Q96);
    }

    function _nextFromAmount0Add(uint160 s, uint128 L, uint256 A) internal pure returns (uint160) {
        uint256 num1 = uint256(L) << 96;
        unchecked {
            uint256 product = A * s;
            if (product / A == s) {
                uint256 den = num1 + product;
                if (den >= num1) return uint160(FullMath.mulDivRoundingUp(num1, s, den));
            }
        }
        return uint160(_ceilDiv(num1, num1 / s + A));
    }

    function _floorDiv(int24 t, int24 d) internal pure returns (int24 q) {
        q = t / d;
        if (t < 0 && t % d != 0) q -= 1;
    }

    function refBuy(bool tokenIsC0, int24 tickLower, int24 tickUpper, uint128 L, uint256 stockIn)
        public
        pure
        returns (uint256 out)
    {
        (out,) = refBuyFull(tokenIsC0, tickLower, tickUpper, L, stockIn);
    }

    /// Same replay, also returning the pool's sqrt price after the buy.
    function refBuyFull(bool tokenIsC0, int24 tickLower, int24 tickUpper, uint128 L, uint256 stockIn)
        public
        pure
        returns (uint256 out, uint160 s)
    {
        uint256 A = stockIn - (stockIn * 100) / 10_000;
        if (tokenIsC0) {
            int24 t = tickLower;
            s = TickMath.getSqrtPriceAtTick(tickLower);
            while (true) {
                int24 c = _floorDiv(t, 100) + 1;
                int24 wordEnd = ((c >> 8) * 256 + 255) * 100;
                int24 next = wordEnd < tickUpper ? wordEnd : tickUpper;
                uint160 sT = TickMath.getSqrtPriceAtTick(next);
                uint256 inMax = _amount1Up(s, sT, L);
                if (A >= inMax) {
                    out += _amount0Down(s, sT, L);
                    A -= inMax;
                    s = sT;
                    t = next;
                    if (A == 0) break;
                    require(next != tickUpper, "exhausted");
                } else {
                    uint160 s1 = uint160(uint256(s) + (A << 96) / L);
                    out += _amount0Down(s, s1, L);
                    s = s1;
                    break;
                }
            }
        } else {
            s = TickMath.getSqrtPriceAtTick(tickUpper);
            int24 t = tickUpper - 1;
            while (true) {
                int24 c = _floorDiv(t, 100);
                int24 wordStart = (c >> 8) * 256 * 100;
                int24 next = wordStart > tickLower ? wordStart : tickLower;
                uint160 sT = TickMath.getSqrtPriceAtTick(next);
                uint256 inMax = _amount0Up(sT, s, L);
                if (A >= inMax) {
                    out += _amount1Down(sT, s, L);
                    A -= inMax;
                    s = sT;
                    t = next - 1;
                    if (A == 0) break;
                    require(next != tickLower, "exhausted");
                } else {
                    uint160 s1 = _nextFromAmount0Add(s, L, A);
                    out += _amount1Down(s1, s, L);
                    s = s1;
                    break;
                }
            }
        }
    }

    /// Range and liquidity from an opening tick, by the rule the factory applies.
    function _rangeFor(bool c0, int24 tick) internal pure returns (int24 lo, int24 hi, uint128 L) {
        int24 maxUsable = (TickMath.MAX_TICK / 100) * 100;
        int24 fl = _floorDiv(tick, 100) * 100;
        (lo, hi) = c0 ? (fl + 100, maxUsable) : (-maxUsable, fl);
        uint160 a = TickMath.getSqrtPriceAtTick(lo);
        uint160 b = TickMath.getSqrtPriceAtTick(hi);
        L = c0
            ? uint128(FullMath.mulDiv(SUPPLY, FullMath.mulDiv(a, b, Q96), b - a))
            : uint128(FullMath.mulDiv(SUPPLY, Q96, b - a));
    }

    /// Opening state rebuilt the way the web will: previewOpening + the range rule + L formula.
    function _predictOpening(address stock, address token)
        internal
        view
        returns (bool c0, int24 lo, int24 hi, uint128 L)
    {
        (, int24 tick,) = factory.previewOpening(stock, token);
        c0 = token < stock;
        (lo, hi, L) = _rangeFor(c0, tick);
    }

    /// Everything the web knows before sending: predictToken, previewOpening, the range rule.
    function _quoteLaunchBuy(address stock, bytes32 salt, uint256 stockIn)
        internal
        view
        returns (address predicted, uint256 expected)
    {
        predicted = factory.predictToken(creator, salt);
        (bool c0, int24 lo, int24 hi, uint128 L) = _predictOpening(stock, predicted);
        expected = refBuy(c0, lo, hi, L, stockIn);
    }
}
