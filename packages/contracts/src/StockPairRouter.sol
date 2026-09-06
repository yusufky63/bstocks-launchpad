// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IUnlockCallback } from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { BalanceDelta } from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title StockPairRouter
/// @notice Minimal exact-input swap router for StockPair pools. The caller approves the input
///         token to this router; the router pulls exactly what the pool needs and forwards the
///         output to the recipient. It keeps no balances.
contract StockPairRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct SwapData {
        PoolKey key;
        bool zeroForOne;
        uint128 amountIn;
        uint128 minAmountOut;
        address payer;
        address recipient;
    }

    IPoolManager public immutable poolManager;

    event Swapped(
        address indexed payer,
        address indexed recipient,
        address indexed tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error Expired();
    error OnlyPoolManager();
    error TooLittleReceived();
    error ZeroAmount();

    constructor(IPoolManager manager) {
        poolManager = manager;
    }

    function swapExactIn(
        PoolKey calldata key,
        bool zeroForOne,
        uint128 amountIn,
        uint128 minAmountOut,
        address recipient,
        uint256 deadline
    ) external nonReentrant returns (uint256 amountOut) {
        if (block.timestamp > deadline) revert Expired();
        if (amountIn == 0) revert ZeroAmount();
        bytes memory result = poolManager.unlock(
            abi.encode(
                SwapData({
                    key: key,
                    zeroForOne: zeroForOne,
                    amountIn: amountIn,
                    minAmountOut: minAmountOut,
                    payer: msg.sender,
                    recipient: recipient
                })
            )
        );
        amountOut = abi.decode(result, (uint256));
    }

    function unlockCallback(bytes calldata rawData) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert OnlyPoolManager();
        SwapData memory data = abi.decode(rawData, (SwapData));

        BalanceDelta delta = poolManager.swap(
            data.key,
            SwapParams({
                zeroForOne: data.zeroForOne,
                amountSpecified: -int256(uint256(data.amountIn)),
                sqrtPriceLimitX96: data.zeroForOne
                    ? TickMath.MIN_SQRT_PRICE + 1
                    : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        (Currency currencyIn, Currency currencyOut) = data.zeroForOne
            ? (data.key.currency0, data.key.currency1)
            : (data.key.currency1, data.key.currency0);
        int128 deltaIn = data.zeroForOne ? delta.amount0() : delta.amount1();
        int128 deltaOut = data.zeroForOne ? delta.amount1() : delta.amount0();

        uint256 owed = deltaIn < 0 ? uint256(uint128(-deltaIn)) : 0;
        uint256 received = deltaOut > 0 ? uint256(uint128(deltaOut)) : 0;
        if (received < data.minAmountOut) revert TooLittleReceived();

        if (owed > 0) {
            poolManager.sync(currencyIn);
            IERC20(Currency.unwrap(currencyIn)).safeTransferFrom(
                data.payer, address(poolManager), owed
            );
            poolManager.settle();
        }
        if (received > 0) {
            poolManager.take(currencyOut, data.recipient, received);
        }

        emit Swapped(
            data.payer,
            data.recipient,
            Currency.unwrap(currencyIn),
            Currency.unwrap(currencyOut),
            owed,
            received
        );
        return abi.encode(received);
    }
}
