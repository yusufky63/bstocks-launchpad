// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { HookBase } from "./HookBase.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Currency, CurrencyLibrary } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {
    BeforeSwapDelta,
    BeforeSwapDeltaLibrary,
    toBeforeSwapDelta
} from "@uniswap/v4-core/src/types/BeforeSwapDelta.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { SafeCast } from "@uniswap/v4-core/src/libraries/SafeCast.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title StockPairHook
/// @notice Uniswap v4 hook attached to every StockPair pool. It charges the swap fee always in
///         the tokenized stock (never in the launched token), applies a 20 second anti-snipe
///         schedule after launch, and keeps a claimable ledger for the creator and the platform.
/// @dev Fees are collected as ERC-6909 claims on the PoolManager, so the tokens stay inside
///      the PoolManager until someone claims. Pools using this hook can only be initialized by
///      the factory. The hook never holds pool liquidity.
contract StockPairHook is HookBase, IUnlockCallback, ReentrancyGuard {
    using PoolIdLibrary for PoolKey;
    using CurrencyLibrary for Currency;
    using SafeCast for uint256;

    struct PoolInfo {
        address token;
        address stock;
        address creator;
        uint64 launchedAt;
    }

    struct ClaimData {
        address stock;
        address to;
        uint256 amount;
    }

    uint256 public constant BPS = 10_000;
    /// @notice Steady-state swap fee: 1% of the stock-side amount.
    uint256 public constant BASE_FEE_BPS = 100;
    /// @notice Fee in the first block after launch; decays linearly to BASE_FEE_BPS.
    uint256 public constant START_FEE_BPS = 9_900;
    uint256 public constant ANTI_SNIPE_SECONDS = 20;
    /// @notice Creator share of every fee; the remainder goes to the platform treasury.
    uint256 public constant CREATOR_SHARE_BPS = 7_000;

    address public immutable factory;

    mapping(PoolId => PoolInfo) private _pools;
    /// @notice claimable[stock][account] in stock token units.
    mapping(address => mapping(address => uint256)) public claimable;
    /// @notice Lifetime fees per pool in stock units.
    mapping(PoolId => uint256) public totalFees;

    event PoolRegistered(
        PoolId indexed poolId, address indexed token, address indexed stock, address creator
    );
    event FeeCharged(
        PoolId indexed poolId,
        address indexed stock,
        uint256 amount,
        uint256 creatorAmount,
        uint256 platformAmount,
        uint256 feeBps
    );
    event FeesClaimed(address indexed stock, address indexed account, uint256 amount);

    error OnlyFactory();
    error UnknownPool();
    error NothingToClaim();

    constructor(IPoolManager manager, address factory_) HookBase(manager) {
        factory = factory_;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory) {
        return Hooks.Permissions({
            beforeInitialize: true,
            afterInitialize: false,
            beforeAddLiquidity: false,
            afterAddLiquidity: false,
            beforeRemoveLiquidity: false,
            afterRemoveLiquidity: false,
            beforeSwap: true,
            afterSwap: true,
            beforeDonate: false,
            afterDonate: false,
            beforeSwapReturnDelta: true,
            afterSwapReturnDelta: true,
            afterAddLiquidityReturnDelta: false,
            afterRemoveLiquidityReturnDelta: false
        });
    }

    // ---------------------------------------------------------------------------------------
    // Registry
    // ---------------------------------------------------------------------------------------

    /// @notice Called by the factory in the same transaction that initializes the pool.
    function registerPool(PoolKey calldata key, address token, address stock, address creator)
        external
    {
        if (msg.sender != factory) revert OnlyFactory();
        PoolId id = key.toId();
        _pools[id] = PoolInfo({
            token: token,
            stock: stock,
            creator: creator,
            launchedAt: uint64(block.timestamp)
        });
        emit PoolRegistered(id, token, stock, creator);
    }

    function poolInfo(PoolId id) external view returns (PoolInfo memory) {
        return _pools[id];
    }

    /// @notice Fee in basis points that a swap in this pool pays right now.
    function currentFeeBps(PoolId id) public view returns (uint256) {
        PoolInfo storage info = _pools[id];
        if (info.token == address(0)) return BASE_FEE_BPS;
        uint256 elapsed = block.timestamp - info.launchedAt;
        if (elapsed >= ANTI_SNIPE_SECONDS) return BASE_FEE_BPS;
        return START_FEE_BPS - ((START_FEE_BPS - BASE_FEE_BPS) * elapsed) / ANTI_SNIPE_SECONDS;
    }

    // ---------------------------------------------------------------------------------------
    // Claims
    // ---------------------------------------------------------------------------------------

    function claim(address stock) external nonReentrant returns (uint256 amount) {
        amount = claimable[stock][msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[stock][msg.sender] = 0;
        _withdraw(stock, msg.sender, amount);
    }

    function claimMany(address[] calldata stocks)
        external
        nonReentrant
        returns (uint256[] memory amounts)
    {
        amounts = new uint256[](stocks.length);
        for (uint256 i = 0; i < stocks.length; i++) {
            address stock = stocks[i];
            uint256 amount = claimable[stock][msg.sender];
            if (amount == 0) continue;
            claimable[stock][msg.sender] = 0;
            amounts[i] = amount;
            _withdraw(stock, msg.sender, amount);
        }
    }

    function _withdraw(address stock, address to, uint256 amount) private {
        poolManager.unlock(abi.encode(ClaimData({ stock: stock, to: to, amount: amount })));
        emit FeesClaimed(stock, to, amount);
    }

    /// @dev Burns the hook's ERC-6909 claims and pays the real tokens to the claimant.
    function unlockCallback(bytes calldata rawData)
        external
        onlyPoolManager
        returns (bytes memory)
    {
        ClaimData memory data = abi.decode(rawData, (ClaimData));
        Currency currency = Currency.wrap(data.stock);
        poolManager.burn(address(this), currency.toId(), data.amount);
        poolManager.take(currency, data.to, data.amount);
        return "";
    }

    // ---------------------------------------------------------------------------------------
    // Hook callbacks
    // ---------------------------------------------------------------------------------------

    function _beforeInitialize(address sender, PoolKey calldata, uint160)
        internal
        view
        override
        returns (bytes4)
    {
        if (sender != factory) revert OnlyFactory();
        return HookBase.beforeInitialize.selector;
    }

    /// @dev Charges the fee when the *specified* side of the swap is the stock:
    ///      exact-in with stock input, or exact-out with stock output.
    function _beforeSwap(address, PoolKey calldata key, SwapParams calldata params, bytes calldata)
        internal
        override
        returns (bytes4, BeforeSwapDelta, uint24)
    {
        PoolId id = key.toId();
        PoolInfo storage info = _pools[id];
        if (info.token == address(0)) revert UnknownPool();

        bool exactIn = params.amountSpecified < 0;
        Currency specified = (params.zeroForOne == exactIn) ? key.currency0 : key.currency1;
        if (Currency.unwrap(specified) != info.stock) {
            return (HookBase.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        uint256 specifiedAmount = exactIn
            ? uint256(-params.amountSpecified)
            : uint256(params.amountSpecified);
        uint256 feeBps = currentFeeBps(id);
        uint256 fee = (specifiedAmount * feeBps) / BPS;
        if (fee == 0) {
            return (HookBase.beforeSwap.selector, BeforeSwapDeltaLibrary.ZERO_DELTA, 0);
        }

        _charge(id, info, specified, fee, feeBps);
        return (HookBase.beforeSwap.selector, toBeforeSwapDelta(fee.toInt128(), 0), 0);
    }

    /// @dev Charges the fee when the *unspecified* side of the swap is the stock:
    ///      exact-in with stock output, or exact-out with stock input.
    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        PoolId id = key.toId();
        PoolInfo storage info = _pools[id];

        bool exactIn = params.amountSpecified < 0;
        Currency unspecified = (params.zeroForOne == exactIn) ? key.currency1 : key.currency0;
        if (Currency.unwrap(unspecified) != info.stock) {
            return (HookBase.afterSwap.selector, 0);
        }

        int128 unspecifiedDelta =
            (params.zeroForOne == exactIn) ? delta.amount1() : delta.amount0();
        uint256 unspecifiedAmount = unspecifiedDelta < 0
            ? uint256(uint128(-unspecifiedDelta))
            : uint256(uint128(unspecifiedDelta));
        uint256 feeBps = currentFeeBps(id);
        uint256 fee = (unspecifiedAmount * feeBps) / BPS;
        if (fee == 0) return (HookBase.afterSwap.selector, 0);

        _charge(id, info, unspecified, fee, feeBps);
        return (HookBase.afterSwap.selector, fee.toInt128());
    }

    /// @dev Mints ERC-6909 claims for the fee (a debit on the hook that the returned hook delta
    ///      offsets) and books the split.
    function _charge(PoolId id, PoolInfo storage info, Currency currency, uint256 fee, uint256 feeBps)
        private
    {
        poolManager.mint(address(this), currency.toId(), fee);
        uint256 creatorAmount = (fee * CREATOR_SHARE_BPS) / BPS;
        uint256 platformAmount = fee - creatorAmount;
        address treasury = IStockPairFactoryTreasury(factory).treasury();
        claimable[info.stock][info.creator] += creatorAmount;
        claimable[info.stock][treasury] += platformAmount;
        totalFees[id] += fee;
        emit FeeCharged(id, info.stock, fee, creatorAmount, platformAmount, feeBps);
    }
}

interface IStockPairFactoryTreasury {
    function treasury() external view returns (address);
}
