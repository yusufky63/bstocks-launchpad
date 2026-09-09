// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { FullMath } from "@uniswap/v4-core/src/libraries/FullMath.sol";
import { LiquidityAmounts } from "@uniswap/v4-periphery/src/libraries/LiquidityAmounts.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Ownable2Step, Ownable } from "@openzeppelin/contracts/access/Ownable2Step.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { B20Encoding } from "./B20Encoding.sol";
import { IB20Factory, IB20Token } from "./interfaces/IB20Factory.sol";
import { IChainlinkFeed } from "./interfaces/IChainlinkFeed.sol";
import { StockPairHook } from "./StockPairHook.sol";

/// @title StockPairFactory
/// @notice One transaction creates a zero-admin B20 token with a fixed 1 billion supply, opens a
///         Uniswap v4 pool against a Coinbase tokenized stock, and locks the entire supply as a
///         single-sided position that this contract holds forever. There is no function that can
///         withdraw that liquidity.
/// @dev The opening price is derived onchain from the stock's Chainlink feed so that every
///      launch opens at the same fully diluted valuation in USD, regardless of the stock chosen.
contract StockPairFactory is IUnlockCallback, Ownable2Step, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using SafeERC20 for IERC20;

    struct Stock {
        address feed;
        bool enabled;
        uint8 decimals;
        string symbol;
    }

    struct LaunchParams {
        string name;
        string symbol;
        string contractURI;
        address stock;
        bytes32 salt;
    }

    struct Launch {
        address stock;
        address creator;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint64 launchedAt;
        uint160 openingSqrtPriceX96;
        uint256 stockUsd8;
    }

    struct Opening {
        bool tokenIsCurrency0;
        uint160 sqrtPriceX96;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint256 stockUsd8;
    }

    struct CallbackData {
        PoolKey key;
        address token;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    IB20Factory public constant B20_FACTORY =
        IB20Factory(0xB20f000000000000000000000000000000000000);
    address public constant DUST_SINK = 0x000000000000000000000000000000000000dEaD;

    uint256 public constant SUPPLY = 1_000_000_000e18;
    int24 public constant TICK_SPACING = 100;
    uint24 public constant LP_FEE = 0;
    uint256 public constant MAX_FEED_AGE = 7 days;
    uint256 public constant MIN_OPENING_FDV_USD8 = 100e8;
    uint256 public constant MAX_OPENING_FDV_USD8 = 1_000_000e8;
    uint256 public constant MAX_CREATION_FEE = 0.01 ether;

    IPoolManager public immutable poolManager;
    StockPairHook public hook;
    address public treasury;
    uint256 public creationFee = 0.0001 ether;
    /// @notice Fully diluted valuation every launch opens at, in USD with 8 decimals.
    uint256 public openingFdvUsd8 = 5_000e8;

    mapping(address => Stock) private _stocks;
    address[] private _stockList;
    mapping(address => Launch) private _launches;
    address[] private _tokens;

    event StockAdded(address indexed stock, address indexed feed, string symbol, uint8 decimals);
    event StockEnabled(address indexed stock, bool enabled);
    event HookSet(address indexed hook);
    event TreasurySet(address indexed treasury);
    event CreationFeeSet(uint256 fee);
    event OpeningFdvSet(uint256 fdvUsd8);
    event Launched(
        address indexed token,
        address indexed creator,
        address indexed stock,
        PoolId poolId,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity,
        uint256 stockUsd8,
        string name,
        string symbol,
        string contractURI
    );

    error HookNotSet();
    error HookAlreadySet();
    error StockNotEnabled();
    error StockAlreadyAdded();
    error InvalidFeed();
    error StaleFeed();
    error WrongCreationFee();
    error InvalidText();
    error InvalidRange();
    error UnexpectedSupply();
    error UnexpectedDelta();
    error OnlyPoolManager();
    error TreasuryTransferFailed();
    error OutOfBounds();
    error ZeroAddress();

    constructor(IPoolManager manager, address owner_, address treasury_) Ownable(owner_) {
        if (treasury_ == address(0)) revert ZeroAddress();
        poolManager = manager;
        treasury = treasury_;
    }

    // ---------------------------------------------------------------------------------------
    // Administration (stock registry and fee parameters only; launches are immutable)
    // ---------------------------------------------------------------------------------------

    function setHook(StockPairHook hook_) external onlyOwner {
        if (address(hook) != address(0)) revert HookAlreadySet();
        hook = hook_;
        emit HookSet(address(hook_));
    }

    function setTreasury(address treasury_) external onlyOwner {
        if (treasury_ == address(0)) revert ZeroAddress();
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    function setCreationFee(uint256 fee) external onlyOwner {
        if (fee > MAX_CREATION_FEE) revert OutOfBounds();
        creationFee = fee;
        emit CreationFeeSet(fee);
    }

    function setOpeningFdv(uint256 fdvUsd8) external onlyOwner {
        if (fdvUsd8 < MIN_OPENING_FDV_USD8 || fdvUsd8 > MAX_OPENING_FDV_USD8) revert OutOfBounds();
        openingFdvUsd8 = fdvUsd8;
        emit OpeningFdvSet(fdvUsd8);
    }

    /// @dev `decimals` is supplied by the owner: Coinbase stock tokens are Base-native precompiles
    ///      that local simulations cannot call, and the value is immutable per token anyway.
    function addStock(address stock, address feed, string calldata symbol, uint8 decimals)
        external
        onlyOwner
    {
        if (_stocks[stock].feed != address(0)) revert StockAlreadyAdded();
        if (IChainlinkFeed(feed).decimals() != 8) revert InvalidFeed();
        if (decimals == 0 || decimals > 18) revert OutOfBounds();
        _stocks[stock] = Stock({ feed: feed, enabled: true, decimals: decimals, symbol: symbol });
        _stockList.push(stock);
        emit StockAdded(stock, feed, symbol, decimals);
    }

    function setStockEnabled(address stock, bool enabled) external onlyOwner {
        if (_stocks[stock].feed == address(0)) revert StockNotEnabled();
        _stocks[stock].enabled = enabled;
        emit StockEnabled(stock, enabled);
    }

    // ---------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------

    function stockInfo(address stock) external view returns (Stock memory) {
        return _stocks[stock];
    }

    function stocks() external view returns (address[] memory) {
        return _stockList;
    }

    function launchOf(address token) external view returns (Launch memory) {
        return _launches[token];
    }

    function tokens() external view returns (address[] memory) {
        return _tokens;
    }

    function tokenCount() external view returns (uint256) {
        return _tokens.length;
    }

    function poolKeyOf(address token) public view returns (PoolKey memory) {
        return _poolKey(token, _launches[token].stock, token < _launches[token].stock);
    }

    /// @notice Deterministic token address for a creator and salt, before launching.
    function predictToken(address creator, bytes32 salt) external view returns (address) {
        return B20_FACTORY.getB20Address(
            IB20Factory.B20Variant.ASSET, address(this), _launchSalt(creator, salt)
        );
    }

    /// @notice The opening sqrt price a launch against `stock` would receive right now.
    function previewOpening(address stock, address token)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint256 stockUsd8)
    {
        Stock storage info = _stocks[stock];
        if (!info.enabled) revert StockNotEnabled();
        stockUsd8 = _readStockUsd8(info.feed);
        sqrtPriceX96 = _openingSqrtPrice(token < stock, info.decimals, stockUsd8);
        tick = TickMath.getTickAtSqrtPrice(sqrtPriceX96);
    }

    // ---------------------------------------------------------------------------------------
    // Launch
    // ---------------------------------------------------------------------------------------

    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, PoolId poolId)
    {
        _checkLaunch(p);
        token = _createToken(p);
        Opening memory o = _opening(token, p.stock);
        PoolKey memory key = _poolKey(token, p.stock, o.tokenIsCurrency0);
        poolId = key.toId();

        poolManager.initialize(key, o.sqrtPriceX96);
        poolManager.unlock(
            abi.encode(
                CallbackData({
                    key: key,
                    token: token,
                    tickLower: o.tickLower,
                    tickUpper: o.tickUpper,
                    liquidity: o.liquidity
                })
            )
        );

        _finish(token, key, p, o);
    }

    /// @dev PoolManager callback: mints the locked position and pays the launched token.
    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        CallbackData memory data = abi.decode(rawData, (CallbackData));

        (BalanceDelta delta,) = poolManager.modifyLiquidity(
            data.key,
            ModifyLiquidityParams({
                tickLower: data.tickLower,
                tickUpper: data.tickUpper,
                liquidityDelta: int256(uint256(data.liquidity)),
                salt: bytes32(0)
            }),
            ""
        );

        bool tokenIsCurrency0 = Currency.unwrap(data.key.currency0) == data.token;
        int128 tokenDelta = tokenIsCurrency0 ? delta.amount0() : delta.amount1();
        int128 stockDelta = tokenIsCurrency0 ? delta.amount1() : delta.amount0();
        if (stockDelta != 0 || tokenDelta >= 0) revert UnexpectedDelta();

        uint256 owed = uint256(uint128(-tokenDelta));
        poolManager.sync(Currency.wrap(data.token));
        IERC20(data.token).safeTransfer(address(poolManager), owed);
        poolManager.settle();
        return "";
    }

    // ---------------------------------------------------------------------------------------
    // Launch internals
    // ---------------------------------------------------------------------------------------

    function _checkLaunch(LaunchParams calldata p) private view {
        if (address(hook) == address(0)) revert HookNotSet();
        if (msg.value != creationFee) revert WrongCreationFee();
        if (!_stocks[p.stock].enabled) revert StockNotEnabled();
        _validateText(p.name, 1, 64);
        _validateText(p.symbol, 1, 16);
        _validateText(p.contractURI, 0, 512);
    }

    /// @dev Creates the zero-admin B20 token with the full supply minted to this contract.
    function _createToken(LaunchParams calldata p) private returns (address token) {
        token = B20_FACTORY.createB20(
            IB20Factory.B20Variant.ASSET,
            _launchSalt(msg.sender, p.salt),
            B20Encoding.assetParams(p.name, p.symbol),
            B20Encoding.bootstrapCalls(address(this), SUPPLY, p.contractURI)
        );
        if (IB20Token(token).balanceOf(address(this)) != SUPPLY) revert UnexpectedSupply();
    }

    /// @dev Opening price from the stock's feed plus the single-sided range holding only the token.
    function _opening(address token, address stock) private view returns (Opening memory o) {
        Stock storage info = _stocks[stock];
        o.tokenIsCurrency0 = token < stock;
        o.stockUsd8 = _readStockUsd8(info.feed);
        o.sqrtPriceX96 = _openingSqrtPrice(o.tokenIsCurrency0, info.decimals, o.stockUsd8);
        int24 currentTick = TickMath.getTickAtSqrtPrice(o.sqrtPriceX96);
        (o.tickLower, o.tickUpper) = _launchRange(o.tokenIsCurrency0, currentTick);
        uint160 sqrtLower = TickMath.getSqrtPriceAtTick(o.tickLower);
        uint160 sqrtUpper = TickMath.getSqrtPriceAtTick(o.tickUpper);
        o.liquidity = o.tokenIsCurrency0
            ? LiquidityAmounts.getLiquidityForAmount0(sqrtLower, sqrtUpper, SUPPLY)
            : LiquidityAmounts.getLiquidityForAmount1(sqrtLower, sqrtUpper, SUPPLY);
        if (o.liquidity == 0) revert InvalidRange();
    }

    function _finish(address token, PoolKey memory key, LaunchParams calldata p, Opening memory o)
        private
    {
        // Rounding dust is burned; the factory never keeps launched tokens.
        uint256 dust = IB20Token(token).balanceOf(address(this));
        if (dust > 0) IERC20(token).safeTransfer(DUST_SINK, dust);

        _launches[token] = Launch({
            stock: p.stock,
            creator: msg.sender,
            tickLower: o.tickLower,
            tickUpper: o.tickUpper,
            liquidity: o.liquidity,
            launchedAt: uint64(block.timestamp),
            openingSqrtPriceX96: o.sqrtPriceX96,
            stockUsd8: o.stockUsd8
        });
        _tokens.push(token);
        hook.registerPool(key, token, p.stock, msg.sender);

        if (msg.value > 0) {
            (bool ok,) = treasury.call{ value: msg.value }("");
            if (!ok) revert TreasuryTransferFailed();
        }

        _emitLaunched(token, key.toId(), p, o);
    }

    function _emitLaunched(address token, PoolId poolId, LaunchParams calldata p, Opening memory o)
        private
    {
        emit Launched(
            token,
            msg.sender,
            p.stock,
            poolId,
            o.sqrtPriceX96,
            o.tickLower,
            o.tickUpper,
            o.liquidity,
            o.stockUsd8,
            p.name,
            p.symbol,
            p.contractURI
        );
    }

    // ---------------------------------------------------------------------------------------
    // Pure helpers
    // ---------------------------------------------------------------------------------------

    function _poolKey(address token, address stock, bool tokenIsCurrency0)
        private
        view
        returns (PoolKey memory)
    {
        return PoolKey({
            currency0: Currency.wrap(tokenIsCurrency0 ? token : stock),
            currency1: Currency.wrap(tokenIsCurrency0 ? stock : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(hook))
        });
    }

    function _launchSalt(address creator, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(creator, salt));
    }

    function _validateText(string calldata value, uint256 minLength, uint256 maxLength)
        private
        pure
    {
        bytes calldata raw = bytes(value);
        uint256 length = raw.length;
        if (length < minLength || length > maxLength) revert InvalidText();
        // Control bytes are rejected because everything downstream has to store this text. A NUL is
        // the sharp case: Postgres refuses it outright, so a name that is one NUL byte is a legal
        // launch here and an unindexable row there. Indexers must defend themselves regardless --
        // this contract cannot be changed once deployed -- but there is no reason to emit it.
        for (uint256 i; i < length; ++i) {
            uint8 c = uint8(raw[i]);
            if (c < 0x20 || c == 0x7F) revert InvalidText();
        }
    }

    function _readStockUsd8(address feed) private view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = IChainlinkFeed(feed).latestRoundData();
        if (answer <= 0) revert InvalidFeed();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > MAX_FEED_AGE) {
            revert StaleFeed();
        }
        return uint256(answer);
    }

    /// @dev Price in Uniswap terms is raw currency1 per raw currency0.
    ///      Whole tokens per whole stock W = stockUsd8 * 1e9 / openingFdvUsd8 (supply is 1e9).
    ///      token as currency0: P = 10^stockDecimals / (W * 1e18)
    ///                          = 10^stockDecimals * fdv / (stockUsd8 * 1e27)
    ///      token as currency1: P = (W * 1e18) / 10^stockDecimals
    ///                          = stockUsd8 * 1e27 / (10^stockDecimals * fdv)
    ///      sqrtPriceX96 = sqrt(P * 2^192) computed as sqrt(P * 2^128) * 2^32.
    function _openingSqrtPrice(bool tokenIsCurrency0, uint8 stockDecimals, uint256 stockUsd8)
        private
        view
        returns (uint160)
    {
        uint256 stockUnit = 10 ** uint256(stockDecimals);
        uint256 numerator;
        uint256 denominator;
        if (tokenIsCurrency0) {
            numerator = stockUnit * openingFdvUsd8;
            denominator = stockUsd8 * 1e27;
        } else {
            numerator = stockUsd8 * 1e27;
            denominator = stockUnit * openingFdvUsd8;
        }
        uint256 ratioX128 = FullMath.mulDiv(numerator, 1 << 128, denominator);
        uint256 sqrtPriceX96 = Math.sqrt(ratioX128) << 32;
        if (sqrtPriceX96 <= TickMath.MIN_SQRT_PRICE || sqrtPriceX96 >= TickMath.MAX_SQRT_PRICE) {
            revert InvalidRange();
        }
        return uint160(sqrtPriceX96);
    }

    /// @dev token as currency0: the position sits strictly above the current tick so it holds
    ///      only currency0. token as currency1: at or below the current tick.
    function _launchRange(bool tokenIsCurrency0, int24 currentTick)
        private
        pure
        returns (int24 tickLower, int24 tickUpper)
    {
        int24 maxUsable = (TickMath.MAX_TICK / TICK_SPACING) * TICK_SPACING;
        if (tokenIsCurrency0) {
            tickLower = _floorTick(currentTick) + TICK_SPACING;
            tickUpper = maxUsable;
        } else {
            tickLower = -maxUsable;
            tickUpper = _floorTick(currentTick);
        }
        if (tickLower >= tickUpper) revert InvalidRange();
    }

    function _floorTick(int24 tick) private pure returns (int24) {
        int24 quotient = tick / TICK_SPACING;
        if (tick < 0 && tick % TICK_SPACING != 0) quotient -= 1;
        return quotient * TICK_SPACING;
    }
}
