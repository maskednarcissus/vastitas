// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title PluginTypes
 * @notice Type definitions for Vastitas plugin system
 */
library PluginTypes {
    /**
     * @notice Plugin tier enumeration
     * @dev Tier 0: Untrusted/Experimental, Tier 1: Verified, Tier 2: Core
     */
    enum PluginTier {
        UNTRUSTED,  // Tier 0
        VERIFIED,   // Tier 1
        CORE        // Tier 2
    }

    /**
     * @notice Plugin metadata structure
     */
    struct PluginMetadata {
        bytes32 pluginId;
        address pluginAddress;
        PluginTier tier;
        address[] underlyingAssets;
        address routeTo; // RevenueRouter address
        uint256 registrationBlock;
        bool isActive;
    }

    /**
     * @notice Tier-based routing configuration
     */
    struct TierConfig {
        uint256 maxConversionAmount;      // Max amount per conversion
        uint256 maxSlippageBps;           // Max slippage in basis points
        bool allowAutoSwap;                // Whether auto-swap is allowed
        bool quarantineMode;              // Whether in quarantine (custody only)
    }

    /**
     * @notice Per-plugin caps (optional override to tighten tier limits)
     */
    struct PluginCaps {
        bool enabled;
        uint256 maxConversionAmount; // Max amount per conversion (0 = no extra cap)
        uint256 maxSlippageBps;      // Max slippage in basis points (0 = no extra cap)
    }

    /**
     * @notice Dev share metadata for yield routing
     */
    struct DevShareMetadata {
        address devRecipient;
        uint256 devBps; // Basis points (0-10000, max 20% = 2000)
    }

    /**
     * @notice Yield routing data
     */
    struct YieldRoute {
        bytes32 pluginId;
        address asset;
        uint256 amount;
        DevShareMetadata devShare;
    }

    /**
     * @notice Distribution policy configuration
     */
    enum DistributionModel {
        BUYBACK_ONLY,    // Model 1: Buyback & burn only
        STAKING_REWARDS, // Model 2: Staking rewards
        HYBRID           // Model 3: Hybrid (deferred)
    }
}
