// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
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
///         withdraw that liquidity. Optionally the creator buys in the launch transaction, and
///         optionally keeps the contract URI editable. In that case the factory holds the token's
///         metadata role and uses it for nothing but the contract URI.
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

    /// @notice Checks a launch made through `launchWithOptions` or `launchAndBuy` must pass.
    /// @param metadataEditable Keep the contract URI editable by the creator (default false).
    ///        Name and symbol can never change either way.
    /// @param openingFdvUsd8 The opening FDV the creator reviewed; reverts if the owner changed it.
    /// @param deadline Latest block timestamp at which the launch may be included (inclusive).
    struct LaunchOptions {
        bool metadataEditable;
        uint256 openingFdvUsd8;
        uint256 deadline;
    }

    /// @notice The creator's first buy, paid in the stock from msg.sender, delivered to msg.sender.
    struct CreatorBuy {
        uint128 stockIn;
        uint128 minTokensOut;
    }

    /// @notice Immutable: never editable (every `launch`, every opted-out launch, every token from
    ///         earlier factories). Editable: the creator can still replace the contract URI.
    ///         Locked: it was editable and the creator gave that up for good.
    enum MetadataStatus {
        Immutable,
        Editable,
        Locked
    }

    /// @dev Only this contract's own unlock calls reach unlockCallback (PoolManager calls back
    ///      msg.sender), so the tag is never attacker-controlled. Out-of-range values fail
    ///      abi.decode.
    enum Action {
        Seed,
        Buy
    }

    struct SeedData {
        PoolKey key;
        address token;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
    }

    struct BuyData {
        PoolKey key;
        address token;
        address stock;
        address buyer;
        uint128 stockIn;
        uint128 minTokensOut;
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
    /// @dev Bit b is set exactly when byte b may appear in a CID: 0-9, A-Z and a-z.
    uint256 private constant CID_CHARS =
        (((1 << 10) - 1) << 0x30) | (((1 << 26) - 1) << 0x41) | (((1 << 26) - 1) << 0x61);

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
    /// @dev Set once, for launches whose creator chose an editable profile. Whether it is STILL
    ///      editable is read from the token itself (hasRole), which lockMetadata changes for good.
    mapping(address => bool) private _editableAtLaunch;

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
    /// @notice The creator's buy made in the launch transaction, after the pool opened.
    event CreatorBought(
        address indexed token,
        address indexed creator,
        PoolId indexed poolId,
        uint256 stockIn,
        uint256 fee,
        uint256 tokensOut
    );
    /// @notice The creator kept the contract URI editable at launch.
    event MetadataEditable(address indexed token, address indexed creator);
    /// @notice The creator changed the contract URI. The token also emits ContractURIUpdated().
    event ContractURIChanged(address indexed token, address indexed creator, string contractURI);
    /// @notice The creator gave up editing for good; the factory no longer holds METADATA_ROLE.
    event MetadataLocked(address indexed token, address indexed creator);

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
    error Expired();
    error OpeningFdvChanged();
    error ZeroAmount();
    error TooLittleReceived();
    error UnexpectedRoles();
    error MetadataNotEditable();
    error NotCreator();

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

    function metadataStatus(address token) public view returns (MetadataStatus) {
        if (!_editableAtLaunch[token]) return MetadataStatus.Immutable;
        return IB20Token(token).hasRole(B20Encoding.METADATA_ROLE, address(this))
            ? MetadataStatus.Editable
            : MetadataStatus.Locked;
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

    /// @notice Launch with a frozen profile and no first buy. Same ABI and behaviour as before.
    function launch(LaunchParams calldata p)
        external
        payable
        nonReentrant
        returns (address token, PoolId poolId)
    {
        (token, poolId,) = _launch(p, false);
    }

    /// @notice Launch with a deadline, an opening-FDV check and an optional editable profile.
    function launchWithOptions(LaunchParams calldata p, LaunchOptions calldata o)
        external
        payable
        nonReentrant
        returns (address token, PoolId poolId)
    {
        _checkOptions(p, o);
        (token, poolId,) = _launch(p, o.metadataEditable);
    }

    /// @notice Launch, then buy for msg.sender in the same transaction. Nothing can trade the pool
    ///         before this buy; `minTokensOut` covers the feed moving between quote and inclusion.
    ///         The buy pays the normal 1% fee; 70% of it is booked back to the creator.
    /// @dev    msg.value is the creation fee only. The stock goes from msg.sender straight into the
    ///         PoolManager; the factory never holds it.
    function launchAndBuy(LaunchParams calldata p, LaunchOptions calldata o, CreatorBuy calldata b)
        external
        payable
        nonReentrant
        returns (address token, PoolId poolId, uint256 tokensOut)
    {
        _checkOptions(p, o);
        if (b.stockIn == 0 || b.minTokensOut == 0) revert ZeroAmount();
        if (b.stockIn > uint128(type(int128).max)) revert OutOfBounds();
        PoolKey memory key;
        (token, poolId, key) = _launch(p, o.metadataEditable);
        tokensOut = _creatorBuy(key, token, p.stock, b);
    }

    /// @dev PoolManager callback. Only reachable through this contract's own unlock calls:
    ///      PoolManager.unlock always calls back msg.sender.
    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        (Action action, bytes memory inner) = abi.decode(rawData, (Action, bytes));
        if (action == Action.Buy) return _buy(abi.decode(inner, (BuyData)));
        return _seed(abi.decode(inner, (SeedData)));
    }

    // ---------------------------------------------------------------------------------------
    // Creator metadata (opt-in at launch; contract URI only; original creator only)
    // ---------------------------------------------------------------------------------------

    /// @notice Point the token at a new ERC-7572 metadata document. Content-addressed only
    ///         (ipfs://<CID>, no path), so the document can only change through an onchain event.
    ///         Links inside it (the image) are the reader's to check. The token emits
    ///         ContractURIUpdated().
    function updateContractURI(address token, string calldata newURI) external nonReentrant {
        _requireEditor(token);
        _validateIpfsURI(newURI);
        IB20Token(token).updateContractURI(newURI);
        emit ContractURIChanged(token, msg.sender, newURI);
    }

    /// @notice Freeze the profile for good. The factory renounces METADATA_ROLE on the token;
    ///         the token has no admin, so nothing can ever grant it again.
    function lockMetadata(address token) external nonReentrant {
        _requireEditor(token);
        IB20Token(token).renounceRole(B20Encoding.METADATA_ROLE, address(this));
        emit MetadataLocked(token, msg.sender);
    }

    // ---------------------------------------------------------------------------------------
    // Launch internals
    // ---------------------------------------------------------------------------------------

    function _launch(LaunchParams calldata p, bool editable)
        private
        returns (address token, PoolId poolId, PoolKey memory key)
    {
        _checkLaunch(p);
        token = _createToken(p, editable);
        Opening memory o = _opening(token, p.stock);
        key = _poolKey(token, p.stock, o.tokenIsCurrency0);
        poolId = key.toId();

        poolManager.initialize(key, o.sqrtPriceX96);
        poolManager.unlock(
            abi.encode(
                Action.Seed,
                abi.encode(
                    SeedData({
                        key: key,
                        token: token,
                        tickLower: o.tickLower,
                        tickUpper: o.tickUpper,
                        liquidity: o.liquidity
                    })
                )
            )
        );

        _finish(token, key, p, o);
        if (editable) {
            _editableAtLaunch[token] = true;
            emit MetadataEditable(token, msg.sender); // exactly one log after Launched
        }
    }

    function _checkOptions(LaunchParams calldata p, LaunchOptions calldata o) private view {
        if (block.timestamp > o.deadline) revert Expired();
        if (o.openingFdvUsd8 != openingFdvUsd8) revert OpeningFdvChanged();
        // Editable profiles start content-addressed too, so "locked" always means a fixed document.
        if (o.metadataEditable) _validateIpfsURI(p.contractURI);
    }

    /// @dev Mints the locked position and pays the launched token into the PoolManager.
    function _seed(SeedData memory data) private returns (bytes memory) {
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

    function _creatorBuy(PoolKey memory key, address token, address stock, CreatorBuy calldata b)
        private
        returns (uint256 tokensOut)
    {
        bytes memory result = poolManager.unlock(
            abi.encode(
                Action.Buy,
                abi.encode(
                    BuyData({
                        key: key,
                        token: token,
                        stock: stock,
                        buyer: msg.sender,
                        stockIn: b.stockIn,
                        minTokensOut: b.minTokensOut
                    })
                )
            )
        );
        tokensOut = abi.decode(result, (uint256));
        PoolId id = key.toId();
        // Nothing could trade this pool before this buy (the treasury is paid before registerPool),
        // so the pool's lifetime fee total is exactly this buy's fee.
        emit CreatorBought(token, msg.sender, id, b.stockIn, hook.totalFees(id), tokensOut);
    }

    /// @dev Exact-input stock -> token swap. Pays from the buyer, delivers to the buyer.
    function _buy(BuyData memory d) private returns (bytes memory) {
        bool zeroForOne = Currency.unwrap(d.key.currency0) == d.stock;
        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(uint256(d.stockIn)),
                sqrtPriceLimitX96: zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );
        int128 stockDelta = zeroForOne ? delta.amount0() : delta.amount1();
        int128 tokenDelta = zeroForOne ? delta.amount1() : delta.amount0();
        // Exact input: the buyer owes exactly stockIn, never more.
        if (int256(stockDelta) != -int256(uint256(d.stockIn)) || tokenDelta <= 0) {
            revert UnexpectedDelta();
        }
        uint256 tokensOut = uint256(uint128(tokenDelta));
        if (tokensOut < d.minTokensOut) revert TooLittleReceived();

        poolManager.sync(Currency.wrap(d.stock));
        IERC20(d.stock).safeTransferFrom(d.buyer, address(poolManager), d.stockIn);
        poolManager.settle();
        poolManager.take(Currency.wrap(d.token), d.buyer, tokensOut);
        return abi.encode(tokensOut);
    }

    /// @dev Unknown tokens fail the creator check (their creator is zero) before any external call.
    function _requireEditor(address token) private view {
        if (_launches[token].creator != msg.sender) revert NotCreator();
        if (metadataStatus(token) != MetadataStatus.Editable) revert MetadataNotEditable();
    }

    function _checkLaunch(LaunchParams calldata p) private view {
        if (address(hook) == address(0)) revert HookNotSet();
        if (msg.value != creationFee) revert WrongCreationFee();
        if (!_stocks[p.stock].enabled) revert StockNotEnabled();
        _validateText(p.name, 1, 64);
        _validateText(p.symbol, 1, 16);
        _validateText(p.contractURI, 0, 512);
    }

    /// @dev Creates the zero-admin B20 token with the full supply minted to this contract. The
    ///      factory holds METADATA_ROLE afterwards exactly when the creator asked for it.
    function _createToken(LaunchParams calldata p, bool editable) private returns (address token) {
        token = B20_FACTORY.createB20(
            IB20Factory.B20Variant.ASSET,
            _launchSalt(msg.sender, p.salt),
            B20Encoding.assetParams(p.name, p.symbol),
            B20Encoding.bootstrapCalls(
                address(this), SUPPLY, p.contractURI, editable ? address(this) : address(0)
            )
        );
        if (IB20Token(token).balanceOf(address(this)) != SUPPLY) revert UnexpectedSupply();
        if (IB20Token(token).hasRole(B20Encoding.METADATA_ROLE, address(this)) != editable) {
            revert UnexpectedRoles();
        }
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

        // Paid BEFORE the pool is registered with the hook. The treasury is an owner-set address
        // and this is a full-gas call; until registerPool runs, the hook rejects every swap in
        // this pool (UnknownPool), so nothing the treasury does here can trade the new pool,
        // neither at the opening price nor ahead of launchAndBuy's creator buy.
        if (msg.value > 0) {
            (bool ok,) = treasury.call{ value: msg.value }("");
            if (!ok) revert TreasuryTransferFailed();
        }

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

        _emitLaunched(token, key.toId(), p, o); // still the last factory log of _finish
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

    /// @dev ipfs://<bare CID>, 8 to 512 bytes, the CID letters and digits only. Content-addressed,
    ///      so the document an editable token points at only changes through an onchain event.
    ///      No path at all: gateways build <gateway>/ipfs/<rest> and normalize it, so "..",
    ///      "%2e%2e" or "\" in the rest can climb out to /ipns/<name>, which changes with no event.
    ///      The site pins bare CIDs.
    function _validateIpfsURI(string calldata uri) private pure {
        bytes calldata raw = bytes(uri);
        uint256 length = raw.length;
        if (length < 8 || length > 512 || bytes7(raw[0:7]) != bytes7("ipfs://")) {
            revert InvalidText();
        }
        for (uint256 i = 7; i < length; ++i) {
            if ((CID_CHARS >> uint8(raw[i])) & 1 == 0) revert InvalidText();
        }
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
