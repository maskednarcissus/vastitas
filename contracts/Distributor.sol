// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title Distributor
 * @notice Staking rewards distributor with epoch-based accounting
 * @dev Optional component for Distribution Model 2 (Staking Rewards)
 */
contract Distributor is AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant ROUTER_ROLE = keccak256("ROUTER_ROLE"); // RevenueRouter can send rewards

    // Epoch configuration
    uint256 public epochDuration; // Duration of each epoch in seconds
    uint256 public currentEpoch;
    uint256 public epochStartTime;

    // Staking
    struct Checkpoint {
        uint32 epoch;
        uint224 stake;
    }

    mapping(address => Checkpoint[]) private userCheckpoints;
    Checkpoint[] private totalCheckpoints;
    mapping(address => uint256) private currentStaked;
    uint256 private totalStaked;
    mapping(uint256 => uint256) private epochRewards; // epoch => total rewards
    mapping(address => mapping(uint256 => bool)) private claimedEpochs; // user => epoch => claimed

    IERC20 public immutable rewardToken; // Treasury asset (USDC, WETH, etc.)
    IERC20 public immutable stakeToken; // Vastitas token

    // Events
    event Staked(address indexed user, uint256 amount);
    event Unstaked(address indexed user, uint256 amount);
    event RewardsDistributed(uint256 indexed epoch, uint256 amount);
    event RewardsClaimed(address indexed user, uint256 indexed epoch, uint256 amount);
    event EpochAdvanced(uint256 oldEpoch, uint256 newEpoch);

    /**
     * @notice Constructor
     * @param _stakeToken Vastitas token address
     * @param _rewardToken Reward token address (treasury asset)
     * @param _epochDuration Epoch duration in seconds
     * @param admin Address with admin role
     * @param router Address with router role (RevenueRouter)
     */
    constructor(
        address _stakeToken,
        address _rewardToken,
        uint256 _epochDuration,
        address admin,
        address router
    ) {
        require(_stakeToken != address(0), "Distributor: zero stake token");
        require(_rewardToken != address(0), "Distributor: zero reward token");
        require(_epochDuration > 0, "Distributor: zero epoch duration");

        stakeToken = IERC20(_stakeToken);
        rewardToken = IERC20(_rewardToken);
        epochDuration = _epochDuration;
        currentEpoch = 1;
        epochStartTime = block.timestamp;
        totalCheckpoints.push(Checkpoint({epoch: 1, stake: 0}));

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        if (router != address(0)) {
            _grantRole(ROUTER_ROLE, router);
        }
    }

    /**
     * @notice Stake Vastitas tokens
     * @param amount Amount to stake
     */
    function stake(uint256 amount) external {
        require(amount > 0, "Distributor: zero amount");
        
        _advanceEpochIfNeeded();
        
        stakeToken.safeTransferFrom(msg.sender, address(this), amount);
        currentStaked[msg.sender] += amount;
        totalStaked += amount;

        _writeCheckpoint(
            userCheckpoints[msg.sender],
            currentEpoch + 1,
            currentStaked[msg.sender]
        );
        _writeCheckpoint(totalCheckpoints, currentEpoch + 1, totalStaked);

        emit Staked(msg.sender, amount);
    }

    /**
     * @notice Unstake Vastitas tokens
     * @param amount Amount to unstake
     */
    function unstake(uint256 amount) external {
        require(amount > 0, "Distributor: zero amount");
        require(currentStaked[msg.sender] >= amount, "Distributor: insufficient stake");

        _advanceEpochIfNeeded();

        currentStaked[msg.sender] -= amount;
        totalStaked -= amount;

        _writeCheckpoint(
            userCheckpoints[msg.sender],
            currentEpoch + 1,
            currentStaked[msg.sender]
        );
        _writeCheckpoint(totalCheckpoints, currentEpoch + 1, totalStaked);

        stakeToken.safeTransfer(msg.sender, amount);

        emit Unstaked(msg.sender, amount);
    }

    /**
     * @notice Distribute rewards for current epoch (router only)
     * @param amount Amount of rewards to distribute
     */
    function distributeRewards(uint256 amount) external onlyRole(ROUTER_ROLE) {
        require(amount > 0, "Distributor: zero amount");
        
        _advanceEpochIfNeeded();

        rewardToken.safeTransferFrom(msg.sender, address(this), amount);
        epochRewards[currentEpoch] += amount;

        emit RewardsDistributed(currentEpoch, amount);
    }

    /**
     * @notice Claim rewards for a specific epoch
     * @param epoch Epoch to claim rewards for
     */
    function claimRewards(uint256 epoch) external {
        require(epoch < currentEpoch, "Distributor: epoch not finalized");
        require(!claimedEpochs[msg.sender][epoch], "Distributor: already claimed");
        require(_getStakeAtEpoch(msg.sender, epoch) > 0, "Distributor: no stake");

        uint256 userReward = _calculateReward(msg.sender, epoch);
        require(userReward > 0, "Distributor: no rewards");

        claimedEpochs[msg.sender][epoch] = true;
        rewardToken.safeTransfer(msg.sender, userReward);

        emit RewardsClaimed(msg.sender, epoch, userReward);
    }

    /**
     * @notice Get staked amount for a user
     * @param user User address
     * @return amount Staked amount
     */
    function getStakedAmount(address user) external view returns (uint256) {
        return currentStaked[user];
    }

    /**
     * @notice Get total staked
     * @return total Total staked amount
     */
    function getTotalStaked() external view returns (uint256) {
        return totalStaked;
    }

    /**
     * @notice Get rewards for an epoch
     * @param epoch Epoch number
     * @return rewards Total rewards for epoch
     */
    function getEpochRewards(uint256 epoch) external view returns (uint256) {
        return epochRewards[epoch];
    }

    /**
     * @notice Calculate reward for a user in an epoch
     * @param user User address
     * @param epoch Epoch number
     * @return reward User's reward amount
     */
    function _calculateReward(address user, uint256 epoch) private view returns (uint256) {
        uint256 totalForEpoch = _getTotalStakeAtEpoch(epoch);
        if (totalForEpoch == 0 || epochRewards[epoch] == 0) {
            return 0;
        }

        // Pro-rata distribution based on stake at epoch start
        uint256 userStake = _getStakeAtEpoch(user, epoch);
        return (epochRewards[epoch] * userStake) / totalForEpoch;
    }

    /**
     * @notice Advance epoch if duration has passed
     */
    function _advanceEpochIfNeeded() private {
        if (block.timestamp >= epochStartTime + epochDuration) {
            uint256 epochsToAdvance = (block.timestamp - epochStartTime) / epochDuration;
            uint256 oldEpoch = currentEpoch;
            currentEpoch += epochsToAdvance;
            epochStartTime += epochsToAdvance * epochDuration;
            
            emit EpochAdvanced(oldEpoch, currentEpoch);
        }
    }

    function _writeCheckpoint(
        Checkpoint[] storage checkpoints,
        uint256 epoch,
        uint256 stakeAmount
    ) private {
        if (checkpoints.length > 0 && checkpoints[checkpoints.length - 1].epoch == epoch) {
            checkpoints[checkpoints.length - 1].stake = uint224(stakeAmount);
        } else {
            checkpoints.push(Checkpoint({epoch: uint32(epoch), stake: uint224(stakeAmount)}));
        }
    }

    function _getStakeAtEpoch(address user, uint256 epoch) private view returns (uint256) {
        return _getCheckpointValue(userCheckpoints[user], epoch);
    }

    function _getTotalStakeAtEpoch(uint256 epoch) private view returns (uint256) {
        return _getCheckpointValue(totalCheckpoints, epoch);
    }

    function _getCheckpointValue(Checkpoint[] storage checkpoints, uint256 epoch)
        private
        view
        returns (uint256)
    {
        uint256 len = checkpoints.length;
        if (len == 0) {
            return 0;
        }
        if (epoch < checkpoints[0].epoch) {
            return 0;
        }
        uint256 low = 0;
        uint256 high = len;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (checkpoints[mid].epoch > epoch) {
                high = mid;
            } else {
                low = mid + 1;
            }
        }
        return checkpoints[low - 1].stake;
    }

    /**
     * @notice Update epoch duration (admin only)
     * @param newDuration New epoch duration in seconds
     */
    function setEpochDuration(uint256 newDuration) external onlyRole(ADMIN_ROLE) {
        require(newDuration > 0, "Distributor: zero duration");
        epochDuration = newDuration;
    }
}
