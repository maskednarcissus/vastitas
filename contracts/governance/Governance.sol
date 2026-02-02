// SPDX-License-Identifier: MIT
pragma solidity ^0.8.25;

import "@openzeppelin/contracts/governance/Governor.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorSettings.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorCountingSimple.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorVotesQuorumFraction.sol";
import "@openzeppelin/contracts/governance/extensions/GovernorTimelockControl.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "./Timelock.sol";
import "./Council.sol";
import "./CouncilVotes.sol";
import "../types/PluginTypes.sol";

/**
 * @title Governance
 * @notice Vastitas governance contract with typed proposals
 * @dev Implements tokenholder voting with timelock
 */
contract Governance is
    Governor,
    GovernorSettings,
    GovernorCountingSimple,
    CouncilVotes,
    GovernorVotesQuorumFraction,
    GovernorTimelockControl,
    AccessControl
{
    // Proposal types
    enum ProposalType {
        REGISTRY,      // Plugin tier changes, caps, asset allowlists
        ROUTER_PARAM,  // Fee splits, slippage, route allowlists
        UPGRADE,       // Contract upgrades
        TREASURY       // Treasury spend proposals
    }

    // Proposal type => quorum fraction (basis points)
    mapping(ProposalType => uint256) public proposalTypeQuorum;

    // Proposal type => voting threshold (basis points, e.g., 5000 = 50%)
    mapping(ProposalType => uint256) public proposalTypeThreshold;

    // Proposal type => timelock delay multiplier (1 = standard, 2 = high-impact)
    mapping(ProposalType => uint8) public proposalTypeDelayTier;

    // Council for representative voting (inherited from CouncilVotes)
    // useCouncilVoting is inherited from CouncilVotes

    // Events
    event ProposalCreatedWithType(
        uint256 indexed proposalId,
        ProposalType indexed proposalType,
        address indexed proposer
    );

    event CouncilVotingToggled(bool useCouncil);

    /**
     * @notice Constructor
     * @param token Voting token (Vastitas)
     * @param timelock Timelock contract
     * @param _council Council contract (can be zero address initially)
     * @param initialVotingDelay Initial voting delay in blocks
     * @param initialVotingPeriod Initial voting period in blocks
     * @param initialProposalThreshold Initial proposal threshold
     * @param quorumNumerator Quorum numerator (e.g., 500 = 5%)
     * @param _useCouncilVoting Whether to use council voting (false = direct tokenholder voting)
     */
    constructor(
        ERC20Votes token,
        Timelock timelock,
        Council _council,
        uint48 initialVotingDelay,
        uint48 initialVotingPeriod,
        uint256 initialProposalThreshold,
        uint256 quorumNumerator,
        bool _useCouncilVoting
    )
        Governor("Vastitas Governance")
        GovernorSettings(initialVotingDelay, uint32(initialVotingPeriod), initialProposalThreshold)
        CouncilVotes(token)
        GovernorVotesQuorumFraction(quorumNumerator)
        GovernorTimelockControl(timelock)
    {
        council = _council;
        useCouncilVoting = _useCouncilVoting;
        
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        // Initialize proposal type configurations
        // Registry: 5% quorum, 50% threshold, standard delay
        proposalTypeQuorum[ProposalType.REGISTRY] = 500; // 5%
        proposalTypeThreshold[ProposalType.REGISTRY] = 5000; // 50%
        proposalTypeDelayTier[ProposalType.REGISTRY] = 0; // Standard

        // Router Param: 7% quorum, 60% threshold, high-impact delay
        proposalTypeQuorum[ProposalType.ROUTER_PARAM] = 700; // 7%
        proposalTypeThreshold[ProposalType.ROUTER_PARAM] = 6000; // 60%
        proposalTypeDelayTier[ProposalType.ROUTER_PARAM] = 1; // High-impact

        // Upgrade: 10% quorum, 66% threshold, high-impact delay
        proposalTypeQuorum[ProposalType.UPGRADE] = 1000; // 10%
        proposalTypeThreshold[ProposalType.UPGRADE] = 6600; // 66%
        proposalTypeDelayTier[ProposalType.UPGRADE] = 1; // High-impact

        // Treasury: 5% quorum, 50% threshold, standard delay
        proposalTypeQuorum[ProposalType.TREASURY] = 500; // 5%
        proposalTypeThreshold[ProposalType.TREASURY] = 5000; // 50%
        proposalTypeDelayTier[ProposalType.TREASURY] = 0; // Standard
    }

    /**
     * @notice Create a proposal with a specific type
     * @param targets Target addresses for calls
     * @param values ETH values for calls
     * @param calldatas Calldata for calls
     * @param description Proposal description
     * @param proposalType Type of proposal
     * @return proposalId Proposal ID
     */
    function proposeWithType(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description,
        ProposalType proposalType
    ) public returns (uint256 proposalId) {
        proposalId = propose(targets, values, calldatas, description);
        emit ProposalCreatedWithType(proposalId, proposalType, msg.sender);
    }

    /**
     * @notice Get quorum for a proposal type
     * @param proposalType Proposal type
     * @return quorum Quorum in basis points
     */
    function getQuorumForProposalType(ProposalType proposalType) external view returns (uint256) {
        return proposalTypeQuorum[proposalType];
    }

    /**
     * @notice Get threshold for a proposal type
     * @param proposalType Proposal type
     * @return threshold Threshold in basis points
     */
    function getThresholdForProposalType(ProposalType proposalType) external view returns (uint256) {
        return proposalTypeThreshold[proposalType];
    }

    /**
     * @notice Set council contract (admin only)
     * @param _council Council contract address
     */
    function setCouncil(Council _council) external onlyRole(DEFAULT_ADMIN_ROLE) {
        council = _council;
        _setCouncil(_council);
    }

    /**
     * @notice Toggle between council voting and direct tokenholder voting (admin only)
     * @param _useCouncil Whether to use council voting
     */
    function setUseCouncilVoting(bool _useCouncil) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(address(council) != address(0) || !_useCouncil, "Governance: council not set");
        useCouncilVoting = _useCouncil;
        _setUseCouncilVoting(_useCouncil);
        emit CouncilVotingToggled(_useCouncil);
    }


    /**
     * @notice Override castVote to check council membership
     */
    function castVote(uint256 proposalId, uint8 support) public override returns (uint256) {
        if (useCouncilVoting && address(council) != address(0)) {
            require(council.isCouncilMember(msg.sender), "Governance: not council member");
        }
        return super.castVote(proposalId, support);
    }

    /**
     * @notice Override castVoteWithReason to check council membership
     */
    function castVoteWithReason(
        uint256 proposalId,
        uint8 support,
        string calldata reason
    ) public override returns (uint256) {
        if (useCouncilVoting && address(council) != address(0)) {
            require(council.isCouncilMember(msg.sender), "Governance: not council member");
        }
        return super.castVoteWithReason(proposalId, support, reason);
    }

    // Required overrides
    function votingDelay() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingDelay();
    }

    function votingPeriod() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.votingPeriod();
    }

    function proposalThreshold() public view override(Governor, GovernorSettings) returns (uint256) {
        return super.proposalThreshold();
    }

    function quorum(uint256 blockNumber)
        public
        view
        override(Governor, GovernorVotesQuorumFraction)
        returns (uint256)
    {
        return super.quorum(blockNumber);
    }

    function state(uint256 proposalId)
        public
        view
        override(Governor, GovernorTimelockControl)
        returns (ProposalState)
    {
        return super.state(proposalId);
    }

    function propose(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        string memory description
    ) public override(Governor) returns (uint256) {
        return super.propose(targets, values, calldatas, description);
    }

    function _queueOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint48) {
        return super._queueOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _executeOperations(
        uint256 proposalId,
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) {
        super._executeOperations(proposalId, targets, values, calldatas, descriptionHash);
    }

    function _getVotes(
        address account,
        uint256 blockNumber,
        bytes memory params
    ) internal view override(Governor, GovernorVotes, CouncilVotes) returns (uint256) {
        // Call CouncilVotes._getVotes() which handles both proposer validation and voting
        // This ensures our override logic is used
        return CouncilVotes._getVotes(account, blockNumber, params);
    }

    function proposalNeedsQueuing(uint256 proposalId) 
        public 
        view 
        override(Governor, GovernorTimelockControl) 
        returns (bool) 
    {
        return super.proposalNeedsQueuing(proposalId);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(AccessControl, Governor)
        returns (bool)
    {
        return AccessControl.supportsInterface(interfaceId) || Governor.supportsInterface(interfaceId);
    }

    function _cancel(
        address[] memory targets,
        uint256[] memory values,
        bytes[] memory calldatas,
        bytes32 descriptionHash
    ) internal override(Governor, GovernorTimelockControl) returns (uint256) {
        return super._cancel(targets, values, calldatas, descriptionHash);
    }

    function _executor() internal view override(Governor, GovernorTimelockControl) returns (address) {
        return super._executor();
    }
}
