// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import "../VastitasToken.sol";

/**
 * @title Council
 * @notice Representative council elected by Vastitas token holders
 * @dev Tokenholders vote for council members, council members vote on proposals
 */
contract Council is AccessControl {
    bytes32 public constant GOVERNANCE_ROLE = keccak256("GOVERNANCE_ROLE");

    VastitasToken public immutable token;
    
    // Council member structure
    struct CouncilMember {
        address member;
        uint256 votesReceived; // Total votes received in last election
        uint256 termStartBlock;
        uint256 termEndBlock;
        bool isActive;
    }

    // Current council members (max council size)
    uint256 public constant MAX_COUNCIL_SIZE = 7;
    CouncilMember[] public councilMembers;

    // Election configuration
    uint256 public electionPeriod; // Blocks between elections
    uint256 public termLength; // Blocks per term
    uint256 public electionDuration; // Blocks for election duration
    uint256 public lastElectionBlock;
    uint256 public nextElectionBlock;

    // Candidate registration
    struct Candidate {
        address candidate;
        string name; // Optional identifier
        uint256 votesReceived;
        bool isRegistered;
    }

    mapping(address => Candidate) public candidates;
    address[] public candidateList;

    // Voting for candidates
    mapping(uint256 => mapping(address => address)) public votes; // electionId => voter => candidate
    mapping(uint256 => mapping(address => uint256)) public voteWeights; // electionId => voter => weight
    uint256 public currentElectionId;
    uint256 public electionStartBlock;

    // Events
    event CandidateRegistered(address indexed candidate, string name);
    event VoteCast(address indexed voter, address indexed candidate, uint256 weight);
    event ElectionStarted(uint256 indexed electionId, uint256 startBlock, uint256 endBlock);
    event ElectionEnded(uint256 indexed electionId, address[] electedMembers);
    event CouncilMemberAdded(address indexed member, uint256 termStart, uint256 termEnd);
    event CouncilMemberRemoved(address indexed member);

    /**
     * @notice Constructor
     * @param _token VastitasToken address
     * @param _electionPeriod Blocks between elections
     * @param _termLength Blocks per council term
     * @param governance Governance contract address (for role management)
     */
    constructor(
        address _token,
        uint256 _electionPeriod,
        uint256 _termLength,
        address governance
    ) {
        require(_token != address(0), "Council: zero token");
        require(_electionPeriod > 0, "Council: zero election period");
        require(_termLength > 0, "Council: zero term length");

        token = VastitasToken(_token);
        electionPeriod = _electionPeriod;
        termLength = _termLength;
        electionDuration = 7 * 24 * 60 * 60 / 15; // 7 days in blocks (assuming 15s blocks)
        lastElectionBlock = block.number;
        nextElectionBlock = block.number + _electionPeriod;

        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        if (governance != address(0)) {
            _grantRole(GOVERNANCE_ROLE, governance);
        }
    }

    /**
     * @notice Register as a candidate for council
     * @param name Optional name/identifier
     */
    function registerCandidate(string memory name) external {
        require(!candidates[msg.sender].isRegistered, "Council: already registered");
        require(bytes(name).length > 0, "Council: name required");

        candidates[msg.sender] = Candidate({
            candidate: msg.sender,
            name: name,
            votesReceived: 0,
            isRegistered: true
        });

        candidateList.push(msg.sender);
        emit CandidateRegistered(msg.sender, name);
    }

    /**
     * @notice Start a new election
     * @dev Can be called by anyone when election period has passed
     */
    function startElection() external {
        require(block.number >= nextElectionBlock, "Council: election not due");
        
        currentElectionId++;
        electionStartBlock = block.number;
        nextElectionBlock = block.number + electionPeriod;

        // Reset candidate votes
        for (uint256 i = 0; i < candidateList.length; i++) {
            candidates[candidateList[i]].votesReceived = 0;
        }

        emit ElectionStarted(currentElectionId, block.number, block.number + electionDuration);
    }

    /**
     * @notice Vote for a candidate in current election
     * @param candidate Candidate address to vote for
     */
    function voteForCandidate(address candidate) external {
        require(candidates[candidate].isRegistered, "Council: candidate not registered");
        require(block.number >= electionStartBlock, "Council: election not started");
        require(block.number < electionStartBlock + electionDuration, "Council: election ended");

        // Get voting power at election start block
        uint256 votingPower = token.getPastVotes(msg.sender, electionStartBlock);
        require(votingPower > 0, "Council: no voting power");

        // Remove previous vote if any
        address previousVote = votes[currentElectionId][msg.sender];
        if (previousVote != address(0)) {
            uint256 previousWeight = voteWeights[currentElectionId][msg.sender];
            candidates[previousVote].votesReceived -= previousWeight;
        }

        // Cast new vote
        votes[currentElectionId][msg.sender] = candidate;
        voteWeights[currentElectionId][msg.sender] = votingPower;
        candidates[candidate].votesReceived += votingPower;

        emit VoteCast(msg.sender, candidate, votingPower);
    }

    /**
     * @notice End election and elect council members
     * @dev Can be called by anyone after election voting period
     */
    function endElection() external {
        require(block.number >= electionStartBlock + electionDuration, "Council: election not ended");

        // Sort candidates by votes (simple selection, in production use better algorithm)
        address[] memory sortedCandidates = new address[](candidateList.length);
        uint256[] memory sortedVotes = new uint256[](candidateList.length);
        
        for (uint256 i = 0; i < candidateList.length; i++) {
            sortedCandidates[i] = candidateList[i];
            sortedVotes[i] = candidates[candidateList[i]].votesReceived;
        }

        // Simple bubble sort (for small candidate lists)
        for (uint256 i = 0; i < sortedCandidates.length; i++) {
            for (uint256 j = 0; j < sortedCandidates.length - i - 1; j++) {
                if (sortedVotes[j] < sortedVotes[j + 1]) {
                    (sortedCandidates[j], sortedCandidates[j + 1]) = (sortedCandidates[j + 1], sortedCandidates[j]);
                    (sortedVotes[j], sortedVotes[j + 1]) = (sortedVotes[j + 1], sortedVotes[j]);
                }
            }
        }

        // Clear current council
        for (uint256 i = 0; i < councilMembers.length; i++) {
            councilMembers[i].isActive = false;
            emit CouncilMemberRemoved(councilMembers[i].member);
        }
        delete councilMembers;

        // Elect top candidates up to MAX_COUNCIL_SIZE
        uint256 electedCount = sortedCandidates.length < MAX_COUNCIL_SIZE 
            ? sortedCandidates.length 
            : MAX_COUNCIL_SIZE;
        
        address[] memory elected = new address[](electedCount);
        uint256 termStart = block.number;
        uint256 termEnd = block.number + termLength;

        for (uint256 i = 0; i < electedCount && sortedVotes[i] > 0; i++) {
            address member = sortedCandidates[i];
            councilMembers.push(CouncilMember({
                member: member,
                votesReceived: sortedVotes[i],
                termStartBlock: termStart,
                termEndBlock: termEnd,
                isActive: true
            }));
            elected[i] = member;
            emit CouncilMemberAdded(member, termStart, termEnd);
        }

        lastElectionBlock = block.number;
        emit ElectionEnded(currentElectionId, elected);
    }

    /**
     * @notice Get current council members
     * @return members Array of active council member addresses
     */
    function getCouncilMembers() external view returns (address[] memory) {
        address[] memory members = new address[](councilMembers.length);
        uint256 count = 0;
        for (uint256 i = 0; i < councilMembers.length; i++) {
            if (councilMembers[i].isActive && block.number < councilMembers[i].termEndBlock) {
                members[count] = councilMembers[i].member;
                count++;
            }
        }
        
        // Resize array
        address[] memory result = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            result[i] = members[i];
        }
        return result;
    }

    /**
     * @notice Check if address is a council member
     * @param member Address to check
     * @return isMember True if member is active council member
     */
    function isCouncilMember(address member) external view returns (bool) {
        for (uint256 i = 0; i < councilMembers.length; i++) {
            if (councilMembers[i].member == member && 
                councilMembers[i].isActive && 
                block.number < councilMembers[i].termEndBlock) {
                return true;
            }
        }
        return false;
    }

    /**
     * @notice Get voting power of a council member (votes received in election)
     * @param member Council member address
     * @return votingPower Voting power (votes received in last election)
     */
    function getCouncilMemberVotingPower(address member) external view returns (uint256) {
        for (uint256 i = 0; i < councilMembers.length; i++) {
            if (councilMembers[i].member == member && 
                councilMembers[i].isActive && 
                block.number < councilMembers[i].termEndBlock) {
                return councilMembers[i].votesReceived;
            }
        }
        return 0;
    }

    /**
     * @notice Get candidate information
     * @param candidate Candidate address
     * @return name Candidate name
     * @return votesReceived Votes received in current election
     * @return isRegistered Whether candidate is registered
     */
    function getCandidate(address candidate) external view returns (
        string memory name,
        uint256 votesReceived,
        bool isRegistered
    ) {
        Candidate memory c = candidates[candidate];
        return (c.name, c.votesReceived, c.isRegistered);
    }

    /**
     * @notice Get all registered candidates
     * @return candidatesList Array of candidate addresses
     */
    function getAllCandidates() external view returns (address[] memory) {
        return candidateList;
    }

    /**
     * @notice Update election period (governance only)
     * @param newPeriod New election period in blocks
     */
    function setElectionPeriod(uint256 newPeriod) external onlyRole(GOVERNANCE_ROLE) {
        require(newPeriod > 0, "Council: zero period");
        electionPeriod = newPeriod;
    }

    /**
     * @notice Update term length (governance only)
     * @param newLength New term length in blocks
     */
    function setTermLength(uint256 newLength) external onlyRole(GOVERNANCE_ROLE) {
        require(newLength > 0, "Council: zero length");
        termLength = newLength;
    }
}
