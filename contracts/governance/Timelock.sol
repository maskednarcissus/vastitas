// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/governance/TimelockController.sol";

/**
 * @title Timelock
 * @notice Timelock controller for Vastitas governance
 * @dev Manages delays for different proposal types
 */
contract Timelock is TimelockController {
    // Delay tiers
    uint256 public constant STANDARD_DELAY = 2 days;      // 48 hours for standard changes
    uint256 public constant HIGH_IMPACT_DELAY = 7 days;  // 7 days for upgrades, fee changes, tier-2 promotions

    /**
     * @notice Constructor
     * @param minDelay Minimum delay (will be set to STANDARD_DELAY)
     * @param proposers Array of addresses that can propose
     * @param executors Array of addresses that can execute
     * @param admin Admin address (can be zero for no admin)
     */
    constructor(
        uint256 minDelay,
        address[] memory proposers,
        address[] memory executors,
        address admin
    ) TimelockController(minDelay, proposers, executors, admin) {
        // minDelay should be set to STANDARD_DELAY
        require(minDelay >= STANDARD_DELAY, "Timelock: delay too short");
    }

    /**
     * @notice Get delay for a proposal type
     * @param proposalType Proposal type (0 = standard, 1 = high-impact)
     * @return delay Delay in seconds
     */
    function getDelayForProposalType(uint8 proposalType) external pure returns (uint256) {
        if (proposalType == 0) {
            return STANDARD_DELAY;
        } else if (proposalType == 1) {
            return HIGH_IMPACT_DELAY;
        }
        revert("Timelock: invalid proposal type");
    }
}
