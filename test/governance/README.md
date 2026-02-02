# Governance Tests

Comprehensive test suite for Vastitas governance system.

## Test Coverage

### Timelock Tests
- Delay configuration (standard vs high-impact)
- Proposal type delays
- Access control

### Emergency Council Tests
- Council powers (pause swaps, quarantine plugins)
- Council management (add/remove members)
- Access restrictions (non-council cannot act)

### RevenueRouter Constraints Tests
- Immutable constraints (dev share cap, redirect cap)
- Distribution split validation
- Staker share protection (requires timelock to reduce to 0)

## Running Tests

```bash
# All governance tests
npm test -- test/governance

# Specific test file
npm test -- test/governance/Timelock.test.ts
```

## Governance Architecture

### Layer A: Immutable Constraints
- Hardcoded caps in contracts
- Cannot be changed without redeployment

### Layer B: Tokenholder Governance
- Voting via ERC20Votes
- Typed proposals with different thresholds

### Layer C: Timelock
- Standard changes: 48 hours
- High-impact changes: 7 days

### Layer D: Emergency Council
- Limited powers for incident response
- Cannot move treasury or upgrade contracts
