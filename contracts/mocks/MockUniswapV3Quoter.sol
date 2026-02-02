// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IUniswapV3Quoter.sol";

/**
 * @title MockUniswapV3Quoter
 * @notice Mock Uniswap V3 quoter for testing SwapModule slippage logic
 */
contract MockUniswapV3Quoter is IUniswapV3Quoter {
    // Exchange rate: tokenIn => tokenOut => rate (amountOut = amountIn * rate / 1e18)
    mapping(address => mapping(address => uint256)) private exchangeRates;

    uint256 public constant DEFAULT_RATE = 1e18;

    event QuoteRequested(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    function setExchangeRate(address tokenIn, address tokenOut, uint256 rate) external {
        exchangeRates[tokenIn][tokenOut] = rate;
    }

    function getExchangeRate(address tokenIn, address tokenOut) external view returns (uint256) {
        uint256 rate = exchangeRates[tokenIn][tokenOut];
        return rate > 0 ? rate : DEFAULT_RATE;
    }

    function quoteExactInputSingle(
        address tokenIn,
        address tokenOut,
        uint24,
        uint256 amountIn,
        uint160
    ) external override returns (uint256 amountOut) {
        uint256 rate = exchangeRates[tokenIn][tokenOut];
        if (rate == 0) {
            rate = DEFAULT_RATE;
        }
        amountOut = (amountIn * rate) / 1e18;
        emit QuoteRequested(tokenIn, tokenOut, amountIn, amountOut);
    }
}

