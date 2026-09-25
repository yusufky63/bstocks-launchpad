// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

import { StockPairFactory } from "../src/StockPairFactory.sol";
import { MockStock } from "./mocks/MockStock.sol";
import { Fixture } from "./Fixture.sol";

/// 18-decimal stock, for rows an 8-decimal Coinbase stock cannot produce.
contract MockStock18 is ERC20 {
    constructor() ERC20("Eighteen", "E18c") { }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// Fresh-pool quote vectors for the TypeScript port (packages/core launch-buy.ts), taken from real
/// launchAndBuy runs. Regenerate with
///     VECTORS=1 forge test --match-contract LaunchBuyVectors
/// which rewrites test/vectors/launch-buy.jsonl (the 300 seed rows first, each reproduced to the
/// wei, then new rows) and test/vectors/sqrt-price.jsonl. Without VECTORS=1 the writer is skipped
/// and the committed files are checked against the Solidity replay instead.
contract LaunchBuyVectorsTest is Fixture {
    using StateLibrary for IPoolManager;

    string constant SEED = "test/vectors/launch-buy-seed.jsonl";
    string constant LAUNCH_BUY = "test/vectors/launch-buy.jsonl";
    string constant SQRT_PRICE = "test/vectors/sqrt-price.jsonl";
    address constant STOCK18_LOW = 0x0000000000000000000000000000000000002000;
    address constant STOCK18_HIGH = 0xFFfFFFFFFfffFFfffFFfFffFFffffFFFFfffE000;
    uint256 constant SEED_ROWS = 300;
    uint256 constant NEW_CASES = 320;
    int24 constant WORD = 25_600; // ticks per tick-bitmap word at spacing 100
    int24 constant MAX_USABLE = 887_200;
    /// Ticks from the range edge at which a buy has taken 99.99% of the supply (about 7.2 words).
    int24 constant FULL_DISTANCE = 184_300;

    struct Row {
        int24 tick;
        bool c0;
        uint256 stockIn;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 tokensOut;
        uint160 sqrtPriceAfterX96;
    }

    struct Case {
        address stock;
        address predicted;
        bytes32 salt;
        uint256 fdv;
        uint256 usd8;
        int24 tick;
        uint256 stockIn;
    }

    /// What the new rows cover, asserted after writing so the file keeps its promises.
    struct Coverage {
        uint256 rows;
        uint256 dec18;
        uint256 c0Negative;
        uint256 c0Positive;
        uint256 c1Negative;
        uint256 c1Positive;
        uint256 oneRawUnit;
        uint256 exactWordStops;
        int24 maxWordsCrossed;
        uint256 maxTokensOut;
    }

    function setUp() public override {
        super.setUp();
        bytes memory code = address(new MockStock18()).code;
        vm.etch(STOCK18_LOW, code);
        vm.etch(STOCK18_HIGH, code);
        vm.startPrank(owner);
        factory.addStock(STOCK18_LOW, address(feed), "E18Lc", 18);
        factory.addStock(STOCK18_HIGH, address(feed), "E18Hc", 18);
        vm.stopPrank();
    }

    function _writing() internal view returns (bool) {
        return keccak256(bytes(vm.envOr("VECTORS", string("")))) == keccak256("1");
    }

    function _stock(bool c0, bool dec18) internal pure returns (address) {
        if (dec18) return c0 ? STOCK18_HIGH : STOCK18_LOW;
        return c0 ? STOCK_HIGH : STOCK_LOW;
    }

    // ---- the opening, driven through the feed -----------------------------------------------------

    function _tickAt(address stock, address token, uint256 usd8) internal returns (int24 tick) {
        feed.set(int256(usd8), block.timestamp);
        (, tick,) = factory.previewOpening(stock, token);
    }

    /// Feed answer whose opening tick is exactly `target` at the current FDV, or 0 if none is.
    function _usd8ForTick(address stock, address token, int24 target) internal returns (uint256) {
        bool c0 = token < stock;
        uint256 lo = 1;
        uint256 hi = 1 << 80;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            int24 t = _tickAt(stock, token, mid);
            if (c0 ? t <= target : t >= target) hi = mid;
            else lo = mid + 1;
        }
        return _tickAt(stock, token, lo) == target ? lo : 0;
    }

    function _setFdv(uint256 fdv) internal {
        vm.prank(owner);
        factory.setOpeningFdv(fdv);
    }

    /// One real launchAndBuy from a snapshot that is rolled back afterwards; ok is false when the
    /// launch reverts (a range that cannot exist, or a buy too small to deliver one raw unit).
    function _launchBuy(Case memory c) internal returns (bool ok, Row memory row) {
        uint256 snap = vm.snapshotState();
        feed.set(int256(c.usd8), block.timestamp);
        MockStock(c.stock).mint(creator, c.stockIn);
        vm.prank(creator);
        MockStock(c.stock).approve(address(factory), c.stockIn);
        StockPairFactory.LaunchParams memory p = _params(c.stock, c.salt);
        StockPairFactory.LaunchOptions memory o =
            StockPairFactory.LaunchOptions(false, c.fdv, block.timestamp);
        StockPairFactory.CreatorBuy memory b = StockPairFactory.CreatorBuy(uint128(c.stockIn), 1);
        vm.prank(creator);
        try factory.launchAndBuy{ value: FEE }(p, o, b) returns (address token, PoolId id, uint256 out) {
            StockPairFactory.Launch memory l = factory.launchOf(token);
            (uint160 sqrtAfter,,,) = IPoolManager(address(manager)).getSlot0(id);
            row = Row({
                tick: c.tick,
                c0: token < c.stock,
                stockIn: c.stockIn,
                tickLower: l.tickLower,
                tickUpper: l.tickUpper,
                liquidity: l.liquidity,
                tokensOut: out,
                sqrtPriceAfterX96: sqrtAfter
            });
            ok = true;
        } catch { }
        vm.revertToState(snap);
    }

    // ---- sizing a buy ---------------------------------------------------------------------------

    /// Stock (gross of the 1% fee) that moves the price `distance` ticks into the range.
    function _stockForDistance(bool c0, int24 lo, int24 hi, uint128 L, int24 distance)
        internal
        pure
        returns (uint256)
    {
        uint256 poolIn;
        if (c0) {
            int24 target = lo + distance < hi ? lo + distance : hi - 100;
            poolIn = SqrtPriceMath.getAmount1Delta(
                TickMath.getSqrtPriceAtTick(lo), TickMath.getSqrtPriceAtTick(target), L, true
            );
        } else {
            int24 target = hi - distance > lo ? hi - distance : lo + 100;
            poolIn = SqrtPriceMath.getAmount0Delta(
                TickMath.getSqrtPriceAtTick(target), TickMath.getSqrtPriceAtTick(hi), L, true
            );
        }
        return poolIn * 100 / 99 + 1;
    }

    /// Pool input (after the fee) that ends the buy exactly on its `stops`-th bitmap-word stop,
    /// summed step by step with the pool's own rounding. 0 if the range ends first.
    function _inputToStop(bool c0, int24 lo, int24 hi, uint128 L, uint256 stops)
        internal
        pure
        returns (uint256 A)
    {
        int24 t = c0 ? lo : hi - 1;
        uint160 s = TickMath.getSqrtPriceAtTick(c0 ? lo : hi);
        for (uint256 k; k < stops; k++) {
            int24 next;
            if (c0) {
                next = (((_floorDiv(t, 100) + 1) >> 8) * 256 + 255) * 100;
                if (next >= hi) return 0;
            } else {
                next = ((_floorDiv(t, 100) >> 8) * 256) * 100;
                if (next <= lo) return 0;
            }
            uint160 sT = TickMath.getSqrtPriceAtTick(next);
            A += c0 ? _amount1Up(s, sT, L) : _amount0Up(sT, s, L);
            s = sT;
            t = c0 ? next : next - 1;
        }
    }

    /// Gross stock whose net-of-fee amount is exactly `net`, or 0 if no gross amount nets to it.
    function _grossFor(uint256 net) internal pure returns (uint256 gross) {
        gross = net * 100 / 99;
        while (gross - gross / 100 > net) gross--;
        while (gross - gross / 100 < net) gross++;
        if (gross - gross / 100 != net) gross = 0;
    }

    // ---- choosing a case -------------------------------------------------------------------------

    /// A natural opening tick for a log-uniform stock price between about 0.01 and 90,000 USD.
    function _naturalTick(Case memory c, uint256 r) internal returns (int24) {
        uint256 usd8 = (10 ** (6 + (r >> 16) % 7)) * (1 + (r >> 24) % 9);
        return _tickAt(c.stock, c.predicted, usd8);
    }

    /// Opening tick by mode: 0 natural, 1 on a bucket edge, 2 with the range edge on a bitmap
    /// word, 3 the rare sign for the ordering (18 decimals, highest FDV), 4 natural plus noise.
    function _targetTick(Case memory c, uint256 mode, uint256 r) internal returns (int24 target) {
        bool c0 = c.predicted < c.stock;
        if (mode == 3) {
            int24 offset = int24(int256(1 + (r >> 32) % 100_000));
            return c0 ? offset : -offset;
        }
        int24 natural = _naturalTick(c, r);
        if (mode == 0) return natural;
        if (mode == 1) return _floorDiv(natural, 100) * 100;
        if (mode == 2) {
            int24 k = _floorDiv(natural, WORD);
            int24 within = int24(int256((r >> 32) % 100));
            // token0: fl + 100 lands on k*WORD; token1: fl lands on k*WORD.
            return c0 ? k * WORD - 100 + within : k * WORD + within;
        }
        return natural + int24(int256((r >> 32) % 2001)) - 1000;
    }

    /// Buy size by mode: 0 a few raw units, 1 a log-spread distance into the range (up to 99.99%
    /// of the supply), 2 exactly on a bitmap-word stop (or one unit either side), 3 log-uniform.
    function _stockIn(Case memory c, uint256 mode, uint256 r) internal pure returns (uint256) {
        bool c0 = c.predicted < c.stock;
        (int24 lo, int24 hi, uint128 L) = _rangeFor(c0, c.tick);
        if (lo >= hi) return 0;
        if (mode == 0) return 1 + (r >> 40) % 300;
        if (mode == 1) {
            int24 distance = int24(int256((10 ** ((r >> 40) % 6)) * (1 + (r >> 48) % 9)));
            if ((r >> 56) % 5 == 0) distance = FULL_DISTANCE;
            if (distance > FULL_DISTANCE) distance = FULL_DISTANCE;
            return _stockForDistance(c0, lo, hi, L, distance);
        }
        if (mode == 2) {
            uint256 net = _inputToStop(c0, lo, hi, L, 1 + (r >> 40) % 7);
            if (net < 2) return 0;
            return _grossFor(net + (r >> 48) % 3 - 1);
        }
        uint256 cost = _stockForDistance(c0, lo, hi, L, FULL_DISTANCE);
        uint256 digits;
        for (uint256 x = cost; x >= 10; x /= 10) digits++;
        uint256 amount = (10 ** ((r >> 40) % (digits + 1))) * (1 + (r >> 48) % 9);
        return amount < cost ? amount : cost;
    }

    function _newCase(uint256 j) internal returns (bool ok, Row memory row) {
        uint256 r = uint256(keccak256(abi.encode("launch-buy", j)));
        uint256 tickMode = j % 5;
        uint256 sizeMode = (j / 5) % 4;
        bool c0 = r & 1 == 1;
        bool dec18 = tickMode == 3 || (r >> 1) & 1 == 1;
        Case memory c;
        c.stock = _stock(c0, dec18);
        c.salt = keccak256(abi.encode("row", j));
        c.predicted = factory.predictToken(creator, c.salt);
        if ((c.predicted < c.stock) != c0) return (false, row);
        c.fdv = FDV;
        if (tickMode == 3) c.fdv = factory.MAX_OPENING_FDV_USD8();
        else if ((r >> 2) % 4 == 0) c.fdv = _bound(r >> 64, 100e8, 1_000_000e8);
        _setFdv(c.fdv);
        c.tick = _targetTick(c, tickMode, r);
        c.usd8 = _usd8ForTick(c.stock, c.predicted, c.tick);
        if (c.usd8 != 0) {
            c.stockIn = _stockIn(c, sizeMode, r);
            if (c.stockIn != 0) (ok, row) = _launchBuy(c);
        }
        _setFdv(FDV);
    }

    // ---- rows ------------------------------------------------------------------------------------

    function _json(Row memory row) internal pure returns (string memory) {
        return string.concat(
            string.concat(
                '{"tick":', vm.toString(int256(row.tick)),
                ',"tokenIsCurrency0":', vm.toString(row.c0),
                ',"stockIn":"', vm.toString(row.stockIn),
                '","tickLower":', vm.toString(int256(row.tickLower))
            ),
            string.concat(
                ',"tickUpper":', vm.toString(int256(row.tickUpper)),
                ',"liquidity":"', vm.toString(uint256(row.liquidity)),
                '","tokensOut":"', vm.toString(row.tokensOut),
                '","sqrtPriceAfterX96":"', vm.toString(uint256(row.sqrtPriceAfterX96)), '"}'
            )
        );
    }

    function _parse(string memory line) internal pure returns (Row memory row) {
        row.tick = int24(vm.parseJsonInt(line, ".tick"));
        row.c0 = vm.parseJsonBool(line, ".tokenIsCurrency0");
        row.stockIn = vm.parseJsonUint(line, ".stockIn");
        row.tickLower = int24(vm.parseJsonInt(line, ".tickLower"));
        row.tickUpper = int24(vm.parseJsonInt(line, ".tickUpper"));
        row.liquidity = uint128(vm.parseJsonUint(line, ".liquidity"));
        row.tokensOut = vm.parseJsonUint(line, ".tokensOut");
        row.sqrtPriceAfterX96 = uint160(vm.parseJsonUint(line, ".sqrtPriceAfterX96"));
    }

    /// Every field follows from (tick, ordering, stockIn) by the rules the TypeScript port uses.
    function _checkReplay(Row memory row) internal pure {
        (int24 lo, int24 hi, uint128 L) = _rangeFor(row.c0, row.tick);
        assertEq(row.tickLower, lo, "tickLower");
        assertEq(row.tickUpper, hi, "tickUpper");
        assertEq(row.liquidity, L, "liquidity");
        (uint256 out, uint160 sqrtAfter) = refBuyFull(row.c0, lo, hi, L, row.stockIn);
        assertEq(row.tokensOut, out, "tokensOut");
        assertEq(row.sqrtPriceAfterX96, sqrtAfter, "sqrtPriceAfterX96");
    }

    function _wordsCrossed(Row memory row) internal pure returns (int24) {
        int24 after_ = TickMath.getTickAtSqrtPrice(row.sqrtPriceAfterX96);
        return row.c0
            ? (_floorDiv(after_, 100) >> 8) - (_floorDiv(row.tickLower, 100) >> 8)
            : (_floorDiv(row.tickUpper - 1, 100) >> 8) - (_floorDiv(after_, 100) >> 8);
    }

    function _count(Coverage memory cov, Row memory row, bool dec18) internal pure {
        cov.rows++;
        if (dec18) cov.dec18++;
        if (row.c0 && row.tick < 0) cov.c0Negative++;
        if (row.c0 && row.tick >= 0) cov.c0Positive++;
        if (!row.c0 && row.tick < 0) cov.c1Negative++;
        if (!row.c0 && row.tick >= 0) cov.c1Positive++;
        if (row.stockIn == 1) cov.oneRawUnit++;
        int24 words = _wordsCrossed(row);
        if (words > cov.maxWordsCrossed) cov.maxWordsCrossed = words;
        if (row.tokensOut > cov.maxTokensOut) cov.maxTokensOut = row.tokensOut;
        (int24 lo, int24 hi,) = _rangeFor(row.c0, row.tick);
        int24 edgeTick = TickMath.getTickAtSqrtPrice(row.sqrtPriceAfterX96);
        if (edgeTick % WORD == 0 && edgeTick != lo && edgeTick != hi) {
            if (TickMath.getSqrtPriceAtTick(edgeTick) == row.sqrtPriceAfterX96) cov.exactWordStops++;
        }
    }

    // ---- the writer (VECTORS=1) ------------------------------------------------------------------

    function _reset(string memory path) internal {
        if (vm.exists(path)) vm.removeFile(path);
    }

    /// Replays each seed row through a real launch at the same opening tick and checks the output
    /// to the wei before writing it out in full.
    function _writeSeedRows() internal {
        vm.closeFile(SEED);
        for (uint256 i; i < SEED_ROWS; i++) {
            string memory line = vm.readLine(SEED);
            Case memory c;
            c.tick = int24(vm.parseJsonInt(line, ".tick"));
            bool c0 = vm.parseJsonBool(line, ".tokenIsCurrency0");
            c.stockIn = vm.parseJsonUint(line, ".stockIn");
            c.stock = _stock(c0, false);
            c.salt = keccak256(abi.encode("seed", i));
            c.predicted = factory.predictToken(creator, c.salt);
            c.fdv = FDV;
            assertEq(c.predicted < c.stock, c0, "seed ordering");
            c.usd8 = _usd8ForTick(c.stock, c.predicted, c.tick);
            assertGt(c.usd8, 0, "seed tick reachable");
            (bool ok, Row memory row) = _launchBuy(c);
            assertTrue(ok, "seed row launches");
            assertEq(row.tokensOut, vm.parseJsonUint(line, ".tokensOut"), "seed row to the wei");
            _checkReplay(row);
            vm.writeLine(LAUNCH_BUY, _json(row));
        }
        vm.closeFile(SEED);
    }

    function _writeNewRows() internal returns (Coverage memory cov) {
        for (uint256 j; j < NEW_CASES; j++) {
            (bool ok, Row memory row) = _newCase(j);
            if (!ok) continue;
            _checkReplay(row);
            uint256 r = uint256(keccak256(abi.encode("launch-buy", j)));
            _count(cov, row, j % 5 == 3 || (r >> 1) & 1 == 1);
            vm.writeLine(LAUNCH_BUY, _json(row));
        }
        // Explicit one-raw-unit buys, both orderings, both decimals.
        for (uint256 k; k < 4; k++) {
            Case memory c;
            c.stock = _stock(k % 2 == 0, k >= 2);
            c.salt = keccak256(abi.encode("one-raw-unit", k));
            c.predicted = factory.predictToken(creator, c.salt);
            c.fdv = FDV;
            c.usd8 = uint256(NVDA_USD8);
            c.tick = _tickAt(c.stock, c.predicted, c.usd8);
            c.stockIn = 1;
            (bool ok, Row memory row) = _launchBuy(c);
            if (!ok) continue;
            _checkReplay(row);
            _count(cov, row, k >= 2);
            vm.writeLine(LAUNCH_BUY, _json(row));
        }
    }

    function _sqrtRow(int24 tick) internal pure returns (string memory) {
        return string.concat(
            '{"tick":', vm.toString(int256(tick)),
            ',"sqrtPriceX96":"', vm.toString(uint256(TickMath.getSqrtPriceAtTick(tick))), '"}'
        );
    }

    function _writeSqrtRows() internal returns (uint256 rows) {
        int24[11] memory fixedTicks =
            [int24(0), 1, -1, 406_700, -406_700, 887_200, -887_200, 887_272, -887_272, 100, -100];
        for (uint256 i; i < fixedTicks.length; i++) {
            vm.writeLine(SQRT_PRICE, _sqrtRow(fixedTicks[i]));
            rows++;
        }
        // Every bitmap-word boundary at spacing 100, and the tick just below it.
        for (int24 k = -34; k <= 34; k++) {
            int24 boundary = k * WORD;
            if (boundary != 0 && boundary >= -887_272 && boundary <= 887_272) {
                vm.writeLine(SQRT_PRICE, _sqrtRow(boundary));
                rows++;
            }
            if (boundary - 1 >= -887_272 && boundary - 1 <= 887_272 && boundary - 1 != -1) {
                vm.writeLine(SQRT_PRICE, _sqrtRow(boundary - 1));
                rows++;
            }
        }
        for (uint256 i; i < 200; i++) {
            uint256 r = uint256(keccak256(abi.encode("sqrt", i)));
            int24 tick = int24(int256(r % 1_774_545)) - 887_272;
            vm.writeLine(SQRT_PRICE, _sqrtRow(tick));
            rows++;
        }
    }

    function test_WriteVectors() public {
        if (!_writing()) vm.skip(true, "set VECTORS=1 to rewrite test/vectors");
        vm.pauseGasMetering(); // hundreds of launches: far past any block, and not the point here
        _reset(LAUNCH_BUY);
        _reset(SQRT_PRICE);
        _writeSeedRows();
        Coverage memory cov = _writeNewRows();
        uint256 sqrtRows = _writeSqrtRows();

        assertGe(SEED_ROWS + cov.rows, 500, "at least 500 rows");
        assertGe(cov.rows, 200, "at least 200 new rows");
        assertGt(cov.dec18, 0, "18-decimal stocks");
        assertGt(cov.rows - cov.dec18, 0, "8-decimal stocks");
        assertGt(cov.c0Negative, 0, "token0, negative tick");
        assertGt(cov.c0Positive, 0, "token0, positive tick");
        assertGt(cov.c1Negative, 0, "token1, negative tick");
        assertGt(cov.c1Positive, 0, "token1, positive tick");
        assertGt(cov.oneRawUnit, 0, "one raw unit");
        assertGt(cov.exactWordStops, 0, "buys ending exactly on a word boundary");
        assertGe(cov.maxWordsCrossed, 7, "buys crossing 7 bitmap words");
        assertGe(cov.maxTokensOut, SUPPLY * 9_999 / 10_000, "99.99% of the supply");
        assertGe(sqrtRows, 200, "sqrt-price rows");
    }

    // ---- the committed files (every run) ----------------------------------------------------------

    function test_CommittedVectorsMatchTheReplay() public {
        if (_writing()) vm.skip(true, "the writer is rewriting the files in this run");
        vm.pauseGasMetering();
        vm.closeFile(LAUNCH_BUY);
        vm.closeFile(SEED);
        uint256 rows;
        while (true) {
            string memory line = vm.readLine(LAUNCH_BUY);
            if (bytes(line).length == 0) break;
            Row memory row = _parse(line);
            _checkReplay(row);
            if (rows < SEED_ROWS) {
                string memory seed = vm.readLine(SEED);
                assertEq(row.tick, int24(vm.parseJsonInt(seed, ".tick")), "seed tick");
                assertEq(row.c0, vm.parseJsonBool(seed, ".tokenIsCurrency0"), "seed ordering");
                assertEq(row.stockIn, vm.parseJsonUint(seed, ".stockIn"), "seed stockIn");
                assertEq(row.tokensOut, vm.parseJsonUint(seed, ".tokensOut"), "seed tokensOut");
            }
            rows++;
        }
        vm.closeFile(LAUNCH_BUY);
        vm.closeFile(SEED);
        assertGe(rows, 500, "launch-buy rows");

        uint256 sqrtRows;
        vm.closeFile(SQRT_PRICE);
        while (true) {
            string memory line = vm.readLine(SQRT_PRICE);
            if (bytes(line).length == 0) break;
            int24 tick = int24(vm.parseJsonInt(line, ".tick"));
            assertEq(
                uint256(TickMath.getSqrtPriceAtTick(tick)), vm.parseJsonUint(line, ".sqrtPriceX96"), "sqrt"
            );
            sqrtRows++;
        }
        vm.closeFile(SQRT_PRICE);
        assertGe(sqrtRows, 200, "sqrt-price rows");
    }
}
