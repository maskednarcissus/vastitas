// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IRevenueRouter.sol";
import "./interfaces/ISwapModule.sol";
import "./interfaces/IPlugin.sol";
import "./interfaces/IDistributor.sol";
import "./PluginRegistry.sol";
import "./VastitasToken.sol";
import "./types/PluginTypes.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/**
 * @title RevenueRouter
 * @notice Central yield routing contract - all yield must go through here
 * @dev Enforces accounting, whitelist policies, and distribution logic
 * @dev Plugins never send directly to Vastitas token - they send here
 */
contract RevenueRouter is IRevenueRouter, AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    PluginRegistry public immutable pluginRegistry;
    ISwapModule public immutable swapModule;
    VastitasToken public immutable vastitasToken;
    address public immutable treasuryVault;
    address public distributor; // Optional Distributor for staking rewards

    // Distribution model
    PluginTypes.DistributionModel public distributionModel;

    // Immutable constraints (Layer A - hardcoded caps)
    uint256 public constant MAX_DEV_SHARE_BPS = 2000; // 20% maximum dev share
    uint256 public constant MAX_GOVERNANCE_REDIRECT_BPS = 3000; // 30% maximum governance redirect
    uint256 public constant MIN_STAKER_SHARE_BPS = 0; // Can be 0, but requires long delay + supermajority to change

    // Accounting: pluginId => total yield received (in treasury asset terms)
    mapping(bytes32 => uint256) private pluginYield;
    // Quarantined yield: pluginId => asset => amount
    mapping(bytes32 => mapping(address => uint256)) private quarantinedYield;

    // Global accounting
    uint256 private totalYieldReceived;

    // Accumulated yield waiting for distribution (in treasury asset)
    uint256 private accumulatedYield;

    // Dev share accounting: devRecipient => total received
    mapping(address => uint256) private devShareReceived;

    // Events
    event YieldReceived(
        bytes32 indexed pluginId,
        address indexed asset,
        uint256 amount,
        address indexed devRecipient,
        uint256 devShare
    );

    event YieldConverted(
        bytes32 indexed pluginId,
        address indexed inAsset,
        address indexed outAsset,
        uint256 inAmount,
        uint256 outAmount
    );

    event YieldApplied(
        PluginTypes.DistributionModel indexed model,
        uint256 amount,
        address indexed recipient
    );

    event YieldQuarantined(
        bytes32 indexed pluginId,
        address indexed asset,
        uint256 amount
    );

    event QuarantinedYieldReleased(
        bytes32 indexed pluginId,
        address indexed asset,
        uint256 amount,
        uint256 normalizedAmount
    );

    event QuarantinedYieldSwept(
        bytes32 indexed pluginId,
        address indexed asset,
        uint256 amount,
        address indexed recipient
    );

    event DistributorUpdated(address indexed oldDistributor, address indexed newDistributor);

    event DistributionModelUpdated(PluginTypes.DistributionModel oldModel, PluginTypes.DistributionModel newModel);

    // Distribution splits (basis points)
    uint256 public buybackShareBps = 10000; // 100% to buyback by default
    uint256 public stakerShareBps = 0;
    uint256 public treasuryShareBps = 0;

    // Timelock for critical changes
    address public timelock;

    // Events
    event DistributionSplitsUpdated(
        uint256 buybackShareBps,
        uint256 stakerShareBps,
        uint256 treasuryShareBps
    );

    /**
     * @notice Constructor
     * @param _pluginRegistry Address of PluginRegistry
     * @param _swapModule Address of SwapModule
     * @param _vastitasToken Address of VastitasToken
     * @param _treasuryVault Address of treasury vault
     * @param _distributionModel Initial distribution model
     * @param admin Address with admin role
     * @param governance Address with governance role
     */
    constructor(
        address _pluginRegistry,
        address _swapModule,
        address _vastitasToken,
        address _treasuryVault,
        PluginTypes.DistributionModel _distributionModel,
        address admin,
        address governance
    ) {
        require(_pluginRegistry != address(0), "RevenueRouter: zero registry");
        require(_swapModule != address(0), "RevenueRouter: zero swap module");
        require(_vastitasToken != address(0), "RevenueRouter: zero token");
        require(_treasuryVault != address(0), "RevenueRouter: zero treasury");

        pluginRegistry = PluginRegistry(_pluginRegistry);
        swapModule = ISwapModule(_swapModule);
        vastitasToken = VastitasToken(_vastitasToken);
        treasuryVault = _treasuryVault;
        distributionModel = _distributionModel;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(GOVERNANCE_ROLE, governance);
    }

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
    ) external override nonReentrant whenNotPaused {
        require(asset != address(0), "RevenueRouter: zero asset");
        require(amount > 0, "RevenueRouter: zero amount");

        // Verify plugin is registered and active
        PluginTypes.PluginMetadata memory plugin = pluginRegistry.getPlugin(pluginId);
        require(plugin.pluginAddress != address(0), "RevenueRouter: plugin not found");
        require(plugin.isActive, "RevenueRouter: plugin inactive");
        require(msg.sender == plugin.pluginAddress, "RevenueRouter: unauthorized plugin");

        // Verify asset is in plugin's underlying assets
        bool assetValid = false;
        for (uint256 i = 0; i < plugin.underlyingAssets.length; i++) {
            if (plugin.underlyingAssets[i] == asset) {
                assetValid = true;
                break;
            }
        }
        require(assetValid, "RevenueRouter: invalid asset for plugin");

        // Transfer asset from plugin
        IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);

        // Calculate dev share
        uint256 devCut = 0;
        uint256 daoCut = amount;
        
        if (devShare.devRecipient != address(0) && devShare.devBps > 0) {
            require(devShare.devBps <= MAX_DEV_SHARE_BPS, "RevenueRouter: dev share exceeds max"); // Enforce immutable cap
            devCut = (amount * devShare.devBps) / 10000;
            daoCut = amount - devCut;

            // Transfer dev share
            if (devCut > 0) {
                IERC20(asset).safeTransfer(devShare.devRecipient, devCut);
                devShareReceived[devShare.devRecipient] += devCut;
            }
        }

        // Determine routing constraints
        PluginTypes.TierConfig memory tierConfig = pluginRegistry.getTierConfig(plugin.tier);
        PluginTypes.PluginCaps memory caps = pluginRegistry.getPluginCaps(pluginId);
        uint256 maxConversionAmount = tierConfig.maxConversionAmount;
        uint256 maxSlippageBps = tierConfig.maxSlippageBps;
        if (caps.enabled) {
            if (caps.maxConversionAmount > 0 && caps.maxConversionAmount < maxConversionAmount) {
                maxConversionAmount = caps.maxConversionAmount;
            }
            if (caps.maxSlippageBps > 0 && caps.maxSlippageBps < maxSlippageBps) {
                maxSlippageBps = caps.maxSlippageBps;
            }
        }

        if (tierConfig.quarantineMode || !tierConfig.allowAutoSwap) {
            quarantinedYield[pluginId][asset] += daoCut;
            emit YieldQuarantined(pluginId, asset, daoCut);
            emit YieldReceived(pluginId, asset, amount, devShare.devRecipient, devCut);
            return;
        }

        // Normalize to treasury asset
        address treasuryAsset = swapModule.getTreasuryAsset();
        uint256 normalizedAmount = daoCut;

        if (asset != treasuryAsset) {
            require(
                maxConversionAmount == 0 || daoCut <= maxConversionAmount,
                "RevenueRouter: conversion amount exceeds cap"
            );

            // Approve swapModule to transfer tokens from router
            IERC20(asset).forceApprove(address(swapModule), daoCut);
            
            // Convert to treasury asset
            (address convertedAsset, uint256 convertedAmount) = swapModule.convert(
                asset,
                daoCut,
                plugin.tier,
                maxSlippageBps
            );
            
            require(convertedAsset == treasuryAsset, "RevenueRouter: conversion failed");
            normalizedAmount = convertedAmount;

            emit YieldConverted(pluginId, asset, treasuryAsset, daoCut, convertedAmount);
        }

        // Update accounting (only normalized treasury asset amounts)
        if (normalizedAmount > 0) {
            pluginYield[pluginId] += normalizedAmount;
            totalYieldReceived += normalizedAmount;
            accumulatedYield += normalizedAmount;
        }

        emit YieldReceived(pluginId, asset, amount, devShare.devRecipient, devCut);
    }

    /**
     * @notice Apply distribution policy to accumulated yield
     * @dev Executes buyback, distribution, or treasury allocation based on configured model
     */
    function applyPolicy() external override nonReentrant {
        require(accumulatedYield > 0, "RevenueRouter: no yield to distribute");

        uint256 yieldToDistribute = accumulatedYield;
        accumulatedYield = 0;

        address treasuryAsset = swapModule.getTreasuryAsset();
        IERC20 treasuryToken = IERC20(treasuryAsset);

        if (distributionModel == PluginTypes.DistributionModel.BUYBACK_ONLY) {
            // BUYBACK_ONLY is deprecated. For holder distribution without buyback,
            // we route to the staking Distributor.
            require(distributor != address(0), "RevenueRouter: distributor not set");
            treasuryToken.forceApprove(distributor, yieldToDistribute);
            IDistributor(distributor).distributeRewards(yieldToDistribute);
            emit YieldApplied(distributionModel, yieldToDistribute, distributor);
            return;
        }

        if (distributionModel == PluginTypes.DistributionModel.STAKING_REWARDS) {
            require(distributor != address(0), "RevenueRouter: distributor not set");
            treasuryToken.forceApprove(distributor, yieldToDistribute);
            IDistributor(distributor).distributeRewards(yieldToDistribute);
            emit YieldApplied(distributionModel, yieldToDistribute, distributor);
            return;
        }

        // HYBRID: Apply distribution splits
        uint256 buybackAmount = (yieldToDistribute * buybackShareBps) / 10000;
        uint256 stakerAmount = (yieldToDistribute * stakerShareBps) / 10000;
        uint256 treasuryAmount = yieldToDistribute - buybackAmount - stakerAmount;

        // Buyback is deprecated. Treat buyback share as additional staker share.
        uint256 extraStakerAmount = buybackAmount;
        stakerAmount += extraStakerAmount;

        // Staking rewards
        if (stakerAmount > 0) {
            require(distributor != address(0), "RevenueRouter: distributor not set");
            treasuryToken.forceApprove(distributor, stakerAmount);
            IDistributor(distributor).distributeRewards(stakerAmount);
            emit YieldApplied(distributionModel, stakerAmount, distributor);
        }

        // Treasury allocation
        if (treasuryAmount > 0) {
            treasuryToken.safeTransfer(treasuryVault, treasuryAmount);
            emit YieldApplied(distributionModel, treasuryAmount, treasuryVault);
        }
    }

    /**
     * @notice Release quarantined yield for a plugin+asset.
     * @dev Converts to treasury asset (if needed) and adds to accumulatedYield so it can be distributed.
     * @param pluginId Plugin identifier
     * @param asset Quarantined asset
     * @param amount Amount to release (0 = release full quarantined balance)
     */
    function releaseQuarantinedYield(
        bytes32 pluginId,
        address asset,
        uint256 amount
    ) external nonReentrant {
        require(
            msg.sender == timelock || hasRole(GOVERNANCE_ROLE, msg.sender),
            "RevenueRouter: unauthorized"
        );
        require(asset != address(0), "RevenueRouter: zero asset");

        uint256 available = quarantinedYield[pluginId][asset];
        require(available > 0, "RevenueRouter: no quarantined yield");
        uint256 toRelease = amount == 0 ? available : amount;
        require(toRelease <= available, "RevenueRouter: insufficient quarantined yield");

        quarantinedYield[pluginId][asset] = available - toRelease;

        address treasuryAsset = swapModule.getTreasuryAsset();
        uint256 normalizedAmount = toRelease;

        if (asset != treasuryAsset) {
            PluginTypes.PluginMetadata memory plugin = pluginRegistry.getPlugin(pluginId);
            require(plugin.pluginAddress != address(0), "RevenueRouter: plugin not found");

            PluginTypes.TierConfig memory tierConfig = pluginRegistry.getTierConfig(plugin.tier);
            PluginTypes.PluginCaps memory caps = pluginRegistry.getPluginCaps(pluginId);
            uint256 maxConversionAmount = tierConfig.maxConversionAmount;
            uint256 maxSlippageBps = tierConfig.maxSlippageBps;
            if (caps.enabled) {
                if (caps.maxConversionAmount > 0 && caps.maxConversionAmount < maxConversionAmount) {
                    maxConversionAmount = caps.maxConversionAmount;
                }
                if (caps.maxSlippageBps > 0 && caps.maxSlippageBps < maxSlippageBps) {
                    maxSlippageBps = caps.maxSlippageBps;
                }
            }

            require(
                maxConversionAmount == 0 || toRelease <= maxConversionAmount,
                "RevenueRouter: conversion amount exceeds cap"
            );

            IERC20(asset).forceApprove(address(swapModule), toRelease);
            (address convertedAsset, uint256 convertedAmount) = swapModule.convert(
                asset,
                toRelease,
                plugin.tier,
                maxSlippageBps
            );
            require(convertedAsset == treasuryAsset, "RevenueRouter: conversion failed");
            normalizedAmount = convertedAmount;
            emit YieldConverted(pluginId, asset, treasuryAsset, toRelease, convertedAmount);
        }

        if (normalizedAmount > 0) {
            pluginYield[pluginId] += normalizedAmount;
            totalYieldReceived += normalizedAmount;
            accumulatedYield += normalizedAmount;
        }

        emit QuarantinedYieldReleased(pluginId, asset, toRelease, normalizedAmount);
    }

    /**
     * @notice Sweep quarantined yield to treasury vault without converting.
     * @dev Intended for incident response / accounting cleanup.
     * @param pluginId Plugin identifier
     * @param asset Quarantined asset
     * @param amount Amount to sweep (0 = sweep full quarantined balance)
     */
    function sweepQuarantinedYieldToTreasury(
        bytes32 pluginId,
        address asset,
        uint256 amount
    ) external nonReentrant {
        require(
            msg.sender == timelock || hasRole(GOVERNANCE_ROLE, msg.sender),
            "RevenueRouter: unauthorized"
        );
        require(asset != address(0), "RevenueRouter: zero asset");

        uint256 available = quarantinedYield[pluginId][asset];
        require(available > 0, "RevenueRouter: no quarantined yield");
        uint256 toSweep = amount == 0 ? available : amount;
        require(toSweep <= available, "RevenueRouter: insufficient quarantined yield");

        quarantinedYield[pluginId][asset] = available - toSweep;
        IERC20(asset).safeTransfer(treasuryVault, toSweep);
        emit QuarantinedYieldSwept(pluginId, asset, toSweep, treasuryVault);
    }

    /**
     * @notice Set timelock address (admin only, can only be set once)
     * @param _timelock Timelock contract address
     */
    function setTimelock(address _timelock) external onlyRole(ADMIN_ROLE) {
        require(_timelock != address(0), "RevenueRouter: zero timelock");
        require(timelock == address(0), "RevenueRouter: timelock already set");
        timelock = _timelock;
    }

    /**
     * @notice Set distributor address (admin only, can only be set once)
     * @param _distributor Distributor contract address
     */
    function setDistributor(address _distributor) external onlyRole(ADMIN_ROLE) {
        require(_distributor != address(0), "RevenueRouter: zero distributor");
        require(distributor == address(0), "RevenueRouter: distributor already set");
        address oldDistributor = distributor;
        distributor = _distributor;
        emit DistributorUpdated(oldDistributor, _distributor);
    }

    /**
     * @notice Update distribution model (governance only, must go through timelock)
     * @param newModel New distribution model
     */
    function setDistributionModel(PluginTypes.DistributionModel newModel) external {
        require(
            msg.sender == timelock || hasRole(GOVERNANCE_ROLE, msg.sender),
            "RevenueRouter: unauthorized"
        );
        PluginTypes.DistributionModel oldModel = distributionModel;
        distributionModel = newModel;
        emit DistributionModelUpdated(oldModel, newModel);
    }

    /**
     * @notice Update distribution splits (governance only, must go through timelock)
     * @param _buybackShareBps Buyback share in basis points
     * @param _stakerShareBps Staker share in basis points
     * @param _treasuryShareBps Treasury share in basis points
     * @dev Enforces immutable constraints:
     *      - Total must equal 10000 (100%)
     *      - Cannot set staker share to 0 if it was > 0 without long delay + supermajority (enforced by governance)
     *      - Governance redirect cannot exceed MAX_GOVERNANCE_REDIRECT_BPS
     */
    function setDistributionSplits(
        uint256 _buybackShareBps,
        uint256 _stakerShareBps,
        uint256 _treasuryShareBps
    ) external {
        require(
            msg.sender == timelock || hasRole(GOVERNANCE_ROLE, msg.sender),
            "RevenueRouter: unauthorized"
        );
        require(
            _buybackShareBps + _stakerShareBps + _treasuryShareBps == 10000,
            "RevenueRouter: splits must sum to 100%"
        );

        // Enforce immutable constraint: cannot set staker share to 0 if it was > 0
        // (This requires long delay + supermajority, which is enforced by governance proposal type)
        if (stakerShareBps > 0 && _stakerShareBps == 0) {
            require(msg.sender == timelock, "RevenueRouter: staker share reduction requires timelock");
        }

        // Enforce governance redirect cap
        require(
            _treasuryShareBps <= MAX_GOVERNANCE_REDIRECT_BPS,
            "RevenueRouter: treasury share exceeds max"
        );

        buybackShareBps = _buybackShareBps;
        stakerShareBps = _stakerShareBps;
        treasuryShareBps = _treasuryShareBps;

        emit DistributionSplitsUpdated(_buybackShareBps, _stakerShareBps, _treasuryShareBps);
    }

    /**
     * @notice Get total yield received from a specific plugin
     * @param pluginId The plugin identifier
     * @return totalYield Total yield received from plugin (in treasury asset terms)
     */
    function getPluginYield(bytes32 pluginId) external view override returns (uint256) {
        return pluginYield[pluginId];
    }

    /**
     * @notice Get total yield received globally
     * @return totalYield Total yield received from all plugins (in treasury asset terms)
     */
    function getTotalYield() external view override returns (uint256) {
        return totalYieldReceived;
    }

    /**
     * @notice Get accumulated yield waiting for distribution
     * @return accumulated Accumulated yield (in treasury asset)
     */
    function getAccumulatedYield() external view returns (uint256) {
        return accumulatedYield;
    }

    /**
     * @notice Get quarantined yield for a plugin and asset
     * @param pluginId The plugin identifier
     * @param asset The asset address
     * @return amount Quarantined amount held in custody
     */
    function getQuarantinedYield(bytes32 pluginId, address asset) external view returns (uint256) {
        return quarantinedYield[pluginId][asset];
    }

    /**
     * @notice Get dev share received by a recipient
     * @param devRecipient Dev recipient address
     * @return totalDevShare Total dev share received
     */
    function getDevShareReceived(address devRecipient) external view returns (uint256) {
        return devShareReceived[devRecipient];
    }

    /**
     * @notice Emergency pause (admin only) - pauses new yield routing
     * @dev Prevents new yield from being received, but does not affect distribution
     */
    function pause() external onlyRole(ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Emergency unpause (admin only)
     * @dev Resumes normal yield routing operations
     */
    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }
}
