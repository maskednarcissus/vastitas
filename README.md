# Vastitas Yield Rails Protocol

Permissionless plugin-based yield routing protocol. All yield flows through a single canonical router for unified accounting and distribution.

## Overview

Vastitas enables permissionless plugin registration with tiered trust levels. All yield must flow through the RevenueRouter, which normalizes assets, tracks yield per plugin, and executes distribution policy.

## Core Contracts

### VastitasToken
Minimal ERC-20 token with voting support. Contains no business logic.

**Key Functions:**
- Standard ERC-20 functions: `transfer()`, `approve()`, `balanceOf()`
- Voting functions: `delegate()`, `getVotes()`, `getPastVotes()`
- Permit functions: `permit()`, `nonces()`

### PluginRegistry
Manages plugin registration and tier assignments.

**Key Functions:**
- `registerPlugin(bytes32 pluginId, address pluginAddress, address[] calldata underlyingAssets, address routeTo)` - Register a new plugin (permissionless)
- `setPluginTier(bytes32 pluginId, PluginTier tier)` - Set plugin tier (governance only)
- `getPlugin(bytes32 pluginId)` - Get plugin metadata
- `getTierConfig(PluginTier tier)` - Get tier configuration

### RevenueRouter
Central yield routing contract. All yield must flow through here.

**Key Functions:**
- `receiveYield(bytes32 pluginId, address asset, uint256 amount, DevShareMetadata calldata devShare)` - Receive yield from plugin
- `applyPolicy()` - Execute distribution policy on accumulated yield
- `getPluginYield(bytes32 pluginId)` - Get total yield from a plugin
- `getTotalYield()` - Get total yield from all plugins
- `getAccumulatedYield()` - Get yield waiting for distribution

### SwapModule
Converts yield assets to treasury asset.

**Key Functions:**
- `convert(address fromAsset, uint256 amount, PluginTier tier, uint256 maxSlippageBps)` - Convert asset to treasury asset
- `getTreasuryAsset()` - Get treasury asset address
- `isRouteWhitelisted(address fromAsset, address toAsset)` - Check if swap route is whitelisted

### TreasuryVault
Custody contract for treasury assets.

**Key Functions:**
- `deposit(address token, uint256 amount)` - Deposit tokens to treasury
- `withdraw(address token, address to, uint256 amount)` - Withdraw tokens (TREASURER_ROLE required)
- `getBalance(address token)` - Get token balance

### Governance
On-chain governance contract for protocol decisions.

**Key Functions:**
- `propose(address[] memory targets, uint256[] memory values, bytes[] memory calldatas, string memory description)` - Create a proposal
- `proposeWithType(..., ProposalType proposalType)` - Create typed proposal
- `castVote(uint256 proposalId, uint8 support)` - Vote on proposal (1=For, 0=Against, 2=Abstain)
- `state(uint256 proposalId)` - Get proposal state

## Mainnet Addresses

Mainnet contract addresses are stored in `deployments/mainnet.json` in this repository. The deployment script automatically saves addresses after deployment.

**Fetch addresses:**
```bash
# From GitHub
curl https://raw.githubusercontent.com/maskednarcissus/yield-token/main/deployments/mainnet.json

# Or view on GitHub
https://github.com/maskednarcissus/yield-token/blob/main/deployments/mainnet.json
```

**Contract addresses structure:**
```json
{
  "network": "mainnet",
  "deployedAt": "2024-01-01T00:00:00.000Z",
  "contracts": {
    "token": "0x...",
    "treasury": "0x...",
    "registry": "0x...",
    "swapModule": "0x...",
    "router": "0x...",
    "distributor": "0x...",
    "timelock": "0x...",
    "council": "0x...",
    "governance": "0x...",
    "emergencyCouncil": "0x..."
  }
}
```

**Main contracts:**
- VastitasToken: ERC-20 token with voting
- PluginRegistry: Plugin registration and tier management
- RevenueRouter: Central yield routing
- SwapModule: Asset conversion
- TreasuryVault: Treasury custody
- Governance: On-chain governance
- Timelock: Proposal execution delay
- Council: Representative council
- EmergencyCouncil: Emergency response

## On-Chain Usage

### For Plugin Developers

**1. Register Your Plugin:**
```solidity
pluginRegistry.registerPlugin(
    pluginId,              // Unique bytes32 identifier
    pluginAddress,         // Your plugin contract address
    underlyingAssets,      // Array of ERC-20 tokens your plugin can receive
    revenueRouterAddress  // RevenueRouter address
);
```

