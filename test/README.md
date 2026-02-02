# Vastitas Testing Suite

Comprehensive testing suite for Vastitas Yield Rails Protocol, ensuring all invariants hold across randomized scenarios and adversarial conditions.

## Testing Strategy

### Layer A: Pure Unit Tests (Fast)

**Location**: `test/unit/`

**Target**: Single functions, single contract, no heavy scenarios.

**Coverage**:
- `VastitasToken.test.ts`: Token functionality, burn operations, minimalism checks
- `PluginRegistry.test.ts`: Registration, tier management, configuration
- `RevenueRouter.test.ts`: Yield routing, accounting, distribution
- `SwapModule.test.ts`: Asset conversion, tier-based limits, route whitelisting
- `TreasuryVault.test.ts`: Custody, withdrawals, role controls
- `Distributor.test.ts`: Staking, epoch accounting, rewards distribution

**Goal**: Extremely fast feedback (< 5s total), clear failure messages.

**Run**: `npm test -- test/unit`

### Layer B: Integration Tests (Cross-Contract)

**Location**: `test/integration/`

**Target**: Happy path flows across contracts.

**Scenarios**:
- `YieldRouting.test.ts`: Plugin â†’ Router â†’ Distribution flow
- `MultiPlugin.test.ts`: Multiple plugins routing yield
- `DevShare.test.ts`: Dev share splitting and distribution
- `TierEnforcement.test.ts`: Tier-based routing restrictions
- `DistributionModels.test.ts`: Buyback vs Staking vs Hybrid models

**Run**: `npm test -- test/integration`

### Layer C: Property-Based Fuzzing (Foundry)

**Location**: `test/fuzz/`

**Target**: Random yield scenarios and sequences, assert invariants.

**Files**:
- `YieldRoutingProperties.t.sol`: Random yield routing, verify accounting
- `TierProperties.t.sol`: Random tier scenarios, verify restrictions
- `DistributionProperties.t.sol`: Random distribution, verify conservation

**Run**: `npm run test:fuzz`

### Layer D: Adversarial Tests

**Location**: `test/adversarial/`

**Target**: Attack scenarios and edge cases.

**Files**:
- `WashYield.test.ts`: Wash-yield attack prevention
- `SpamPlugins.test.ts`: Spam and DoS resistance
- `DirectTransfer.test.ts`: Direct token transfer prevention
- `SlippageManipulation.test.ts`: Slippage attack scenarios

**Run**: `npm test -- test/adversarial`

## Invariants (Protocol Laws)

1. **Conservation**: `totalYieldReceived >= totalYieldDistributed` (accounting for fees)
2. **No Mint**: Router does not mint tokens; only burns or distributes
3. **Token Minimalism**: Vastitas token has no business logic
4. **Router Centrality**: All yield goes through RevenueRouter
5. **Tier Enforcement**: Tier restrictions are enforced deterministically
6. **Dev Share Correctness**: Dev share calculation is exact
7. **Accounting Accuracy**: Plugin and global accounting match on-chain state

## Running Tests

```bash
# All tests
npm test

# Unit tests only
npm run test:unit

# Integration tests only
npm run test:integration

# Adversarial tests
npm run test:adversarial

# Foundry fuzz tests
npm run test:fuzz

# Coverage
npm run coverage
```
