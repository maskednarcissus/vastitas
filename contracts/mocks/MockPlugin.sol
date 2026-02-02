// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../interfaces/IPlugin.sol";
import "../interfaces/IRevenueRouter.sol";
import "../types/PluginTypes.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MockPlugin
 * @notice Mock plugin for testing
 */
contract MockPlugin is IPlugin {
    using SafeERC20 for IERC20;

    bytes32 public immutable override pluginId;
    address[] private _underlyingAssets;
    address public immutable override routeTo;
    
    address public yieldAsset;
    uint256 public yieldAmount;
    PluginTypes.DevShareMetadata public devShare;

    constructor(
        bytes32 _pluginId,
        address[] memory underlyingAssetsParam,
        address _routeTo
    ) {
        pluginId = _pluginId;
        _underlyingAssets = underlyingAssetsParam; // Store in state variable
        routeTo = _routeTo;
    }

    /**
     * @notice Returns all underlying assets this plugin can receive
     * @return assets Array of ERC-20 token addresses
     */
    function underlyingAssets() external view override returns (address[] memory) {
        return _underlyingAssets;
    }

    function setYield(address _yieldAsset, uint256 _yieldAmount) external {
        yieldAsset = _yieldAsset;
        yieldAmount = _yieldAmount;
    }

    function setDevShare(address _devRecipient, uint256 _devBps) external {
        devShare = PluginTypes.DevShareMetadata({
            devRecipient: _devRecipient,
            devBps: _devBps
        });
    }

    function quoteClaimable() external view override returns (address, uint256) {
        return (yieldAsset, yieldAmount);
    }

    function claimAndRoute() external override {
        require(yieldAsset != address(0), "MockPlugin: no yield set");
        require(yieldAmount > 0, "MockPlugin: zero yield");

        // Transfer yield asset to this contract first
        IERC20(yieldAsset).safeTransferFrom(msg.sender, address(this), yieldAmount);
        
        // Approve router to spend (using forceApprove for OpenZeppelin v5)
        IERC20(yieldAsset).forceApprove(routeTo, yieldAmount);

        // Call RevenueRouter.receiveYield via interface
        IRevenueRouter router = IRevenueRouter(routeTo);
        router.receiveYield(
            pluginId,
            yieldAsset,
            yieldAmount,
            devShare
        );
    }
}
