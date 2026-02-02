/**
 * @title TestConstants
 * @notice Constants for Vastitas testing
 */

export const PluginTier = {
  UNTRUSTED: 0,
  VERIFIED: 1,
  CORE: 2,
} as const;

export const DistributionModel = {
  BUYBACK_ONLY: 0,
  STAKING_REWARDS: 1,
  HYBRID: 2,
} as const;
