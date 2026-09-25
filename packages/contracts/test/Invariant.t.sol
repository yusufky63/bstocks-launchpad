// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { Test } from "forge-std/Test.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { StockPairHook } from "../src/StockPairHook.sol";
import { StockPairRouter } from "../src/StockPairRouter.sol";
import { B20Encoding } from "../src/B20Encoding.sol";
import { MockB20Token } from "./mocks/MockB20.sol";
import { MockFeed, MockStock } from "./mocks/MockStock.sol";
import { Fixture } from "./Fixture.sol";

/// Drives the factory, router and hook the way the public can, plus the owner's two price knobs.
/// Every entry point bounds its inputs so most calls land; the ones that revert are discarded.
contract LaunchHandler is Test {
    StockPairFactory immutable factory;
    StockPairHook immutable hook;
    StockPairRouter immutable router;
    MockFeed immutable feed;
    address immutable owner;

    address[] public stocks;
    address[] public actors;
    address[] public tokens;
    /// Ghost: what each launch asked for, kept independently of the factory's own flag.
    mapping(address => bool) public editableAtLaunch;
    uint256 nonce;
    int256 price = 229_95730000;

    constructor(
        StockPairFactory factory_,
        StockPairRouter router_,
        MockFeed feed_,
        address owner_,
        address[] memory stocks_
    ) {
        factory = factory_;
        hook = factory_.hook();
        router = router_;
        feed = feed_;
        owner = owner_;
        stocks = stocks_;
        for (uint256 i; i < 4; i++) {
            actors.push(makeAddr(string.concat("actor", vm.toString(i))));
        }
    }

    // ---- views for the invariants ---------------------------------------------------------------

    function tokenCount() external view returns (uint256) {
        return tokens.length;
    }

    function stockCount() external view returns (uint256) {
        return stocks.length;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    // ---- launches -------------------------------------------------------------------------------

    function _pick(address[] storage list, uint256 seed) internal view returns (address) {
        return list[seed % list.length];
    }

    function _params(address stock) internal returns (StockPairFactory.LaunchParams memory) {
        nonce++;
        return StockPairFactory.LaunchParams(
            "Handler Token", "HT", "ipfs://bafkreihandler", stock, bytes32(nonce)
        );
    }

    function _options(bool editable) internal view returns (StockPairFactory.LaunchOptions memory) {
        return StockPairFactory.LaunchOptions(editable, factory.openingFdvUsd8(), block.timestamp);
    }

    function _record(address token, bool editable) internal {
        tokens.push(token);
        editableAtLaunch[token] = editable;
    }

    function launch(uint256 actorSeed, uint256 stockSeed) external {
        address actor = _pick(actors, actorSeed);
        StockPairFactory.LaunchParams memory p = _params(_pick(stocks, stockSeed));
        uint256 fee = factory.creationFee();
        vm.deal(actor, fee);
        vm.prank(actor);
        (address token,) = factory.launch{ value: fee }(p);
        _record(token, false);
    }

    function launchWithOptions(uint256 actorSeed, uint256 stockSeed, bool editable) external {
        address actor = _pick(actors, actorSeed);
        StockPairFactory.LaunchParams memory p = _params(_pick(stocks, stockSeed));
        StockPairFactory.LaunchOptions memory o = _options(editable);
        uint256 fee = factory.creationFee();
        vm.deal(actor, fee);
        vm.prank(actor);
        (address token,) = factory.launchWithOptions{ value: fee }(p, o);
        _record(token, editable);
    }

    function launchAndBuy(uint256 actorSeed, uint256 stockSeed, bool editable, uint256 stockIn)
        external
    {
        address actor = _pick(actors, actorSeed);
        address stock = _pick(stocks, stockSeed);
        stockIn = bound(stockIn, 1, 10_000e8);
        StockPairFactory.LaunchParams memory p = _params(stock);
        StockPairFactory.LaunchOptions memory o = _options(editable);
        uint256 fee = factory.creationFee();
        vm.deal(actor, fee);
        MockStock(stock).mint(actor, stockIn);
        vm.prank(actor);
        MockStock(stock).approve(address(factory), stockIn);
        vm.prank(actor);
        (address token,,) = factory.launchAndBuy{ value: fee }(
            p, o, StockPairFactory.CreatorBuy(uint128(stockIn), 1)
        );
        _record(token, editable);
    }

    // ---- trading and claims ---------------------------------------------------------------------

    function buy(uint256 actorSeed, uint256 tokenSeed, uint256 stockIn) external {
        if (tokens.length == 0) return;
        address actor = _pick(actors, actorSeed);
        address token = _pick(tokens, tokenSeed);
        PoolKey memory key = factory.poolKeyOf(token);
        address stock = factory.launchOf(token).stock;
        stockIn = bound(stockIn, 1, 10_000e8);
        MockStock(stock).mint(actor, stockIn);
        vm.prank(actor);
        MockStock(stock).approve(address(router), stockIn);
        vm.prank(actor);
        router.swapExactIn(
            key, Currency.unwrap(key.currency0) == stock, uint128(stockIn), 0, actor, block.timestamp
        );
    }

    function sell(uint256 actorSeed, uint256 tokenSeed, uint256 fraction) external {
        if (tokens.length == 0) return;
        address actor = _pick(actors, actorSeed);
        address token = _pick(tokens, tokenSeed);
        uint256 amount = MockB20Token(token).balanceOf(actor) * bound(fraction, 1, 100) / 100;
        if (amount == 0) return;
        PoolKey memory key = factory.poolKeyOf(token);
        vm.prank(actor);
        MockB20Token(token).approve(address(router), amount);
        vm.prank(actor);
        router.swapExactIn(
            key, Currency.unwrap(key.currency0) == token, uint128(amount), 0, actor, block.timestamp
        );
    }

    function claim(uint256 actorSeed, uint256 stockSeed, bool asTreasury) external {
        address who = asTreasury ? factory.treasury() : _pick(actors, actorSeed);
        address stock = _pick(stocks, stockSeed);
        if (hook.claimable(stock, who) == 0) return;
        vm.prank(who);
        hook.claim(stock);
    }

    // ---- creator metadata -----------------------------------------------------------------------

    function updateContractURI(uint256 tokenSeed, uint256 actorSeed, bool asCreator) external {
        if (tokens.length == 0) return;
        address token = _pick(tokens, tokenSeed);
        address who = asCreator ? factory.launchOf(token).creator : _pick(actors, actorSeed);
        nonce++;
        vm.prank(who);
        factory.updateContractURI(token, string.concat("ipfs://bafkrei", vm.toString(nonce)));
    }

    function lockMetadata(uint256 tokenSeed, uint256 actorSeed, bool asCreator) external {
        if (tokens.length == 0) return;
        address token = _pick(tokens, tokenSeed);
        address who = asCreator ? factory.launchOf(token).creator : _pick(actors, actorSeed);
        vm.prank(who);
        factory.lockMetadata(token);
    }

    // ---- the onchain price and the owner's knob -------------------------------------------------

    /// Moves the one feed both stocks read by up to 5% either way, always fresh.
    function moveFeed(int256 bps) external {
        bps = bound(bps, -500, 500);
        price = price * (10_000 + bps) / 10_000;
        if (price < 1e8) price = 1e8;
        feed.set(price, block.timestamp);
    }

    function setOpeningFdv(uint256 fdvUsd8) external {
        fdvUsd8 = bound(fdvUsd8, factory.MIN_OPENING_FDV_USD8(), factory.MAX_OPENING_FDV_USD8());
        vm.prank(owner);
        factory.setOpeningFdv(fdvUsd8);
    }
}

contract InvariantTest is Fixture {
    LaunchHandler handler;

    function setUp() public override {
        super.setUp();
        address[] memory list = new address[](2);
        list[0] = STOCK_LOW;
        list[1] = STOCK_HIGH;
        handler = new LaunchHandler(factory, router, feed, owner, list);
        bytes4[] memory selectors = new bytes4[](10);
        selectors[0] = LaunchHandler.launch.selector;
        selectors[1] = LaunchHandler.launchWithOptions.selector;
        selectors[2] = LaunchHandler.launchAndBuy.selector;
        selectors[3] = LaunchHandler.buy.selector;
        selectors[4] = LaunchHandler.sell.selector;
        selectors[5] = LaunchHandler.claim.selector;
        selectors[6] = LaunchHandler.updateContractURI.selector;
        selectors[7] = LaunchHandler.lockMetadata.selector;
        selectors[8] = LaunchHandler.moveFeed.selector;
        selectors[9] = LaunchHandler.setOpeningFdv.selector;
        targetSelector(FuzzSelector({ addr: address(handler), selectors: selectors }));
        targetContract(address(handler));
    }

    /// The factory and the router pass value through and keep nothing: no stock, no launched
    /// token, no ETH.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_FactoryAndRouterHoldNothing() public view {
        for (uint256 s; s < handler.stockCount(); s++) {
            address stock = handler.stocks(s);
            assertEq(MockStock(stock).balanceOf(address(factory)), 0, "factory stock");
            assertEq(MockStock(stock).balanceOf(address(router)), 0, "router stock");
        }
        for (uint256 t; t < handler.tokenCount(); t++) {
            address token = handler.tokens(t);
            assertEq(MockB20Token(token).balanceOf(address(factory)), 0, "factory token");
            assertEq(MockB20Token(token).balanceOf(address(router)), 0, "router token");
        }
        assertEq(address(factory).balance, 0, "factory ETH");
        assertEq(address(router).balance, 0, "router ETH");
    }

    /// Every fee is minted to the hook as an ERC-6909 claim and booked to exactly one creator and
    /// the treasury, and claims burn what they pay: the two totals match per stock.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_HookClaimsBackTheLedger() public view {
        for (uint256 s; s < handler.stockCount(); s++) {
            address stock = handler.stocks(s);
            uint256 booked = hook.claimable(stock, treasury);
            for (uint256 a; a < handler.actorCount(); a++) {
                booked += hook.claimable(stock, handler.actors(a));
            }
            assertEq(IPoolManager(address(manager)).balanceOf(address(hook), uint160(stock)), booked);
        }
    }

    /// Editable exactly when the creator asked for it at launch and the factory still holds the
    /// role on the token; Locked exactly when it asked and the role is gone.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_MetadataStatusFollowsTheToken() public view {
        for (uint256 t; t < handler.tokenCount(); t++) {
            address token = handler.tokens(t);
            bool asked = handler.editableAtLaunch(token);
            bool held = MockB20Token(token).hasRole(B20Encoding.METADATA_ROLE, address(factory));
            StockPairFactory.MetadataStatus status = factory.metadataStatus(token);
            assertEq(status == StockPairFactory.MetadataStatus.Editable, asked && held, "editable");
            assertEq(status == StockPairFactory.MetadataStatus.Locked, asked && !held, "locked");
            if (!asked) assertFalse(held, "a frozen launch never holds the role");
        }
    }

    /// No token ever gains an admin or a single unit of supply.
    /// forge-config: default.invariant.runs = 128
    /// forge-config: default.invariant.depth = 40
    function invariant_TokensStayZeroAdminFixedSupply() public view {
        assertEq(factory.tokenCount(), handler.tokenCount(), "every launch recorded");
        for (uint256 t; t < handler.tokenCount(); t++) {
            MockB20Token token = MockB20Token(handler.tokens(t));
            assertEq(token.adminCount(), 0, "zero admin");
            assertEq(token.totalSupply(), SUPPLY, "fixed supply");
        }
    }
}