**2. Route Yield:**
```solidity
// In your plugin's claimAndRoute() function
IERC20(yieldAsset).approve(revenueRouter, amount);

revenueRouter.receiveYield(
    pluginId,
    yieldAsset,           // Asset address
    amount,              // Yield amount
    DevShareMetadata({
        devRecipient: devAddress,  // Your address (or zero address)
        devBps: 500              // 5% dev share (max 2000 = 20%)
    })
);
```

**3. Check Plugin Status:**
```solidity
PluginMetadata memory plugin = pluginRegistry.getPlugin(pluginId);
bool isActive = plugin.isActive;
PluginTier tier = plugin.tier;
```

### For Token Holders

**1. Check Yield Metrics:**
```solidity
uint256 totalYield = revenueRouter.getTotalYield();
uint256 pluginYield = revenueRouter.getPluginYield(pluginId);
uint256 accumulated = revenueRouter.getAccumulatedYield();
```

**2. Participate in Governance:**
```solidity
// Delegate voting power
vastitasToken.delegate(delegateAddress);

// Create proposal (requires proposalThreshold tokens)
uint256 proposalId = governance.propose(
    targets,    // Contract addresses to call
    values,     // ETH values
    calldatas,  // Function call data
    description // Proposal description
);

// Vote on proposal
governance.castVote(proposalId, 1); // 1=For, 0=Against, 2=Abstain
```

**3. Check Voting Power:**
```solidity
uint256 votes = vastitasToken.getVotes(account);
uint256 pastVotes = vastitasToken.getPastVotes(account, blockNumber);
```

### For Governance Participants

**1. Create Treasury Proposal:**
```solidity
address[] memory targets = new address[](1);
targets[0] = treasuryVault;

uint256[] memory values = new uint256[](1);
values[0] = 0;

bytes[] memory calldatas = new bytes[](1);
calldatas[0] = abi.encodeWithSelector(
    TreasuryVault.withdraw.selector,
    tokenAddress,
    recipientAddress,
    amount
);

governance.proposeWithType(
    targets,
    values,
    calldatas,
    "Treasury withdrawal proposal",
    ProposalType.TREASURY
);
```

**2. Update Distribution Splits:**
```solidity
// Proposal to change distribution
calldatas[0] = abi.encodeWithSelector(
    RevenueRouter.setDistributionSplits.selector,
    buybackShareBps,    // e.g., 7000 (70%)
    stakerShareBps,     // e.g., 2000 (20%)
    treasuryShareBps    // e.g., 1000 (10%, max 3000)
);

governance.proposeWithType(
    targets,
    values,
    calldatas,
    "Update distribution splits",
    ProposalType.ROUTER_PARAM
);
```

**3. Promote Plugin Tier:**
```solidity
calldatas[0] = abi.encodeWithSelector(
    PluginRegistry.setPluginTier.selector,
    pluginId,
    PluginTier.VERIFIED  // or PluginTier.CORE
);

governance.proposeWithType(
    targets,
    values,
    calldatas,
    "Promote plugin to Verified tier",
    ProposalType.REGISTRY
);
```

### For Treasury Managers

**1. Withdraw Treasury Funds:**
```solidity
// Requires TREASURER_ROLE
treasuryVault.withdraw(
    tokenAddress,      // ERC-20 token address
    recipientAddress, // Where to send funds
    amount           // Amount to withdraw
);
```

**2. Check Treasury Balance:**
```solidity
uint256 balance = treasuryVault.getBalance(tokenAddress);
```

## Plugin Interface

All plugins must implement the `IPlugin` interface:

```solidity
interface IPlugin {
    function pluginId() external view returns (bytes32);
    function underlyingAssets() external view returns (address[] memory);
    function quoteClaimable() external view returns (address asset, uint256 amount);
    function claimAndRoute() external;
    function routeTo() external view returns (address);
}
```

## Tier System

**Untrusted (Tier 0):**
- Permissionless registration
- Strict execution caps
- Limited swap routes
- May require quarantine mode

**Verified (Tier 1):**
- Governance approval required
- Higher execution caps
- More swap routes available
- Auto-swap enabled

**Core (Tier 2):**
- Highest trust level
- Maximum execution caps
- All swap routes available
- Priority routing

## Distribution Policy

Distribution splits are configurable via governance:
- **Buyback Share**: Percentage for buyback & burn
- **Staker Share**: Percentage for staking rewards
- **Treasury Share**: Percentage for treasury (max 30%)

Call `applyPolicy()` to execute distribution on accumulated yield.

## Constraints

**Immutable Constraints:**
- Maximum treasury share: 30% (3000 bps)

**Governance Constraints:**
- Treasury proposals: 5% quorum, 50% threshold, 2-day delay
- Router parameter proposals: 7% quorum, 60% threshold, 7-day delay
- Upgrade proposals: 10% quorum, 66% threshold, 7-day delay
