// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IPlugin.sol";
import "./types/PluginTypes.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title PluginRegistry
 * @notice Manages plugin registration, tier assignment, and tier-based configuration
 * @dev Permissionless registration, but tier assignment requires governance
 */
contract PluginRegistry is AccessControl {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    // Mapping from pluginId to PluginMetadata
    mapping(bytes32 => PluginTypes.PluginMetadata) private plugins;

    // Mapping from plugin address to pluginId (for reverse lookup)
    mapping(address => bytes32) private pluginAddressToId;

    // Tier configurations
    mapping(PluginTypes.PluginTier => PluginTypes.TierConfig) public tierConfigs;

    // Per-plugin caps (optional, stricter than tier config)
    mapping(bytes32 => PluginTypes.PluginCaps) private pluginCaps;

    // List of all registered plugin IDs
    bytes32[] private registeredPluginIds;

    // Events
    event PluginRegistered(
        bytes32 indexed pluginId,
        address indexed pluginAddress,
        PluginTypes.PluginTier tier,
        address indexed routeTo
    );

    event PluginTierUpdated(
        bytes32 indexed pluginId,
        PluginTypes.PluginTier oldTier,
        PluginTypes.PluginTier newTier
    );

    event TierConfigUpdated(
        PluginTypes.PluginTier tier,
        uint256 maxConversionAmount,
        uint256 maxSlippageBps,
        bool allowAutoSwap,
        bool quarantineMode
    );

    event PluginCapsUpdated(
        bytes32 indexed pluginId,
        uint256 maxConversionAmount,
        uint256 maxSlippageBps,
        bool enabled
    );

    event PluginDeactivated(bytes32 indexed pluginId);
    event PluginActivated(bytes32 indexed pluginId);

    /**
     * @notice Constructor
     * @param admin Address with admin role
     * @param governance Address with governance role
     */
    constructor(address admin, address governance) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, governance);

        // Initialize default tier configurations
        _initializeDefaultTierConfigs();
    }

    /**
     * @notice Register a new plugin (permissionless)
     * @param pluginAddress Address of the plugin contract
     * @dev Plugin must implement IPlugin interface
     * @dev Plugin is registered with Tier 0 (UNTRUSTED) by default
     */
    function registerPlugin(address pluginAddress) external returns (bytes32 pluginId) {
        require(pluginAddress != address(0), "PluginRegistry: zero address");
        require(pluginAddressToId[pluginAddress] == bytes32(0), "PluginRegistry: already registered");

        // Verify plugin implements IPlugin
        IPlugin plugin = IPlugin(pluginAddress);
        pluginId = plugin.pluginId();
        require(pluginId != bytes32(0), "PluginRegistry: invalid pluginId");
        require(plugins[pluginId].pluginAddress == address(0), "PluginRegistry: pluginId exists");

        address routeTo = plugin.routeTo();
        require(routeTo != address(0), "PluginRegistry: invalid routeTo");

        // Create metadata
        PluginTypes.PluginMetadata memory metadata = PluginTypes.PluginMetadata({
            pluginId: pluginId,
            pluginAddress: pluginAddress,
            tier: PluginTypes.PluginTier.UNTRUSTED,
            underlyingAssets: plugin.underlyingAssets(),
            routeTo: routeTo,
            registrationBlock: block.number,
            isActive: true
        });

        plugins[pluginId] = metadata;
        pluginAddressToId[pluginAddress] = pluginId;
        registeredPluginIds.push(pluginId);

        emit PluginRegistered(pluginId, pluginAddress, PluginTypes.PluginTier.UNTRUSTED, routeTo);
    }

    /**
     * @notice Set plugin tier (governance only)
     * @param pluginId The plugin identifier
     * @param newTier The new tier
     */
    function setPluginTier(bytes32 pluginId, PluginTypes.PluginTier newTier) external onlyRole(GOVERNANCE_ROLE) {
        require(plugins[pluginId].pluginAddress != address(0), "PluginRegistry: plugin not found");
        
        PluginTypes.PluginTier oldTier = plugins[pluginId].tier;
        plugins[pluginId].tier = newTier;

        emit PluginTierUpdated(pluginId, oldTier, newTier);
    }

    /**
     * @notice Update tier configuration (governance only)
     * @param tier The tier to configure
     * @param config The tier configuration
     */
    function setTierConfig(
        PluginTypes.PluginTier tier,
        PluginTypes.TierConfig memory config
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(config.maxSlippageBps <= 10000, "PluginRegistry: invalid slippage");
        tierConfigs[tier] = config;

        emit TierConfigUpdated(
            tier,
            config.maxConversionAmount,
            config.maxSlippageBps,
            config.allowAutoSwap,
            config.quarantineMode
        );
    }

    /**
     * @notice Set per-plugin caps (governance only)
     * @param pluginId The plugin identifier
     * @param caps The per-plugin caps configuration
     */
    function setPluginCaps(
        bytes32 pluginId,
        PluginTypes.PluginCaps memory caps
    ) external onlyRole(GOVERNANCE_ROLE) {
        require(plugins[pluginId].pluginAddress != address(0), "PluginRegistry: plugin not found");
        require(caps.maxSlippageBps <= 10000, "PluginRegistry: invalid slippage");
        pluginCaps[pluginId] = caps;
        emit PluginCapsUpdated(pluginId, caps.maxConversionAmount, caps.maxSlippageBps, caps.enabled);
    }

    /**
     * @notice Deactivate a plugin (admin/governance)
     * @param pluginId The plugin identifier
     */
    function deactivatePlugin(bytes32 pluginId) external onlyRole(ADMIN_ROLE) {
        require(plugins[pluginId].pluginAddress != address(0), "PluginRegistry: plugin not found");
        plugins[pluginId].isActive = false;
        emit PluginDeactivated(pluginId);
    }

    /**
     * @notice Activate a plugin (admin/governance)
     * @param pluginId The plugin identifier
     */
    function activatePlugin(bytes32 pluginId) external onlyRole(ADMIN_ROLE) {
        require(plugins[pluginId].pluginAddress != address(0), "PluginRegistry: plugin not found");
        plugins[pluginId].isActive = true;
        emit PluginActivated(pluginId);
    }

    /**
     * @notice Get plugin metadata
     * @param pluginId The plugin identifier
     * @return metadata The plugin metadata
     */
    function getPlugin(bytes32 pluginId) external view returns (PluginTypes.PluginMetadata memory) {
        return plugins[pluginId];
    }

    /**
     * @notice Get plugin ID from address
     * @param pluginAddress The plugin address
     * @return pluginId The plugin identifier
     */
    function getPluginId(address pluginAddress) external view returns (bytes32) {
        return pluginAddressToId[pluginAddress];
    }

    /**
     * @notice Get tier configuration
     * @param tier The tier
     * @return config The tier configuration
     */
    function getTierConfig(PluginTypes.PluginTier tier) external view returns (PluginTypes.TierConfig memory) {
        return tierConfigs[tier];
    }

    /**
     * @notice Get per-plugin caps
     * @param pluginId The plugin identifier
     * @return caps The per-plugin caps
     */
    function getPluginCaps(bytes32 pluginId) external view returns (PluginTypes.PluginCaps memory) {
        return pluginCaps[pluginId];
    }

    /**
     * @notice Get all registered plugin IDs
     * @return pluginIds Array of all registered plugin IDs
     */
    function getAllPluginIds() external view returns (bytes32[] memory) {
        return registeredPluginIds;
    }

    /**
     * @notice Initialize default tier configurations
     */
    function _initializeDefaultTierConfigs() private {
        // Tier 0: Untrusted - strict limits, quarantine mode
        tierConfigs[PluginTypes.PluginTier.UNTRUSTED] = PluginTypes.TierConfig({
            maxConversionAmount: 10000 * 10**18, // 10k tokens default
            maxSlippageBps: 100, // 1% max slippage
            allowAutoSwap: false, // No auto-swap, custody only
            quarantineMode: true
        });

        // Tier 1: Verified - moderate limits
        tierConfigs[PluginTypes.PluginTier.VERIFIED] = PluginTypes.TierConfig({
            maxConversionAmount: 100000 * 10**18, // 100k tokens
            maxSlippageBps: 300, // 3% max slippage
            allowAutoSwap: true,
            quarantineMode: false
        });

        // Tier 2: Core - full privileges
        tierConfigs[PluginTypes.PluginTier.CORE] = PluginTypes.TierConfig({
            maxConversionAmount: type(uint256).max, // No limit
            maxSlippageBps: 500, // 5% max slippage
            allowAutoSwap: true,
            quarantineMode: false
        });
    }
}
