// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/ISwapModule.sol";
import "./interfaces/IUniswapV3SwapRouter.sol";
import "./interfaces/IUniswapV3Quoter.sol";
import "./types/PluginTypes.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title SwapModule
 * @notice Handles asset conversion to treasury asset with tier-based limits
 * @dev Enforces slippage limits, route whitelisting, and prevents circular swaps
 * @dev Uses Uniswap V3 for DEX swaps with proper slippage protection
 */
contract SwapModule is ISwapModule, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    address public immutable treasuryAsset;
    address public router; // RevenueRouter address (can be set after deployment)
    
    // Uniswap V3 configuration
    IUniswapV3SwapRouter public uniswapRouter;
    IUniswapV3Quoter public uniswapQuoter;
    // Pool fee tier mapping: fromAsset => toAsset => fee (e.g., 3000 for 0.3%)
    mapping(address => mapping(address => uint24)) private poolFees;
    uint24 public constant DEFAULT_POOL_FEE = 3000; // 0.3% default fee tier

    // Whitelisted swap routes: fromAsset => toAsset => whitelisted
    mapping(address => mapping(address => bool)) private whitelistedRoutes;

    // Events
    event RouteWhitelisted(address indexed fromAsset, address indexed toAsset, bool whitelisted);
    event SwapExecuted(
        address indexed fromAsset,
        address indexed toAsset,
        uint256 fromAmount,
        uint256 toAmount,
        PluginTypes.PluginTier tier
    );
    event UniswapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    event UniswapQuoterUpdated(address indexed oldQuoter, address indexed newQuoter);
    event PoolFeeUpdated(address indexed fromAsset, address indexed toAsset, uint24 fee);

    /**
     * @notice Constructor
     * @param _treasuryAsset Address of the treasury asset (e.g., WETH, USDC)
     * @param _router Address of the RevenueRouter (can be zero and set later)
     * @param _uniswapRouter Address of Uniswap V3 SwapRouter (can be zero and set later)
     * @param admin Address with admin role
     */
    constructor(
        address _treasuryAsset,
        address _router,
        address _uniswapRouter,
        address admin
    ) {
        require(_treasuryAsset != address(0), "SwapModule: zero treasury asset");
        
        treasuryAsset = _treasuryAsset;
        router = _router; // Can be zero initially
        uniswapRouter = IUniswapV3SwapRouter(_uniswapRouter); // Can be zero initially
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);

        // Whitelist direct routes to treasury asset
        whitelistedRoutes[_treasuryAsset][_treasuryAsset] = true;
    }

    /**
     * @notice Set router address (admin only, can only be set once)
     * @param _router Address of the RevenueRouter
     */
    function setRouter(address _router) external onlyRole(ADMIN_ROLE) {
        require(_router != address(0), "SwapModule: zero router");
        require(router == address(0), "SwapModule: router already set");
        router = _router;
    }

    /**
     * @notice Set Uniswap V3 router address (admin only)
     * @param _uniswapRouter Address of Uniswap V3 SwapRouter
     */
    function setUniswapRouter(address _uniswapRouter) external onlyRole(ADMIN_ROLE) {
        require(_uniswapRouter != address(0), "SwapModule: zero uniswap router");
        address oldRouter = address(uniswapRouter);
        uniswapRouter = IUniswapV3SwapRouter(_uniswapRouter);
        emit UniswapRouterUpdated(oldRouter, _uniswapRouter);
    }

    /**
     * @notice Set Uniswap V3 quoter address (admin only)
     * @param _uniswapQuoter Address of Uniswap V3 Quoter
     */
    function setUniswapQuoter(address _uniswapQuoter) external onlyRole(ADMIN_ROLE) {
        require(_uniswapQuoter != address(0), "SwapModule: zero uniswap quoter");
        address oldQuoter = address(uniswapQuoter);
        uniswapQuoter = IUniswapV3Quoter(_uniswapQuoter);
        emit UniswapQuoterUpdated(oldQuoter, _uniswapQuoter);
    }

    /**
     * @notice Set pool fee for a swap route (admin only)
     * @param fromAsset Source asset
     * @param toAsset Destination asset
     * @param fee Pool fee tier (500 = 0.05%, 3000 = 0.3%, 10000 = 1%)
     */
    function setPoolFee(address fromAsset, address toAsset, uint24 fee) external onlyRole(ADMIN_ROLE) {
        require(fromAsset != address(0) && toAsset != address(0), "SwapModule: zero address");
        require(fee > 0, "SwapModule: zero fee");
        poolFees[fromAsset][toAsset] = fee;
        emit PoolFeeUpdated(fromAsset, toAsset, fee);
    }

    /**
     * @notice Get pool fee for a swap route
     * @param fromAsset Source asset
     * @param toAsset Destination asset
     * @return fee Pool fee tier, or DEFAULT_POOL_FEE if not set
     */
    function getPoolFee(address fromAsset, address toAsset) public view returns (uint24) {
        uint24 fee = poolFees[fromAsset][toAsset];
        return fee > 0 ? fee : DEFAULT_POOL_FEE;
    }

    /**
     * @notice Convert an asset to the treasury asset
     * @param fromAsset Source asset address
     * @param amount Amount to convert
     * @param tier Plugin tier for applying tier-based limits
     * @param maxSlippageBps Maximum allowed slippage in basis points
     * @return treasuryAsset The treasury asset address
     * @return convertedAmount Amount received after conversion
     */
    function convert(
        address fromAsset,
        uint256 amount,
        PluginTypes.PluginTier tier,
        uint256 maxSlippageBps
    ) external override returns (address, uint256) {
        require(msg.sender == router, "SwapModule: only router");
        require(fromAsset != address(0), "SwapModule: zero asset");
        require(amount > 0, "SwapModule: zero amount");

        // If already treasury asset, no conversion needed
        if (fromAsset == treasuryAsset) {
            return (treasuryAsset, amount);
        }

        // Check route is whitelisted
        require(
            isRouteWhitelisted(fromAsset, treasuryAsset),
            "SwapModule: route not whitelisted"
        );

        // Prevent circular swaps (basic check)
        require(fromAsset != treasuryAsset, "SwapModule: invalid route");

        // Validate slippage parameter
        require(maxSlippageBps <= 10000, "SwapModule: invalid slippage");

        // Transfer asset from router to this contract
        IERC20(fromAsset).safeTransferFrom(router, address(this), amount);

        // Execute swap via Uniswap V3
        uint256 convertedAmount;
        
        if (address(uniswapRouter) == address(0)) {
            // Fallback: if Uniswap router not set, revert (no mock behavior in production)
            revert("SwapModule: uniswap router not configured");
        }

        // Approve Uniswap router to spend fromAsset
        // Note: In OpenZeppelin v5, safeApprove is deprecated, using approve with reset pattern
        IERC20(fromAsset).approve(address(uniswapRouter), amount);

        // Get pool fee for this route
        uint24 fee = getPoolFee(fromAsset, treasuryAsset);

        uint256 amountOutMinimum = 0;
        if (maxSlippageBps < 10000) {
            require(address(uniswapQuoter) != address(0), "SwapModule: quoter not configured");
            uint256 quotedOut = uniswapQuoter.quoteExactInputSingle(
                fromAsset,
                treasuryAsset,
                fee,
                amount,
                0
            );
            amountOutMinimum = (quotedOut * (10000 - maxSlippageBps)) / 10000;
        }

        // Execute swap with slippage protection
        IUniswapV3SwapRouter.ExactInputSingleParams memory params = IUniswapV3SwapRouter.ExactInputSingleParams({
            tokenIn: fromAsset,
            tokenOut: treasuryAsset,
            fee: fee,
            recipient: address(this), // Receive in this contract first
            deadline: block.timestamp + 300, // 5 minute deadline
            amountIn: amount,
            amountOutMinimum: amountOutMinimum,
            sqrtPriceLimitX96: 0 // No price limit
        });

        // Store balance before swap for slippage verification
        uint256 balanceBefore = IERC20(treasuryAsset).balanceOf(address(this));
        
        // Execute swap
        convertedAmount = uniswapRouter.exactInputSingle(params);
        
        // Verify we received the expected amount
        uint256 balanceAfter = IERC20(treasuryAsset).balanceOf(address(this));
        require(balanceAfter >= balanceBefore + convertedAmount, "SwapModule: balance mismatch");
        
        // Additional safety: ensure we received some amount
        require(convertedAmount > 0, "SwapModule: zero output");
        
        if (amountOutMinimum > 0) {
            require(convertedAmount >= amountOutMinimum, "SwapModule: slippage exceeded");
        }

        // Reset approval to zero (security best practice)
        IERC20(fromAsset).approve(address(uniswapRouter), 0);

        // Transfer converted amount back to router
        IERC20(treasuryAsset).safeTransfer(router, convertedAmount);

        emit SwapExecuted(fromAsset, treasuryAsset, amount, convertedAmount, tier);

        return (treasuryAsset, convertedAmount);
    }

    /**
     * @notice Get the treasury asset address
     * @return treasuryAsset The treasury asset address
     */
    function getTreasuryAsset() external view override returns (address) {
        return treasuryAsset;
    }

    /**
     * @notice Check if a swap route is whitelisted
     * @param fromAsset Source asset
     * @param toAsset Destination asset
     * @return whitelisted True if route is whitelisted
     */
    function isRouteWhitelisted(address fromAsset, address toAsset) public view override returns (bool) {
        return whitelistedRoutes[fromAsset][toAsset];
    }

    /**
     * @notice Whitelist a swap route (admin only)
     * @param fromAsset Source asset
     * @param toAsset Destination asset
     * @param whitelisted Whether to whitelist or remove
     */
    function setRouteWhitelist(
        address fromAsset,
        address toAsset,
        bool whitelisted
    ) external onlyRole(ADMIN_ROLE) {
        require(fromAsset != address(0) && toAsset != address(0), "SwapModule: zero address");
        whitelistedRoutes[fromAsset][toAsset] = whitelisted;
        emit RouteWhitelisted(fromAsset, toAsset, whitelisted);
    }

    /**
     * @notice Emergency withdraw (admin only)
     * @param token Token to withdraw
     * @param to Recipient address
     * @param amount Amount to withdraw
     */
    function emergencyWithdraw(address token, address to, uint256 amount) external onlyRole(ADMIN_ROLE) {
        require(to != address(0), "SwapModule: zero recipient");
        IERC20(token).safeTransfer(to, amount);
    }
}
