// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Vm } from "forge-std/Test.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IERC20Errors } from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { StockPairHook } from "../src/StockPairHook.sol";
import { StockPairRouter } from "../src/StockPairRouter.sol";
import { IB20Factory } from "../src/interfaces/IB20Factory.sol";
import { MockB20Token } from "./mocks/MockB20.sol";
import { MockStock } from "./mocks/MockStock.sol";
import { Fixture } from "./Fixture.sol";

/// Stock that delivers one raw unit less than asked (fee-on-transfer).
contract FeeOnTransferStock is ERC20 {
    constructor() ERC20("Taxed", "TAXc") { }

    function decimals() public pure override returns (uint8) {
        return 8;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && value > 0) {
            super._update(from, address(0), 1);
            value -= 1;
        }
        super._update(from, to, value);
    }
}

/// Treasury that tries to trade in the pool being launched the moment it receives the creation fee.
contract SnipingTreasury {
    StockPairRouter immutable router;
    address immutable stock;
    PoolKey public key;
    bool public armed;
    bool public tried;
    bool public failed;
    uint256 public bought;

    constructor(StockPairRouter r, address s) {
        router = r;
        stock = s;
        MockStock(s).mint(address(this), 1_000e8);
        MockStock(s).approve(address(r), type(uint256).max);
    }

    function arm(PoolKey calldata k) external {
        key = k;
        armed = true;
    }

    receive() external payable {
        if (!armed) return;
        tried = true;
        bool zeroForOne = Currency.unwrap(key.currency0) == stock;
        try router.swapExactIn(key, zeroForOne, 100e8, 0, address(this), block.timestamp) returns (uint256 out) {
            bought = out;
        } catch {
            failed = true;
        }
    }
}

/// Treasury that tries to re-enter the factory.
contract ReenteringTreasury {
    StockPairFactory immutable factory;

    constructor(StockPairFactory f) {
        factory = f;
    }

    receive() external payable {
        factory.launch{ value: msg.value }(
            StockPairFactory.LaunchParams("R", "R", "", address(0x1000), bytes32(uint256(99)))
        );
    }
}

/// Smart-wallet creator: tokens must land here, not with tx.origin.
contract WalletCreator {
    function run(StockPairFactory f, address stock, uint128 stockIn, uint128 minOut, uint256 fee)
        external
        payable
        returns (address token, uint256 out)
    {
        MockStock(stock).approve(address(f), stockIn);
        (token,, out) = f.launchAndBuy{ value: fee }(
            StockPairFactory.LaunchParams("W", "W", "", stock, bytes32(uint256(1))),
            StockPairFactory.LaunchOptions(false, f.openingFdvUsd8(), block.timestamp),
            StockPairFactory.CreatorBuy(stockIn, minOut)
        );
    }
}

