// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { V4Quoter } from "@uniswap/v4-periphery/src/lens/V4Quoter.sol";
import { IV4Quoter } from "@uniswap/v4-periphery/src/interfaces/IV4Quoter.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { StockPairHook } from "../src/StockPairHook.sol";
import { StockPairRouter } from "../src/StockPairRouter.sol";
import { MockB20Factory, MockB20Token } from "./mocks/MockB20.sol";
import { MockStock } from "./mocks/MockStock.sol";
import { Fixture } from "./Fixture.sol";

contract StockPairTest is Fixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    V4Quoter quoter;
    MockB20Factory b20;
    MockStock stockLow;
    MockStock stockHigh;

    function setUp() public override {
        super.setUp();
        quoter = new V4Quoter(manager);
        b20 = MockB20Factory(B20_FACTORY);
        stockLow = MockStock(STOCK_LOW);
        stockHigh = MockStock(STOCK_HIGH);
    }

    // ---------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------

    function _launch(address stock, bytes32 salt) internal returns (address token, PoolId poolId) {
        vm.prank(creator);
        (token, poolId) = factory.launch{ value: FEE }(
            StockPairFactory.LaunchParams({
                name: "Test Token",
                symbol: "TEST",
                contractURI: "ipfs://bafkreitest",
                stock: stock,
                salt: salt
            })
        );
    }

    function _fundTrader(MockStock stock, uint256 amount) internal {
        stock.mint(trader, amount);
        vm.prank(trader);
        stock.approve(address(router), type(uint256).max);
        vm.prank(trader);
        stock.approve(address(swapper), type(uint256).max);
    }

    /// @dev Whole launched tokens per one whole stock, derived from the pool sqrt price.
    function _tokensPerStock(PoolId id, bool tokenIsCurrency0) internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = IPoolManager(address(manager)).getSlot0(id);
        uint256 rawTokensPerWholeStock;
        if (tokenIsCurrency0) {
            // price = raw stock per raw token; raw tokens per whole stock = 1e8 * 2^192 / sqrt^2
            rawTokensPerWholeStock =
                FullMath.mulDiv(FullMath.mulDiv(1e8, 1 << 96, sqrtPriceX96), 1 << 96, sqrtPriceX96);
        } else {
            // price = raw token per raw stock = sqrt^2 / 2^192
            rawTokensPerWholeStock =
                FullMath.mulDiv(FullMath.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 96), 1e8, 1 << 96);
        }
        return rawTokensPerWholeStock / 1e18;
    }

    function _impliedFdvUsd8(PoolId id, bool tokenIsCurrency0) internal view returns (uint256) {
        uint256 tokensPerStock = _tokensPerStock(id, tokenIsCurrency0);
        return (uint256(NVDA_USD8) * 1e9) / tokensPerStock;
    }

    // ---------------------------------------------------------------------------------------
    // launch
    // ---------------------------------------------------------------------------------------

    function test_LaunchWithTokenAsCurrency1() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(1)));
        assertTrue(token > STOCK_LOW, "token sorts after stock");
        StockPairFactory.Launch memory l = factory.launchOf(token);
        assertEq(l.stock, STOCK_LOW);
        assertEq(l.creator, creator);
        assertEq(l.stockUsd8, uint256(NVDA_USD8));
        assertGt(l.liquidity, 0);
        assertEq(l.tickLower, -887_200);
        (uint160 sqrtPriceX96, int24 tick,,) = IPoolManager(address(manager)).getSlot0(poolId);
        assertEq(sqrtPriceX96, l.openingSqrtPriceX96, "pool opened at derived price");
        assertGe(tick, l.tickUpper, "position sits at or below current tick");
        assertEq(IPoolManager(address(manager)).getLiquidity(poolId), 0, "current tick outside range: no active liquidity");
        assertEq(MockB20Token(token).balanceOf(address(factory)), 0, "factory keeps nothing");
        assertLt(MockB20Token(token).balanceOf(factory.DUST_SINK()), 1e18, "dust below one token");
        assertEq(treasury.balance, FEE, "creation fee forwarded");
        assertEq(factory.tokenCount(), 1);
        uint256 fdv = _impliedFdvUsd8(poolId, false);
        assertApproxEqRel(fdv, 5_000e8, 0.002e18, "opens at 5,000 USD FDV");
        StockPairHook.PoolInfo memory info = hook.poolInfo(poolId);
        assertEq(info.token, token);
        assertEq(info.stock, STOCK_LOW);
        assertEq(info.creator, creator);
    }

    function test_LaunchWithTokenAsCurrency0() public {
        (address token, PoolId poolId) = _launch(STOCK_HIGH, bytes32(uint256(2)));
        assertTrue(token < STOCK_HIGH, "token sorts before stock");
        StockPairFactory.Launch memory l = factory.launchOf(token);
        assertEq(l.tickUpper, 887_200);
        (uint160 sqrtPriceX96, int24 tick,,) = IPoolManager(address(manager)).getSlot0(poolId);
        assertEq(sqrtPriceX96, l.openingSqrtPriceX96);
        assertLt(tick, l.tickLower, "position sits strictly above current tick");
        assertEq(MockB20Token(token).balanceOf(address(factory)), 0);
        uint256 fdv = _impliedFdvUsd8(poolId, true);
        assertApproxEqRel(fdv, 5_000e8, 0.002e18, "opens at 5,000 USD FDV");
    }

    function test_LaunchedTokenIsFixedSupplyZeroAdmin() public {
        (address token,) = _launch(STOCK_LOW, bytes32(uint256(3)));
        MockB20Token t = MockB20Token(token);
        assertEq(t.name(), "Test Token");
        assertEq(t.symbol(), "TEST");
        assertEq(t.decimals(), 18);
        assertEq(t.totalSupply(), factory.SUPPLY());
        assertEq(t.supplyCap(), factory.SUPPLY());
        assertEq(t.contractURI(), "ipfs://bafkreitest");
        vm.expectRevert();
        t.mint(address(this), 1);
    }

    function test_PredictTokenMatchesLaunch() public {
        bytes32 salt = bytes32(uint256(4));
        address predicted = b20.predict(
            address(factory), keccak256(abi.encode(creator, salt)), "Test Token", "TEST"
        );
        (address token,) = _launch(STOCK_LOW, salt);
        assertEq(token, predicted);
    }

    function test_LaunchRejectsDisabledStock() public {
        vm.prank(owner);
        factory.setStockEnabled(STOCK_LOW, false);
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.StockNotEnabled.selector);
        factory.launch{ value: FEE }(
            StockPairFactory.LaunchParams("A", "A", "", STOCK_LOW, bytes32(0))
        );
    }

    function test_LaunchRejectsStaleFeed() public {
        feed.set(NVDA_USD8, block.timestamp - 8 days);
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.StaleFeed.selector);
        factory.launch{ value: FEE }(
            StockPairFactory.LaunchParams("A", "A", "", STOCK_LOW, bytes32(0))
        );
    }

    function test_LaunchAcceptsWeekendOldFeed() public {
        feed.set(NVDA_USD8, block.timestamp - 3 days);
        (address token,) = _launch(STOCK_LOW, bytes32(uint256(5)));
        assertTrue(token != address(0));
    }

    function test_LaunchRejectsWrongCreationFee() public {
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.WrongCreationFee.selector);
        factory.launch{ value: 0.002 ether }(
            StockPairFactory.LaunchParams("A", "A", "", STOCK_LOW, bytes32(0))
        );
    }

    function test_LaunchRejectsBadText() public {
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.InvalidText.selector);
        factory.launch{ value: FEE }(
            StockPairFactory.LaunchParams("", "A", "", STOCK_LOW, bytes32(0))
        );
    }

    function test_SameSaltTwiceFails() public {
        _launch(STOCK_LOW, bytes32(uint256(6)));
        vm.prank(creator);
        vm.expectRevert();
        factory.launch{ value: FEE }(
            StockPairFactory.LaunchParams("Test Token", "TEST", "", STOCK_LOW, bytes32(uint256(6)))
        );
    }

    function test_OnlyFactoryCanInitializePoolsWithHook() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(STOCK_LOW),
            currency1: Currency.wrap(STOCK_HIGH),
            fee: 0,
            tickSpacing: 100,
            hooks: IHooks(address(hook))
        });
        vm.expectRevert();
        manager.initialize(key, TickMath.getSqrtPriceAtTick(0));
    }

    // ---------------------------------------------------------------------------------------
    // trading and fees
    // ---------------------------------------------------------------------------------------

    function test_BuyExactInChargesOnePercentInStock() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(10)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);

        uint128 amountIn = 1e8; // one NVDAc
        (uint256 quoted,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: key, zeroForOne: true, exactAmount: amountIn, hookData: ""
            })
        );
        assertGt(quoted, 0);

        vm.prank(trader);
        uint256 out =
            router.swapExactIn(key, true, amountIn, uint128(quoted), trader, block.timestamp);
        assertEq(out, quoted, "router output equals quoter output");
        assertEq(MockB20Token(token).balanceOf(trader), out);
        assertEq(stockLow.balanceOf(trader), 100e8 - amountIn, "trader paid exactly amountIn");

        uint256 fee = amountIn / 100;
        assertEq(manager.balanceOf(address(hook), uint160(STOCK_LOW)), fee, "hook holds the fee as claims");
        assertEq(hook.claimable(STOCK_LOW, creator), (fee * 7_000) / 10_000);
        assertEq(hook.claimable(STOCK_LOW, treasury), fee - (fee * 7_000) / 10_000);
        assertEq(hook.totalFees(poolId), fee);
        assertEq(stockLow.balanceOf(address(manager)), amountIn, "manager holds input; fee is a claim");
        assertGt(IPoolManager(address(manager)).getLiquidity(poolId), 0, "price moved into the locked range");
    }

    function test_SellExactInChargesOnePercentOfStockOutput() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(11)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        uint256 bought = router.swapExactIn(key, true, 5e8, 0, trader, block.timestamp);
        uint256 feeAfterBuy = hook.totalFees(poolId);

        vm.prank(trader);
        MockB20Token(token).approve(address(router), type(uint256).max);
        uint128 sellAmount = uint128(bought / 2);
        (uint256 quoted,) = quoter.quoteExactInputSingle(
            IV4Quoter.QuoteExactSingleParams({
                poolKey: key, zeroForOne: false, exactAmount: sellAmount, hookData: ""
            })
        );
        uint256 stockBefore = stockLow.balanceOf(trader);
        vm.prank(trader);
        uint256 out = router.swapExactIn(key, false, sellAmount, uint128(quoted), trader, block.timestamp);
        assertEq(out, quoted, "quoter includes the hook fee");
        assertEq(stockLow.balanceOf(trader) - stockBefore, out);

        uint256 sellFee = hook.totalFees(poolId) - feeAfterBuy;
        // fee is 1% of gross output; trader received gross - fee
        assertApproxEqAbs(sellFee, (out + sellFee) / 100, 1, "sell fee is 1% of gross stock out");
        assertEq(manager.balanceOf(address(hook), uint160(STOCK_LOW)), hook.totalFees(poolId));
    }

    function test_BuyExactOutChargesFeeOnStockInput() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(12)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);

        uint256 wantTokens = 1_000_000e18;
        uint256 stockBefore = stockLow.balanceOf(trader);
        vm.prank(trader);
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: true,
                amountSpecified: int256(wantTokens),
                sqrtPriceLimitX96: TickMath.MIN_SQRT_PRICE + 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        assertEq(MockB20Token(token).balanceOf(trader), wantTokens, "exact output honoured");
        uint256 paid = stockBefore - stockLow.balanceOf(trader);
        uint256 fee = hook.totalFees(poolId);
        assertGt(fee, 0);
        assertApproxEqAbs(fee, (paid - fee) / 100, 1, "fee is 1% of the pool input");
    }

    function test_SellExactOutChargesFeeOnStockOutput() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(13)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        router.swapExactIn(key, true, 10e8, 0, trader, block.timestamp);
        uint256 feeAfterBuy = hook.totalFees(poolId);
        vm.prank(trader);
        MockB20Token(token).approve(address(swapper), type(uint256).max);

        uint256 wantStock = 1e8;
        uint256 stockBefore = stockLow.balanceOf(trader);
        vm.prank(trader);
        swapper.swap(
            key,
            SwapParams({
                zeroForOne: false,
                amountSpecified: int256(wantStock),
                sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        assertEq(stockLow.balanceOf(trader) - stockBefore, wantStock, "trader gets the exact stock amount");
        uint256 sellFee = hook.totalFees(poolId) - feeAfterBuy;
        assertEq(sellFee, wantStock / 100, "fee is 1% on top of the exact output");
    }

    /// The fee does not move with the clock. There used to be a twenty-second window opening at
    /// 99%, and it is gone: a token trades on the same terms in its launch block as it will a week
    /// later.
    function test_FeeIsOnePercentFromTheLaunchBlock() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(14)));
        assertEq(hook.currentFeeBps(poolId), 100, "launch block");
        vm.warp(block.timestamp + 1);
        assertEq(hook.currentFeeBps(poolId), 100, "one second in");
        vm.warp(block.timestamp + 19);
        assertEq(hook.currentFeeBps(poolId), 100, "where the window used to end");
        vm.warp(block.timestamp + 1_000);
        assertEq(hook.currentFeeBps(poolId), 100, "later");
        assertTrue(token != address(0));
    }

    /// The creator's own first buy is the case the old window hurt most: it charged them 99% of
    /// what they handed over, while a bot using an exact-output router paid the same fee on the far
    /// smaller amount entering the pool.
    function test_BuyingInTheLaunchBlockCostsWhatAnyOtherBuyCosts() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(15)));
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        router.swapExactIn(key, true, 1e8, 0, trader, block.timestamp);
        assertEq(hook.totalFees(poolId), 0.01e8, "1% of the input, in the launch block");
        assertEq(manager.balanceOf(address(hook), uint160(STOCK_LOW)), 0.01e8, "and it sits as hook claims");
    }

    /// Two identical buys on one token, one in the launch block and one an hour later, cost the
    /// same. Under the old schedule the first would have paid ninety-nine times the second.
    function test_LaunchBlockAndLaterBuysPayTheSameFee() public {
        (address token, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(31)));
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);

        vm.prank(trader);
        router.swapExactIn(key, true, 5e8, 0, trader, block.timestamp);
        uint256 inLaunchBlock = hook.totalFees(poolId);

        vm.warp(block.timestamp + 3_600);
        vm.prank(trader);
        router.swapExactIn(key, true, 5e8, 0, trader, block.timestamp);
        uint256 anHourLater = hook.totalFees(poolId) - inLaunchBlock;

        assertEq(inLaunchBlock, 0.05e8, "1% of 5 stock");
        assertEq(anHourLater, inLaunchBlock, "the clock does not change the price");
    }

    function test_ClaimSplitsSeventyThirty() public {
        (address token,) = _launch(STOCK_LOW, bytes32(uint256(16)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        router.swapExactIn(key, true, 10e8, 0, trader, block.timestamp);

        uint256 fee = 10e8 / 100;
        vm.prank(creator);
        uint256 got = hook.claim(STOCK_LOW);
        assertEq(got, (fee * 7_000) / 10_000);
        assertEq(stockLow.balanceOf(creator), got);
        vm.prank(creator);
        vm.expectRevert(StockPairHook.NothingToClaim.selector);
        hook.claim(STOCK_LOW);

        address[] memory stocks = new address[](2);
        stocks[0] = STOCK_LOW;
        stocks[1] = STOCK_HIGH;
        vm.prank(treasury);
        uint256[] memory amounts = hook.claimMany(stocks);
        assertEq(amounts[0], fee - (fee * 7_000) / 10_000);
        assertEq(amounts[1], 0);
        assertEq(manager.balanceOf(address(hook), uint160(STOCK_LOW)), 0, "claims fully redeemed");
        assertEq(stockLow.balanceOf(address(manager)), 10e8 - fee, "manager paid out the claimed fee");
    }

    function test_TreasuryChangeAffectsFutureFeesOnly() public {
        (address token,) = _launch(STOCK_LOW, bytes32(uint256(17)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        router.swapExactIn(key, true, 1e8, 0, trader, block.timestamp);
        address treasury2 = makeAddr("treasury2");
        vm.prank(owner);
        factory.setTreasury(treasury2);
        vm.prank(trader);
        router.swapExactIn(key, true, 1e8, 0, trader, block.timestamp);
        assertEq(hook.claimable(STOCK_LOW, treasury), 0.3e6);
        assertEq(hook.claimable(STOCK_LOW, treasury2), 0.3e6);
    }

    function test_RouterRejectsSlippageAndDeadline() public {
        (address token,) = _launch(STOCK_LOW, bytes32(uint256(18)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        vm.expectRevert(StockPairRouter.TooLittleReceived.selector);
        router.swapExactIn(key, true, 1e8, type(uint128).max, trader, block.timestamp);
        vm.prank(trader);
        vm.expectRevert(StockPairRouter.Expired.selector);
        router.swapExactIn(key, true, 1e8, 0, trader, block.timestamp - 1);
    }

    function test_RoundTripKeepsFactoryAndRouterEmpty() public {
        (address token,) = _launch(STOCK_LOW, bytes32(uint256(19)));
        vm.warp(block.timestamp + 21);
        PoolKey memory key = factory.poolKeyOf(token);
        _fundTrader(stockLow, 100e8);
        vm.prank(trader);
        uint256 bought = router.swapExactIn(key, true, 3e8, 0, trader, block.timestamp);
        vm.prank(trader);
        MockB20Token(token).approve(address(router), type(uint256).max);
        vm.prank(trader);
        router.swapExactIn(key, false, uint128(bought), 0, trader, block.timestamp);
        assertEq(MockB20Token(token).balanceOf(address(router)), 0);
        assertEq(stockLow.balanceOf(address(router)), 0);
        assertEq(MockB20Token(token).balanceOf(address(factory)), 0);
        assertLt(stockLow.balanceOf(trader), 100e8, "fees were paid on both legs");
        assertGt(stockLow.balanceOf(trader), 97e8, "but not more than ~2% plus curve loss");
    }

    function test_PreviewOpeningMatchesLaunch() public {
        bytes32 salt = bytes32(uint256(20));
        address predicted = b20.predict(
            address(factory), keccak256(abi.encode(creator, salt)), "Test Token", "TEST"
        );
        (uint160 previewSqrt,,) = factory.previewOpening(STOCK_LOW, predicted);
        (address token,) = _launch(STOCK_LOW, salt);
        assertEq(factory.launchOf(token).openingSqrtPriceX96, previewSqrt);
    }

    function testFuzz_OpeningFdvIsStableAcrossStockPrices(uint64 stockUsd8) public {
        stockUsd8 = uint64(bound(stockUsd8, 1e8, 20_000e8)); // 1 USD .. 20,000 USD per share
        feed.set(int256(uint256(stockUsd8)), block.timestamp);
        (, PoolId poolId) = _launch(STOCK_LOW, bytes32(uint256(uint64(stockUsd8))));
        uint256 tokensPerStock = _tokensPerStock(poolId, false);
        uint256 fdv = (uint256(stockUsd8) * 1e9) / tokensPerStock;
        assertApproxEqRel(fdv, 5_000e8, 0.01e18);
    }

    function test_treasuryCannotBeZero() public {
        vm.prank(owner);
        vm.expectRevert(StockPairFactory.ZeroAddress.selector);
        factory.setTreasury(address(0));
    }

    function test_defaultCreationFee() public view {
        assertEq(factory.creationFee(), 0.0001 ether);
    }
}
