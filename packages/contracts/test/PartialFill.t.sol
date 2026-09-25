// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { StockPairHook } from "../src/StockPairHook.sol";
import { MockB20Token } from "./mocks/MockB20.sol";
import { MockStock } from "./mocks/MockStock.sol";
import { Fixture } from "./Fixture.sol";

contract PartialFillTest is Fixture {
    using StateLibrary for IPoolManager;

    PoolSwapTest.TestSettings settings = PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false });

    function _launch(address stock, bytes32 salt) internal returns (address token, PoolId id) {
        vm.prank(creator);
        (token, id) = factory.launch{ value: FEE }(_params(stock, salt));
        MockStock(stock).mint(trader, 1e20);
        vm.startPrank(trader);
        MockStock(stock).approve(address(swapper), type(uint256).max);
        MockB20Token(token).approve(address(swapper), type(uint256).max);
        vm.stopPrank();
    }

    function _swap(PoolKey memory key, bool zeroForOne, int256 amount, uint160 limit)
        internal
        returns (bool ok, bytes memory err)
    {
        vm.prank(trader);
        try swapper.swap(key, SwapParams(zeroForOne, amount, limit), settings, "") {
            ok = true;
        } catch (bytes memory reason) {
            err = reason;
        }
    }

    function _contains(bytes memory data, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 <= data.length; i++) {
            if (data[i] == sel[0] && data[i + 1] == sel[1] && data[i + 2] == sel[2] && data[i + 3] == sel[3]) {
                return true;
            }
        }
        return false;
    }

    function _lim(bool zeroForOne) internal pure returns (uint160) {
        return zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1;
    }

    /// Exact-in buy capped by a price limit just past the range edge: the old hook took 1% of the
    /// full 1,000 stocks while the pool used a few raw units. Now the swap reverts.
    function test_ExactInBuyStoppedByPriceLimitReverts() public {
        (address token, PoolId id) = _launch(STOCK_LOW, bytes32(uint256(1)));
        StockPairFactory.Launch memory l = factory.launchOf(token);
        PoolKey memory key = factory.poolKeyOf(token);
        uint160 limit = TickMath.getSqrtPriceAtTick(l.tickUpper - 1);
        (bool ok, bytes memory err) = _swap(key, true, -int256(1_000e8), limit);
        assertFalse(ok, "partial buy must revert");
        assertTrue(_contains(err, StockPairHook.PartialFill.selector), "PartialFill inside WrappedError");
        assertEq(hook.totalFees(id), 0);
    }

    /// Exact-out asking for more stock than the pool holds reverts; one it can fill (the amount
    /// plus the 1% fee within reserves) still delivers exactly the amount asked for.
    function test_ExactOutStockBeyondReservesReverts() public {
        (address token, PoolId id) = _launch(STOCK_LOW, bytes32(uint256(2)));
        PoolKey memory key = factory.poolKeyOf(token);
        (bool bought,) = _swap(key, true, -int256(1e8), _lim(true));
        assertTrue(bought);
        (bool ok, bytes memory err) = _swap(key, false, int256(50e8), _lim(false));
        assertFalse(ok);
        assertTrue(_contains(err, StockPairHook.PartialFill.selector));

        uint256 reserves = MockStock(STOCK_LOW).balanceOf(address(manager)) - hook.totalFees(id);
        uint256 y = reserves * 98 / 100;
        assertLe(y + y / 100, reserves, "fillable: amount plus fee within reserves");
        uint256 before = MockStock(STOCK_LOW).balanceOf(trader);
        (ok,) = _swap(key, false, int256(y), _lim(false));
        assertTrue(ok, "a fillable exact-out sell goes through");
        assertEq(MockStock(STOCK_LOW).balanceOf(trader) - before, y, "exactly y delivered");
    }

    /// When the token is the specified side the fee is 1% of the stock the pool really moved, so a
    /// partial fill is charged only for what filled and goes through.
    function test_TokenSpecifiedPartialFillIsChargedOnActual() public {
        (address token, PoolId id) = _launch(STOCK_LOW, bytes32(uint256(3)));
        PoolKey memory key = factory.poolKeyOf(token);
        _swap(key, true, -int256(10e8), _lim(true));
        uint256 before = hook.totalFees(id);
        (uint160 sp,,,) = IPoolManager(address(manager)).getSlot0(id);
        uint256 stockBefore = MockStock(STOCK_LOW).balanceOf(trader);
        (bool ok,) = _swap(key, false, -int256(1e30), sp + (sp >> 12)); // sell far more than fills
        assertTrue(ok);
        uint256 got = MockStock(STOCK_LOW).balanceOf(trader) - stockBefore;
        uint256 fee = hook.totalFees(id) - before;
        assertApproxEqAbs(fee, (got + fee) / 100, 1, "1% of the stock actually paid out");
    }

    /// Twelve random swaps across all four kinds; returns how many filled. The guard must never
    /// fire on a swap the pool could fill.
    function _randomSwaps(uint256 seed, address stock, address token, PoolKey memory key)
        internal
        returns (uint256 filled)
    {
        bool buyZeroForOne = key.currency0.toId() == uint160(stock);
        for (uint256 i; i < 12; i++) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 kind = r % 4;
            int256 amount;
            bool zeroForOne;
            if (kind == 0) {
                zeroForOne = buyZeroForOne; // exact-in buy (stock specified)
                amount = -int256(1 + (r >> 8) % 50e8);
            } else if (kind == 1) {
                zeroForOne = buyZeroForOne; // exact-out buy (token specified)
                amount = int256(1 + (r >> 8) % 1_000_000e18);
            } else if (kind == 2) {
                uint256 held = MockB20Token(token).balanceOf(trader);
                if (held == 0) continue;
                zeroForOne = !buyZeroForOne; // exact-in sell (token specified)
                amount = -int256(1 + (r >> 8) % held);
            } else {
                uint256 poolStock = MockStock(stock).balanceOf(address(manager))
                    - manager.balanceOf(address(hook), uint160(stock))
                    - manager.protocolFeesAccrued(Currency.wrap(stock));
                if (poolStock < 4) continue;
                zeroForOne = !buyZeroForOne; // exact-out sell (stock specified)
                amount = int256(1 + (r >> 8) % (poolStock / 2));
            }
            (bool ok, bytes memory err) = _swap(key, zeroForOne, amount, _lim(zeroForOne));
            assertFalse(_contains(err, StockPairHook.PartialFill.selector), "false positive");
            if (ok) filled++;
        }
    }

    /// Full fills never trip the guard, in every direction and both token orderings.
    function testFuzz_FullFillsNeverTrip(uint256 seed, bool high) public {
        address stock = high ? STOCK_HIGH : STOCK_LOW;
        (address token,) = _launch(stock, bytes32(seed));
        uint256 filled = _randomSwaps(seed, stock, token, factory.poolKeyOf(token));
        assertGt(filled, 0, "the run exercised real swaps");
    }

    /// Same with a v4 protocol fee on both directions: the fee is taken inside the pool's own
    /// accounting, so a full fill still leaves nothing of the specified amount unfilled.
    function testFuzz_FullFillsNeverTrip_WithProtocolFee(
        uint256 seed,
        bool high,
        uint16 zeroForOneFee,
        uint16 oneForZeroFee
    ) public {
        zeroForOneFee = uint16(bound(zeroForOneFee, 1, 1000));
        oneForZeroFee = uint16(bound(oneForZeroFee, 1, 1000));
        address stock = high ? STOCK_HIGH : STOCK_LOW;
        (address token, PoolId id) = _launch(stock, bytes32(seed));
        PoolKey memory key = factory.poolKeyOf(token);
        manager.setProtocolFeeController(address(this));
        manager.setProtocolFee(key, (uint24(oneForZeroFee) << 12) | uint24(zeroForOneFee));
        (,, uint24 protocolFee,) = IPoolManager(address(manager)).getSlot0(id);
        assertEq(protocolFee & 0xfff, zeroForOneFee, "protocol fee is live");
        uint256 filled = _randomSwaps(seed, stock, token, key);
        assertGt(filled, 0, "the run exercised real swaps");
    }
}