contract LaunchAndBuyTest is Fixture {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    bytes32 constant SWAP_TOPIC =
        keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)");
    bytes32 constant TRANSFER_TOPIC = keccak256("Transfer(address,address,uint256)");

    function _launchAndBuy(address stock, bytes32 salt, uint128 stockIn, uint128 minOut, bool editable)
        internal
        returns (address token, PoolId id, uint256 out)
    {
        vm.prank(creator);
        (token, id, out) = factory.launchAndBuy{ value: FEE }(
            _params(stock, salt), _options(editable), StockPairFactory.CreatorBuy(stockIn, minOut)
        );
    }

    // ---- happy path ----------------------------------------------------------------------------

    function _checkBuyState(address stock, address token, PoolId id, uint256 stockIn, uint256 out)
        internal
        view
    {
        assertEq(MockB20Token(token).balanceOf(creator), out, "tokens delivered to the creator");
        assertEq(MockStock(stock).balanceOf(creator), 0, "exactly stockIn pulled");
        assertEq(MockStock(stock).allowance(creator, address(factory)), 0, "exact approval used up");
        assertEq(MockStock(stock).balanceOf(address(factory)), 0, "factory never holds stock");
        assertEq(MockB20Token(token).balanceOf(address(factory)), 0, "factory never holds tokens");
        uint256 fee = (stockIn * 100) / 10_000;
        uint256 creatorShare = (fee * 7_000) / 10_000;
        assertEq(hook.totalFees(id), fee, "normal 1% fee");
        assertEq(hook.claimable(stock, creator), creatorShare, "70% back to the creator");
        assertEq(hook.claimable(stock, treasury), fee - creatorShare, "the rest to the treasury");
        assertEq(treasury.balance, FEE, "creation fee paid");
    }

    function testFuzz_OutputMatchesPrediction(uint256 stockIn, bool high) public {
        stockIn = bound(stockIn, 1, 1e8 * 1e6);
        address stock = high ? STOCK_HIGH : STOCK_LOW;
        bytes32 salt = keccak256(abi.encode(stockIn, high));
        (address predicted, uint256 expected) = _quoteLaunchBuy(stock, salt, stockIn);
        vm.assume(expected > 0);
        _fund(creator, stock, stockIn, address(factory));
        (address token, PoolId id, uint256 out) =
            _launchAndBuy(stock, salt, uint128(stockIn), uint128(expected), false);
        assertEq(token, predicted, "predicted address");
        assertEq(out, expected, "exact to the wei");
        _checkBuyState(stock, token, id, stockIn, out);
    }

    function _checkBought(Vm.Log memory log, address token, PoolId id, uint256 out) internal view {
        assertEq(log.emitter, address(factory));
        assertEq(log.topics[1], bytes32(uint256(uint160(token))));
        assertEq(log.topics[2], bytes32(uint256(uint160(creator))));
        assertEq(log.topics[3], PoolId.unwrap(id));
        (uint256 stockIn, uint256 fee, uint256 tokensOut) =
            abi.decode(log.data, (uint256, uint256, uint256));
        assertEq(stockIn, 5e8);
        assertEq(fee, 5e6);
        assertEq(tokensOut, out);
    }

    /// First log with `topic` at or after `from`; reverts the test if there is none.
    function _indexOf(Vm.Log[] memory logs, bytes32 topic, uint256 from) internal pure returns (uint256) {
        for (uint256 i = from; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) return i;
        }
        revert("log not found");
    }

    function _has(Vm.Log[] memory logs, bytes32 topic) internal pure returns (bool) {
        for (uint256 i; i < logs.length; i++) {
            if (logs[i].topics.length > 0 && logs[i].topics[0] == topic) return true;
        }
        return false;
    }

    /// RoleGranted -> Initialize -> ModifyLiquidity -> PoolRegistered -> Launched -> MetadataEditable
    /// -> FeeCharged -> Swap -> Transfer -> CreatorBought. The indexer relies on Launched first.
    function test_EventsAndLogOrder() public {
        bytes32 salt = bytes32(uint256(7));
        (, uint256 expected) = _quoteLaunchBuy(STOCK_LOW, salt, 5e8);
        _fund(creator, STOCK_LOW, 5e8, address(factory));
        vm.recordLogs();
        (address token, PoolId id, uint256 out) = _launchAndBuy(STOCK_LOW, salt, 5e8, uint128(expected), true);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 granted = _indexOf(logs, MockB20Token.RoleGranted.selector, 0);
        uint256 initialized = _indexOf(logs, IPoolManager.Initialize.selector, granted);
        uint256 seeded = _indexOf(logs, IPoolManager.ModifyLiquidity.selector, initialized);
        uint256 registered = _indexOf(logs, StockPairHook.PoolRegistered.selector, seeded);
        uint256 launched = _indexOf(logs, StockPairFactory.Launched.selector, registered);
        uint256 editable = _indexOf(logs, StockPairFactory.MetadataEditable.selector, launched);
        uint256 charged = _indexOf(logs, StockPairHook.FeeCharged.selector, editable);
        uint256 swap = _indexOf(logs, SWAP_TOPIC, charged);
        uint256 bought = _indexOf(logs, StockPairFactory.CreatorBought.selector, swap);
        assertEq(editable, launched + 1, "MetadataEditable is the very next log after Launched");
        assertEq(logs[bought - 1].topics[0], TRANSFER_TOPIC, "tokens delivered right before");
        assertEq(logs[bought - 1].emitter, token);
        assertEq(logs[bought - 1].topics[2], bytes32(uint256(uint160(creator))));
        assertEq(logs.length, bought + 1, "CreatorBought is the last log");
        _checkBought(logs[bought], token, id, out);
    }

    /// The stock goes from the creator to the PoolManager in one transferFrom; the factory never
    /// holds it, not even for the length of the call.
    function test_StockMovesStraightFromCallerToPoolManager() public {
        _fund(creator, STOCK_LOW, 2e8, address(factory));
        vm.expectCall(
            STOCK_LOW, abi.encodeCall(IERC20.transferFrom, (creator, address(manager), 2e8)), 1
        );
        vm.expectCall(
            STOCK_LOW, abi.encodeCall(IERC20.transferFrom, (creator, address(factory), 2e8)), 0
        );
        vm.expectCall(STOCK_LOW, abi.encodeWithSelector(IERC20.transfer.selector), 0);
        _launchAndBuy(STOCK_LOW, bytes32(uint256(3)), 2e8, 1, false);
    }

    function test_SameAsLaunchThenImmediateRouterBuy() public {
        bytes32 salt = bytes32(uint256(8));
        uint256 snap = vm.snapshotState();
        _fund(creator, STOCK_LOW, 3e8, address(factory));
        (,, uint256 atomic) = _launchAndBuy(STOCK_LOW, salt, 3e8, 1, false);
        vm.revertToState(snap);

        vm.prank(creator);
        (address token,) = factory.launch{ value: FEE }(_params(STOCK_LOW, salt));
        _fund(creator, STOCK_LOW, 3e8, address(router));
        PoolKey memory key = factory.poolKeyOf(token);
        vm.prank(creator);
        uint256 separate = router.swapExactIn(key, true, 3e8, 0, creator, block.timestamp);
        assertEq(atomic, separate, "no discount and no surcharge for the launch buy");
    }

    function test_OthersTradeNormallyAfterwards() public {
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        (address token, PoolId id,) = _launchAndBuy(STOCK_LOW, bytes32(uint256(9)), 1e8, 1, false);
        PoolKey memory key = factory.poolKeyOf(token);
        _fund(trader, STOCK_LOW, 2e8, address(router));
        vm.prank(trader);
        uint256 got = router.swapExactIn(key, true, 2e8, 1, trader, block.timestamp);
        uint256 feesBeforeSell = hook.totalFees(id);
        vm.startPrank(creator);
        MockB20Token(token).approve(address(router), type(uint256).max);
        uint256 back = router.swapExactIn(
            key, false, uint128(MockB20Token(token).balanceOf(creator)), 1, creator, block.timestamp
        );
        vm.stopPrank();
        assertGt(got, 0);
        assertGt(back, 0);
        assertEq(feesBeforeSell, 1e6 + 2e6, "1% of the dev buy plus 1% of the trade");
        assertGt(hook.totalFees(id), feesBeforeSell, "the sell paid its fee too");
    }

    function test_SmartWalletCreatorReceivesTokens() public {
        WalletCreator wallet = new WalletCreator();
        vm.deal(address(wallet), 1 ether);
        MockStock(STOCK_LOW).mint(address(wallet), 1e8);
        (address token, uint256 out) = wallet.run(factory, STOCK_LOW, 1e8, 1, FEE);
        assertEq(MockB20Token(token).balanceOf(address(wallet)), out);
        assertEq(factory.launchOf(token).creator, address(wallet));
    }

    function test_EditableAndBuyTogether() public {
        _fund(creator, STOCK_HIGH, 1e8, address(factory));
        (address token,, uint256 out) = _launchAndBuy(STOCK_HIGH, bytes32(uint256(10)), 1e8, 1, true);
        assertTrue(_editable(token));
        assertEq(MockB20Token(token).balanceOf(creator), out);
    }

    /// After a 100 NVDAc dev buy the creator's own claim is 0.7 NVDAc: the 1% fee, 70% of it back.
    function test_CreatorClaimsOwnShare() public {
        _fund(creator, STOCK_LOW, 100e8, address(factory));
        _launchAndBuy(STOCK_LOW, bytes32(uint256(24)), 100e8, 1, false);
        vm.prank(creator);
        assertEq(hook.claim(STOCK_LOW), 0.7e8);
        assertEq(MockStock(STOCK_LOW).balanceOf(creator), 0.7e8);
        vm.prank(treasury);
        assertEq(hook.claim(STOCK_LOW), 0.3e8);
        assertEq(manager.balanceOf(address(hook), uint160(STOCK_LOW)), 0, "all claims redeemed");
    }

    /// predictToken is what the web shows before signing, so it must be exact for every entry point,
    /// both orderings, and any name: the precompile's address ignores name and symbol.
    function test_PredictTokenIsExact() public {
        for (uint256 i; i < 6; i++) {
            address stock = i % 2 == 0 ? STOCK_LOW : STOCK_HIGH;
            bytes32 salt = keccak256(abi.encode("predict", i));
            address predicted = factory.predictToken(creator, salt);
            StockPairFactory.LaunchParams memory p = _params(stock, salt);
            p.name = string.concat("Name ", vm.toString(i));
            p.symbol = string.concat("S", vm.toString(i));
            address token;
            vm.startPrank(creator);
            if (i / 2 == 0) {
                (token,) = factory.launch{ value: FEE }(p);
            } else if (i / 2 == 1) {
                (token,) = factory.launchWithOptions{ value: FEE }(p, _options(true));
            } else {
                MockStock(stock).mint(creator, 1e8);
                MockStock(stock).approve(address(factory), 1e8);
                (token,,) = factory.launchAndBuy{ value: FEE }(
                    p, _options(false), StockPairFactory.CreatorBuy(1e8, 1)
                );
            }
            vm.stopPrank();
            assertEq(token, predicted, "predictToken is exact");
            assertEq(token < stock, stock == STOCK_HIGH, "ordering the quote assumed");
        }
    }

    // ---- everything or nothing -----------------------------------------------------------------

    function _assertNothingHappened(address stock, uint256 balance, address predicted)
        internal
        view
    {
        assertEq(factory.tokenCount(), 0, "no token");
        assertEq(predicted.code.length, 0, "nothing at the predicted address");
        assertEq(MockStock(stock).balanceOf(creator), balance, "no stock moved");
        assertEq(treasury.balance, 0, "no fee paid");
    }

    function test_MinOutRevertsTheWholeLaunch() public {
        bytes32 salt = bytes32(uint256(11));
        (address predicted, uint256 expected) = _quoteLaunchBuy(STOCK_LOW, salt, 1e8);
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.TooLittleReceived.selector);
        factory.launchAndBuy{ value: FEE }(
            _params(STOCK_LOW, salt), _options(false), StockPairFactory.CreatorBuy(1e8, uint128(expected + 1))
        );
        _assertNothingHappened(STOCK_LOW, 1e8, predicted);
    }

    function test_WithoutAllowanceRevertsAndSaltStaysFree() public {
        bytes32 salt = bytes32(uint256(19));
        address predicted = factory.predictToken(creator, salt);
        MockStock(STOCK_LOW).mint(creator, 1e8);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(factory), 0, 1e8)
        );
        factory.launchAndBuy{ value: FEE }(
            _params(STOCK_LOW, salt), _options(false), StockPairFactory.CreatorBuy(1e8, 1)
        );
        _assertNothingHappened(STOCK_LOW, 1e8, predicted);
        vm.prank(creator);
        (address token,) = factory.launch{ value: FEE }(_params(STOCK_LOW, salt));
        assertEq(token, predicted, "the salt was not used up by the failed launch");
    }

    function test_FeedDropBetweenQuoteAndInclusionIsCaught() public {
        bytes32 salt = bytes32(uint256(12));
        (, uint256 expected) = _quoteLaunchBuy(STOCK_LOW, salt, 1e8);
        feed.set(NVDA_USD8 * 97 / 100, block.timestamp); // stock -3%: fewer tokens per stock
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.TooLittleReceived.selector);
        factory.launchAndBuy{ value: FEE }(
            _params(STOCK_LOW, salt),
            _options(false),
            StockPairFactory.CreatorBuy(1e8, uint128(expected * 98 / 100)) // 2% tolerance
        );
    }

    /// The web's default 2% tolerance absorbs any feed drop up to 1% between quote and inclusion,
    /// wherever the price sits inside its 100-tick bucket (a 1% move crosses at most two).
    function testFuzz_FeedDropUpToOnePercentPassesAtTwoPercent(
        uint256 usd8,
        uint256 dropBps,
        uint256 stockIn,
        bool high
    ) public {
        usd8 = bound(usd8, 1e8, 20_000e8);
        dropBps = bound(dropBps, 0, 100);
        stockIn = bound(stockIn, 1, 1e8 * 1e6);
        address stock = high ? STOCK_HIGH : STOCK_LOW;
        bytes32 salt = keccak256(abi.encode("drop", usd8, dropBps, stockIn, high));
        feed.set(int256(usd8), block.timestamp);
        (, uint256 quoted) = _quoteLaunchBuy(stock, salt, stockIn);
        uint256 minOut = quoted * 98 / 100;
        vm.assume(minOut > 0);
        feed.set(int256(usd8 * (10_000 - dropBps) / 10_000), block.timestamp);
        _fund(creator, stock, stockIn, address(factory));
        (,, uint256 out) = _launchAndBuy(stock, salt, uint128(stockIn), uint128(minOut), false);
        assertGe(out, minOut);
        assertLe(out, quoted, "a cheaper stock never buys more tokens");
    }

    function test_StaleFeedRevertsBeforeAnyTransfer() public {
        bytes32 salt = bytes32(uint256(25));
        address predicted = factory.predictToken(creator, salt);
        feed.set(NVDA_USD8, block.timestamp - 8 days);
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        // Positive control: calls made before the revert are counted even though they roll back.
        vm.expectCall(B20_FACTORY, abi.encodeWithSelector(IB20Factory.createB20.selector), 1);
        vm.expectCall(STOCK_LOW, abi.encodeWithSelector(IERC20.transferFrom.selector), 0);
        vm.expectCall(treasury, FEE, "", 0);
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.StaleFeed.selector);
        factory.launchAndBuy{ value: FEE }(
            _params(STOCK_LOW, salt), _options(false), StockPairFactory.CreatorBuy(1e8, 1)
        );
        _assertNothingHappened(STOCK_LOW, 1e8, predicted);
    }

    function test_Expired() public {
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        StockPairFactory.LaunchOptions memory o = _options(false);
        o.deadline = block.timestamp - 1;
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.Expired.selector);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), o, StockPairFactory.CreatorBuy(1e8, 1));
    }

    function test_OwnerChangingOpeningFdvInvalidatesPendingLaunch() public {
        StockPairFactory.LaunchOptions memory o = _options(false);
        vm.prank(owner);
        factory.setOpeningFdv(1_000_000e8);
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.OpeningFdvChanged.selector);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), o, StockPairFactory.CreatorBuy(1e8, 1));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.OpeningFdvChanged.selector);
        factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, 0), o);
    }

    function test_OwnerChangingCreationFeeInvalidatesPendingLaunch() public {
        vm.prank(owner);
        factory.setCreationFee(0.001 ether);
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.WrongCreationFee.selector);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(1e8, 1));
    }

    function test_ValueMustEqualCreationFeeExactly() public {
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.startPrank(creator);
        vm.expectRevert(StockPairFactory.WrongCreationFee.selector);
        factory.launchAndBuy{ value: FEE + 1 }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(1e8, 1));
        vm.expectRevert(StockPairFactory.WrongCreationFee.selector);
        factory.launchAndBuy{ value: 0 }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(1e8, 1));
        vm.stopPrank();
    }

    function test_ZeroAmountsRejected() public {
        vm.startPrank(creator);
        vm.expectRevert(StockPairFactory.ZeroAmount.selector);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(0, 1));
        vm.expectRevert(StockPairFactory.ZeroAmount.selector);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(1e8, 0));
        vm.expectRevert(StockPairFactory.OutOfBounds.selector);
        factory.launchAndBuy{ value: FEE }(
            _params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(uint128(type(int128).max) + 1, 1)
        );
        vm.stopPrank();
    }

    function test_NoApprovalReverts() public {
        MockStock(STOCK_LOW).mint(creator, 1e8);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(factory), 0, 1e8)
        );
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(1e8, 1));
        _assertNothingHappened(STOCK_LOW, 1e8, factory.predictToken(creator, 0));
    }

    function test_InsufficientBalanceReverts() public {
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        MockStock(STOCK_LOW).approve(address(factory), 2e8);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, creator, 1e8, 2e8)
        );
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(2e8, 1));
        _assertNothingHappened(STOCK_LOW, 1e8, factory.predictToken(creator, 0));
    }

    function test_LargeAllowancePullsOnlyStockIn() public {
        MockStock(STOCK_LOW).mint(creator, 10e8);
        vm.prank(creator);
        MockStock(STOCK_LOW).approve(address(factory), type(uint256).max);
        _launchAndBuy(STOCK_LOW, bytes32(uint256(13)), 1e8, 1, false);
        assertEq(MockStock(STOCK_LOW).balanceOf(creator), 9e8);
    }

    function test_FeeOnTransferStockReverts() public {
        FeeOnTransferStock taxed = new FeeOnTransferStock();
        vm.prank(owner);
        factory.addStock(address(taxed), address(feed), "TAXc", 8);
        taxed.mint(creator, 1e8);
        vm.prank(creator);
        taxed.approve(address(factory), 1e8);
        vm.prank(creator);
        vm.expectRevert(IPoolManager.CurrencyNotSettled.selector);
        factory.launchAndBuy{ value: FEE }(
            _params(address(taxed), 0), _options(false), StockPairFactory.CreatorBuy(1e8, 1)
        );
        assertEq(factory.tokenCount(), 0);
    }

    // ---- adversarial treasury and callers -------------------------------------------------------

    /// A creator who approved the factory and walked away is safe: the payer is always msg.sender.
    function test_DanglingApprovalCannotBeSpentByAnyoneElse() public {
        _fund(creator, STOCK_LOW, 5e8, address(factory));
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 1 ether);
        StockPairFactory.LaunchOptions memory o = _options(false);
        vm.prank(attacker);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(factory), 0, 5e8)
        );
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), o, StockPairFactory.CreatorBuy(5e8, 1));
        assertEq(MockStock(STOCK_LOW).balanceOf(creator), 5e8);
        assertEq(MockStock(STOCK_LOW).allowance(creator, address(factory)), 5e8);
    }

    function test_TreasuryCannotTradeInsideTheLaunch() public {
        SnipingTreasury sniper = new SnipingTreasury(router, STOCK_LOW);
        vm.prank(owner);
        factory.setTreasury(address(sniper));
        bytes32 salt = bytes32(uint256(14));
        (address predicted, uint256 expected) = _quoteLaunchBuy(STOCK_LOW, salt, 1e8);
        sniper.arm(_keyFor(predicted, STOCK_LOW));
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        (,, uint256 out) = _launchAndBuy(STOCK_LOW, salt, 1e8, uint128(expected), false);
        assertTrue(sniper.tried(), "treasury did run code");
        assertTrue(sniper.failed(), "its swap was refused: the pool was not registered yet");
        assertEq(sniper.bought(), 0);
        assertEq(address(sniper).balance, FEE, "fee still paid");
        assertEq(out, expected, "creator got exactly the quote");
    }

    function test_TreasuryCannotTradeInsidePlainLaunch() public {
        SnipingTreasury sniper = new SnipingTreasury(router, STOCK_LOW);
        vm.prank(owner);
        factory.setTreasury(address(sniper));
        bytes32 salt = bytes32(uint256(15));
        (address predicted,) = _quoteLaunchBuy(STOCK_LOW, salt, 1e8);
        sniper.arm(_keyFor(predicted, STOCK_LOW));
        vm.prank(creator);
        factory.launch{ value: FEE }(_params(STOCK_LOW, salt));
        assertTrue(sniper.tried());
        assertTrue(sniper.failed());
        assertEq(hook.totalFees(_keyFor(predicted, STOCK_LOW).toId()), 0, "no trade in the launch tx");
    }

    function test_TreasuryCannotReenterTheFactory() public {
        ReenteringTreasury bad = new ReenteringTreasury(factory);
        vm.prank(owner);
        factory.setTreasury(address(bad));
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.TreasuryTransferFailed.selector);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, 0), _options(false), StockPairFactory.CreatorBuy(1e8, 1));
    }

    function test_UnlockCallbackOnlyFromPoolManager() public {
        PoolKey memory key = _keyFor(address(0xBEEF), STOCK_LOW);
        bytes memory buy = abi.encode(
            StockPairFactory.Action.Buy,
            abi.encode(
                StockPairFactory.BuyData({
                    key: key,
                    token: address(0xBEEF),
                    stock: STOCK_LOW,
                    buyer: creator,
                    stockIn: 1e8,
                    minTokensOut: 0
                })
            )
        );
        bytes memory seed = abi.encode(
            StockPairFactory.Action.Seed,
            abi.encode(
                StockPairFactory.SeedData({
                    key: key,
                    token: address(0xBEEF),
                    tickLower: -100,
                    tickUpper: 100,
                    liquidity: 1
                })
            )
        );
        vm.expectRevert(StockPairFactory.OnlyPoolManager.selector);
        factory.unlockCallback(buy);
        vm.expectRevert(StockPairFactory.OnlyPoolManager.selector);
        factory.unlockCallback(seed);
    }

    // ---- launchWithOptions and launch ------------------------------------------------------------

    function test_LaunchWithOptionsMatchesLaunch() public {
        bytes32 salt = bytes32(uint256(15));
        uint256 snap = vm.snapshotState();
        vm.prank(creator);
        (address a, PoolId ida) = factory.launch{ value: FEE }(_params(STOCK_LOW, salt));
        StockPairFactory.Launch memory la = factory.launchOf(a);
        vm.revertToState(snap);
        vm.recordLogs();
        vm.prank(creator);
        (address b, PoolId idb) = factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, salt), _options(false));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        StockPairFactory.Launch memory lb = factory.launchOf(b);
        assertEq(a, b);
        assertEq(PoolId.unwrap(ida), PoolId.unwrap(idb));
        assertEq(la.tickLower, lb.tickLower);
        assertEq(la.tickUpper, lb.tickUpper);
        assertEq(la.liquidity, lb.liquidity);
        assertEq(la.openingSqrtPriceX96, lb.openingSqrtPriceX96);
        assertEq(uint8(factory.metadataStatus(b)), uint8(StockPairFactory.MetadataStatus.Immutable));
        assertFalse(_has(logs, SWAP_TOPIC), "no swap");
        assertFalse(_has(logs, StockPairFactory.CreatorBought.selector), "no creator buy");
        assertFalse(_has(logs, StockPairFactory.MetadataEditable.selector), "not editable");
    }

    function test_LaunchWithOptionsExpired() public {
        StockPairFactory.LaunchOptions memory o = _options(false);
        o.deadline = block.timestamp - 1;
        vm.prank(creator);
        vm.expectRevert(StockPairFactory.Expired.selector);
        factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, 0), o);
    }

    function test_DeadlineIsInclusive() public {
        StockPairFactory.LaunchOptions memory o = _options(false);
        o.deadline = block.timestamp;
        vm.prank(creator);
        factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, 0), o);
        _fund(creator, STOCK_LOW, 1e8, address(factory));
        vm.prank(creator);
        factory.launchAndBuy{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(1))), o, StockPairFactory.CreatorBuy(1e8, 1));
        assertEq(factory.tokenCount(), 2);
    }

    // ---- ABI and gas ---------------------------------------------------------------------------

    /// The selectors and topics the web, the indexer and integrators hard-code. `launch` and
    /// `Launched` are the ones the earlier factory already used, so one decoder reads both.
    function test_AbiIsPinned() public pure {
        assertEq(StockPairFactory.launch.selector, bytes4(0x28314fb2));
        assertEq(StockPairFactory.launchWithOptions.selector, bytes4(0x01499600));
        assertEq(StockPairFactory.launchAndBuy.selector, bytes4(0xd0150e4f));
        assertEq(StockPairFactory.metadataStatus.selector, bytes4(0x9ce0634d));
        assertEq(StockPairFactory.updateContractURI.selector, bytes4(0x6697392e));
        assertEq(StockPairFactory.lockMetadata.selector, bytes4(0x37d1df5f));
        assertEq(
            StockPairFactory.Launched.selector,
            0x545827070fae462314f8e79f25d99f8e713bf3cecb38728eb4c4804e1e20d0a6
        );
        assertEq(
            StockPairFactory.CreatorBought.selector,
            0x43d15e9d32712a10d4ab74467519cf3a13edcf6de23f4894edbb0abf319b9f65
        );
        assertEq(
            StockPairFactory.MetadataEditable.selector,
            0x1241a65d78d66378b38c08d6c0fc8deaa8e6f592ffc4bfc685d51af653f1bb6f
        );
        assertEq(
            StockPairFactory.ContractURIChanged.selector,
            0xb23802208f960154d35feb1ddb4ed3718dd9ea1c6af17d702f83bb34f3c6ab4b
        );
        assertEq(
            StockPairFactory.MetadataLocked.selector,
            0x1653aa4ca9f980f3b8b3aaa209e5f5d445c8688450cd1bc630a19b5211679aa8
        );
        assertEq(StockPairFactory.TooLittleReceived.selector, StockPairRouter.TooLittleReceived.selector);
        assertEq(StockPairFactory.Expired.selector, StockPairRouter.Expired.selector);
        assertEq(StockPairHook.PartialFill.selector, bytes4(0xd964f528));
    }

    /// Gas entries for the three entry points (snapshots/StockPairFactory.json). Isolated, so each
    /// call is measured as its own transaction with cold storage, as on chain. The mock B20 token
    /// is an EVM contract deployed per launch, so absolute numbers run higher than on Base.
    /// forge-config: default.isolate = true
    function test_GasSnapshots() public {
        vm.prank(creator);
        factory.launch{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(1))));
        vm.snapshotGasLastCall("StockPairFactory", "launch");

        StockPairFactory.LaunchOptions memory o = _options(true);
        vm.prank(creator);
        factory.launchWithOptions{ value: FEE }(_params(STOCK_LOW, bytes32(uint256(2))), o);
        vm.snapshotGasLastCall("StockPairFactory", "launchWithOptions (editable)");

        _fund(creator, STOCK_LOW, 1e8, address(factory));
        o = _options(false);
        vm.prank(creator);
        factory.launchAndBuy{ value: FEE }(
            _params(STOCK_LOW, bytes32(uint256(3))), o, StockPairFactory.CreatorBuy(1e8, 1)
        );
        vm.snapshotGasLastCall("StockPairFactory", "launchAndBuy");
    }

    /// Stock needed to move the price from the range edge across `words` tick-bitmap words.
    function _stockToCross(address stock, bytes32 salt, uint256 words)
        internal
        view
        returns (uint256 stockIn)
    {
        (bool c0, int24 lo, int24 hi, uint128 L) =
            _predictOpening(stock, factory.predictToken(creator, salt));
        uint256 poolIn;
        if (c0) {
            int24 target = lo + int24(int256(words)) * 25_600 + 1_000;
            poolIn = SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(target), L, true
            );
        } else {
            int24 target = hi - int24(int256(words)) * 25_600 - 1_000;
            poolIn = SqrtPriceMath.getAmount0Delta(
                TickMath.getSqrtPriceAtTick(target), TickMath.getSqrtPriceAtTick(hi), L, true
            );
        }
        stockIn = poolIn * 100 / 99 + 1; // gross of the 1% fee
    }

    function _wordOf(int24 tick) internal pure returns (int24) {
        return _floorDiv(tick, 100) >> 8;
    }

    /// Gas of a plain launch of this token, measured and then undone.
    function _plainLaunchGas(address stock, bytes32 salt) internal returns (uint256 gasUsed) {
        uint256 snap = vm.snapshotState();
        vm.prank(creator);
        factory.launch{ value: FEE }(_params(stock, salt));
        gasUsed = vm.lastCallGas().gasTotalUsed;
        vm.revertToState(snap);
    }

    /// Launch and buy across 7 bitmap words; returns the gas and how many words the buy walked.
    function _sevenWordBuy(address stock, bytes32 salt)
        internal
        returns (uint256 gasUsed, int24 crossed, uint256 out)
    {
        uint256 stockIn = _stockToCross(stock, salt, 7);
        (, uint256 expected) = _quoteLaunchBuy(stock, salt, stockIn);
        _fund(creator, stock, stockIn, address(factory));
        address token;
        PoolId id;
        (token, id, out) = _launchAndBuy(stock, salt, uint128(stockIn), uint128(expected), false);
        gasUsed = vm.lastCallGas().gasTotalUsed;
        StockPairFactory.Launch memory l = factory.launchOf(token);
        (, int24 tickAfter,,) = IPoolManager(address(manager)).getSlot0(id);
        crossed = stock == STOCK_LOW
            ? _wordOf(l.tickUpper - 1) - _wordOf(tickAfter)
            : _wordOf(tickAfter) - _wordOf(l.tickLower);
    }

    /// The largest realistic dev buy walks 7 bitmap words. What the buy adds on top of a plain
    /// launch of the same token stays under a recorded ceiling, and so does the whole call.
    /// forge-config: default.isolate = true
    function test_LaunchAndBuyGas() public {
        for (uint256 i; i < 2; i++) {
            address stock = i == 0 ? STOCK_LOW : STOCK_HIGH;
            bytes32 salt = bytes32(uint256(27 + i));
            uint256 launchGas = _plainLaunchGas(stock, salt);
            (uint256 gasUsed, int24 crossed, uint256 out) = _sevenWordBuy(stock, salt);
            assertGe(crossed, 7, "the buy walked at least 7 bitmap words");
            assertGt(out, SUPPLY * 9_998 / 10_000, "about 99.99% of the supply");
            assertLt(gasUsed - launchGas, 350_000, "gas the buy adds to the launch");
            assertLt(gasUsed, 2_300_000, "launchAndBuy gas ceiling");
        }
    }
}
