// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IDistributor
 * @notice Interface for staking rewards distributor
 */
interface IDistributor {
    /**
     * @notice Distribute rewards for current epoch
     * @param amount Amount of rewards to distribute
     */
    function distributeRewards(uint256 amount) external;
}

