// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IUniswapV3SwapRouter.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockUniswapV3Router
 * @notice Mock Uniswap V3 router for testing SwapModule
 * @dev Simulates swap behavior with configurable exchange rates
 */
contract MockUniswapV3Router is IUniswapV3SwapRouter {
    using SafeERC20 for IERC20;

    // Exchange rate: tokenIn => tokenOut => rate (amountOut = amountIn * rate / 1e18)
    mapping(address => mapping(address => uint256)) private exchangeRates;
    
    // Default exchange rate (1:1)
    uint256 public constant DEFAULT_RATE = 1e18;

    event SwapExecuted(
        address indexed tokenIn,
        address indexed tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    /**
     * @notice Set exchange rate for a token pair
     * @param tokenIn Input token
     * @param tokenOut Output token
     * @param rate Exchange rate (amountOut = amountIn * rate / 1e18)
     */
    function setExchangeRate(address tokenIn, address tokenOut, uint256 rate) external {
        exchangeRates[tokenIn][tokenOut] = rate;
    }

    /**
     * @notice Get exchange rate for a token pair
     * @param tokenIn Input token
     * @param tokenOut Output token
     * @return rate Exchange rate
     */
    function getExchangeRate(address tokenIn, address tokenOut) external view returns (uint256) {
        uint256 rate = exchangeRates[tokenIn][tokenOut];
        return rate > 0 ? rate : DEFAULT_RATE;
    }

    /**
     * @notice Execute a swap (mock implementation)
     * @param params Swap parameters
     * @return amountOut Amount of output token received
     */
    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(params.deadline >= block.timestamp, "MockUniswapV3Router: deadline passed");
        require(params.amountIn > 0, "MockUniswapV3Router: zero amount");
        
        // Get exchange rate
        uint256 rate = exchangeRates[params.tokenIn][params.tokenOut];
        if (rate == 0) {
            rate = DEFAULT_RATE;
        }
        
        // Calculate output amount
        amountOut = (params.amountIn * rate) / 1e18;
        
        // Apply slippage protection if amountOutMinimum is set
        if (params.amountOutMinimum > 0) {
            require(amountOut >= params.amountOutMinimum, "MockUniswapV3Router: insufficient output");
        }
        
        // Transfer tokens
        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        
        emit SwapExecuted(params.tokenIn, params.tokenOut, params.amountIn, amountOut);
        
        return amountOut;
    }
}
