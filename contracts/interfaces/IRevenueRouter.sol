// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../types/PluginTypes.sol";

/**
 * @title IRevenueRouter
 * @notice Interface for the central yield routing contract
 */
interface IRevenueRouter {
    /**
     * @notice Receive yield from a plugin
     * @param pluginId The plugin identifier
     * @param asset The asset address
     * @param amount The yield amount
     * @param devShare Dev share metadata (optional, can be zero address for no dev share)
     */
    function receiveYield(
        bytes32 pluginId,
        address asset,
        uint256 amount,
        PluginTypes.DevShareMetadata calldata devShare
    ) external;

    /**
     * @notice Apply distribution policy to accumulated yield
     * @dev Executes buyback, distribution, or treasury allocation based on configured model
     */
    function applyPolicy() external;

    /**
     * @notice Get total yield received from a specific plugin
     * @param pluginId The plugin identifier
     * @return totalYield Total yield received from plugin
     */
    function getPluginYield(bytes32 pluginId) external view returns (uint256);

    /**
     * @notice Get total yield received globally
     * @return totalYield Total yield received from all plugins
     */
    function getTotalYield() external view returns (uint256);

    /**
     * @notice Get quarantined yield for a plugin and asset
     * @param pluginId The plugin identifier
     * @param asset The asset address
     * @return amount Quarantined amount held in custody
     */
    function getQuarantinedYield(bytes32 pluginId, address asset) external view returns (uint256);
}
