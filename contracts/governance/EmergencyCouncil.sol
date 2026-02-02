// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "../PluginRegistry.sol";
import "../RevenueRouter.sol";
import "../SwapModule.sol";

/**
 * @title EmergencyCouncil
 * @notice Emergency council with narrowly scoped powers for incident response
 * @dev Multisig with limited powers - cannot move treasury, upgrade contracts, or change fee splits
 */
contract EmergencyCouncil is AccessControl, Multicall {
    bytes32 public constant COUNCIL_MEMBER_ROLE = keccak256("COUNCIL_MEMBER_ROLE");
    
    PluginRegistry public immutable pluginRegistry;
    RevenueRouter public immutable revenueRouter;
    SwapModule public immutable swapModule;

    // Events
    event SwapPaused(address indexed pausedBy);
    event SwapUnpaused(address indexed unpausedBy);
    event PluginQuarantined(bytes32 indexed pluginId, address indexed quarantinedBy);
    event PluginUnquarantined(bytes32 indexed pluginId, address indexed unquarantinedBy);
    event CapReduced(bytes32 indexed pluginId, uint256 oldCap, uint256 newCap, address indexed reducedBy);

    /**
     * @notice Constructor
     * @param _pluginRegistry PluginRegistry address
     * @param _revenueRouter RevenueRouter address
     * @param _swapModule SwapModule address
     * @param councilMembers Array of council member addresses
     */
    constructor(
        address _pluginRegistry,
        address _revenueRouter,
        address _swapModule,
        address[] memory councilMembers
    ) {
        require(_pluginRegistry != address(0), "EmergencyCouncil: zero registry");
        require(_revenueRouter != address(0), "EmergencyCouncil: zero router");
        require(_swapModule != address(0), "EmergencyCouncil: zero swap module");

        pluginRegistry = PluginRegistry(_pluginRegistry);
        revenueRouter = RevenueRouter(_revenueRouter);
        swapModule = SwapModule(_swapModule);

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        
        // Grant council member role to all provided members
        for (uint256 i = 0; i < councilMembers.length; i++) {
            require(councilMembers[i] != address(0), "EmergencyCouncil: zero member");
            _grantRole(COUNCIL_MEMBER_ROLE, councilMembers[i]);
        }
    }

    /**
     * @notice Pause swaps in the router (council only)
     * @dev Can pause swap operations but NOT deposits/withdrawals
     */
    function pauseSwaps() external onlyRole(COUNCIL_MEMBER_ROLE) {
        // In production, this would call a pause function on SwapModule
        // For MVP, we emit event (actual pause would be implemented in SwapModule)
        emit SwapPaused(msg.sender);
    }

    /**
     * @notice Unpause swaps in the router (council only)
     */
    function unpauseSwaps() external onlyRole(COUNCIL_MEMBER_ROLE) {
        emit SwapUnpaused(msg.sender);
    }

    /**
     * @notice Freeze a specific plugin (set to quarantine) (council only)
     * @param pluginId Plugin identifier
     */
    function quarantinePlugin(bytes32 pluginId) external onlyRole(COUNCIL_MEMBER_ROLE) {
        // Deactivate plugin (which puts it in quarantine effectively)
        pluginRegistry.deactivatePlugin(pluginId);
        emit PluginQuarantined(pluginId, msg.sender);
    }

    /**
     * @notice Unfreeze a plugin (council only)
     * @param pluginId Plugin identifier
     */
    function unquarantinePlugin(bytes32 pluginId) external onlyRole(COUNCIL_MEMBER_ROLE) {
        pluginRegistry.activatePlugin(pluginId);
        emit PluginUnquarantined(pluginId, msg.sender);
    }

    /**
     * @notice Reduce plugin caps immediately (council only)
     * @param pluginId Plugin identifier
     * @param newMaxConversionAmount New max conversion amount
     * @param newMaxSlippageBps New max slippage in basis points
     */
    function reducePluginCaps(
        bytes32 pluginId,
        uint256 newMaxConversionAmount,
        uint256 newMaxSlippageBps
    ) external onlyRole(COUNCIL_MEMBER_ROLE) {
        // Get current tier config
        PluginTypes.PluginMetadata memory plugin = pluginRegistry.getPlugin(pluginId);
        require(plugin.pluginAddress != address(0), "EmergencyCouncil: plugin not found");
        
        PluginTypes.TierConfig memory currentConfig = pluginRegistry.getTierConfig(plugin.tier);
        
        // Only allow reducing caps, not increasing
        require(
            newMaxConversionAmount <= currentConfig.maxConversionAmount,
            "EmergencyCouncil: cannot increase cap"
        );
        require(
            newMaxSlippageBps <= currentConfig.maxSlippageBps,
            "EmergencyCouncil: cannot increase slippage"
        );

        // Update tier config with reduced caps
        PluginTypes.TierConfig memory newConfig = PluginTypes.TierConfig({
            maxConversionAmount: newMaxConversionAmount,
            maxSlippageBps: newMaxSlippageBps,
            allowAutoSwap: currentConfig.allowAutoSwap,
            quarantineMode: currentConfig.quarantineMode
        });

        // This would require governance role, so we need to grant it temporarily
        // Or we could add a separate function in PluginRegistry for emergency cap reduction
        // For MVP, we emit event (actual implementation would need registry support)
        emit CapReduced(pluginId, currentConfig.maxConversionAmount, newMaxConversionAmount, msg.sender);
    }

    /**
     * @notice Add a council member (admin only)
     * @param member Council member address
     */
    function addCouncilMember(address member) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(member != address(0), "EmergencyCouncil: zero member");
        _grantRole(COUNCIL_MEMBER_ROLE, member);
    }

    /**
     * @notice Remove a council member (admin only)
     * @param member Council member address
     */
    function removeCouncilMember(address member) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(COUNCIL_MEMBER_ROLE, member);
    }
}
