// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../types/PluginTypes.sol";

/**
 * @title ISwapModule
 * @notice Interface for asset conversion to treasury asset
 */
interface ISwapModule {
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
    ) external returns (address treasuryAsset, uint256 convertedAmount);

    /**
     * @notice Get the treasury asset address
     * @return treasuryAsset The treasury asset address
     */
    function getTreasuryAsset() external view returns (address);

    /**
     * @notice Check if a swap route is whitelisted
     * @param fromAsset Source asset
     * @param toAsset Destination asset
     * @return whitelisted True if route is whitelisted
     */
    function isRouteWhitelisted(address fromAsset, address toAsset) external view returns (bool);
}
