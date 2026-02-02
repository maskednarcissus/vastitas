// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPlugin
 * @notice Standard interface that all Vastitas plugins must implement
 * @dev Plugins route yield through RevenueRouter, never directly to token
 */
interface IPlugin {
    /**
     * @notice Returns the unique plugin identifier
     * @return pluginId Unique bytes32 identifier for this plugin
     */
    function pluginId() external view returns (bytes32);

    /**
     * @notice Returns all underlying assets this plugin can receive
     * @return assets Array of ERC-20 token addresses
     */
    function underlyingAssets() external view returns (address[] memory);

    /**
     * @notice Returns current claimable yield (optional, informational)
     * @return asset The asset address of claimable yield
     * @return amount The amount of claimable yield
     */
    function quoteClaimable() external view returns (address asset, uint256 amount);

    /**
     * @notice Claims yield and routes it to RevenueRouter
     * @dev MUST send yield to RevenueRouter, never directly to Vastitas token
     * @dev May include dev share metadata in the routing
     */
    function claimAndRoute() external;

    /**
     * @notice Returns the RevenueRouter address this plugin routes to
     * @return router Address of the RevenueRouter contract
     * @dev Should be immutable or settable only once
     */
    function routeTo() external view returns (address);
}
