import { expect } from "chai";
import { ethers } from "hardhat";
import { Council, Governance, VastitasToken, Timelock } from "../../typechain-types";

describe("Council - Integration with Governance", function () {
  let council: Council;
  let governance: Governance;
  let token: VastitasToken;
  let timelock: Timelock;

  let deployer: any;
  let admin: any;
  let governanceAccount: any;
  let councilMember1: any;
  let councilMember2: any;
  let voter1: any;
  let voter2: any;

  // Assuming 15 second blocks
  const BLOCKS_PER_DAY = 5760;
  const ELECTION_PERIOD = 30 * BLOCKS_PER_DAY; // 30 days in blocks
  const TERM_LENGTH = 90 * BLOCKS_PER_DAY; // 90 days in blocks

  beforeEach(async function () {
    [deployer, admin, governanceAccount, councilMember1, councilMember2, voter1, voter2] = await ethers.getSigners();

    // Deploy token
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    token = await TokenFactory.deploy(
      "Vastitas",
      "Vastitas",
      ethers.parseEther("1000000000"),
      deployer.address,
      deployer.address
    );
    await token.waitForDeployment();

    // Distribute tokens
    await token.transfer(await voter1.getAddress(), ethers.parseEther("100000"));
    await token.transfer(await voter2.getAddress(), ethers.parseEther("50000"));
    await token.connect(voter1).delegate(await voter1.getAddress());
    await token.connect(voter2).delegate(await voter2.getAddress());

    // Deploy timelock
    const proposers = [await governanceAccount.getAddress()];
    const executors = [await governanceAccount.getAddress()];
    const TimelockFactory = await ethers.getContractFactory("Timelock");
    timelock = await TimelockFactory.deploy(
      2 * 24 * 60 * 60, // 2 days
      proposers,
      executors,
      admin.address
    );
    await timelock.waitForDeployment();

    // Deploy council
    const CouncilFactory = await ethers.getContractFactory("Council");
    council = await CouncilFactory.deploy(
      await token.getAddress(),
      ELECTION_PERIOD,
      TERM_LENGTH,
      ethers.ZeroAddress // Will be set after governance deployment
    );
    await council.waitForDeployment();

    // Deploy governance
    const GovernanceFactory = await ethers.getContractFactory("Governance");
    governance = await GovernanceFactory.deploy(
      token,
      timelock,
      council,
      1, // voting delay
      5760, // voting period
      ethers.parseEther("10000"), // proposal threshold
      50, // quorum (0.5% - must be <= 100 for quorum fraction)
      false // start with direct voting
    );
    await governance.waitForDeployment();

    // Grant DEFAULT_ADMIN_ROLE to admin for setUseCouncilVoting
    await governance.grantRole(
      await governance.DEFAULT_ADMIN_ROLE(),
      admin.address
    );

    // Grant governance role to council
    await council.grantRole(
      await council.GOVERNANCE_ROLE(),
      await governance.getAddress()
    );
  });

  describe("Council Voting Mode", function () {
    beforeEach(async function () {
      // Register candidates and elect them
      await council.connect(councilMember1).registerCandidate("Member 1");
      await council.connect(councilMember2).registerCandidate("Member 2");

      const nextElectionBlock = await council.nextElectionBlock();
      const currentBlock = await ethers.provider.getBlockNumber();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      
      // Helper function to efficiently mine blocks
      async function mineBlocks(count: number): Promise<void> {
        if (count <= 0) return;
        const secondsPerBlock = 15;
        const totalSeconds = count * secondsPerBlock;
        await ethers.provider.send("evm_increaseTime", [totalSeconds]);
        const batchSize = 20000;
        const batches = Math.floor(count / batchSize);
        const remainder = count % batchSize;
        for (let i = 0; i < batches; i++) {
          for (let j = 0; j < batchSize; j++) {
            await ethers.provider.send("evm_mine", []);
          }
        }
        for (let i = 0; i < remainder; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }
      
      await mineBlocks(blocksToMine);
      await council.connect(voter1).startElection();

      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);
      await council.connect(voter1).voteForCandidate(await councilMember1.getAddress());
      await council.connect(voter2).voteForCandidate(await councilMember2.getAddress());

      const electionDuration = await council.electionDuration();
      const electionBlocksToMine = Number(electionDuration) + 1;
      
      // Helper function to efficiently mine blocks (reuse from above)
      async function mineBlocksElection(count: number): Promise<void> {
        if (count <= 0) return;
        const secondsPerBlock = 15;
        const totalSeconds = count * secondsPerBlock;
        await ethers.provider.send("evm_increaseTime", [totalSeconds]);
        const batchSize = 50000;
        const batches = Math.floor(count / batchSize);
        const remainder = count % batchSize;
        for (let i = 0; i < batches; i++) {
          const promises: Promise<any>[] = [];
          for (let j = 0; j < Math.min(batchSize, 1000); j++) {
            promises.push(ethers.provider.send("evm_mine", []));
          }
          await Promise.all(promises);
          for (let j = 1000; j < batchSize; j++) {
            await ethers.provider.send("evm_mine", []);
          }
        }
        for (let i = 0; i < remainder; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }
      
      await mineBlocksElection(electionBlocksToMine);
      await council.connect(voter1).endElection();
      
      // Re-delegate after all block mining to ensure fresh checkpoints for proposal creation
      // Delegate to zero address first to reset, then back to self to create fresh checkpoint
      await token.connect(voter1).delegate(ethers.ZeroAddress);
      await token.connect(voter2).delegate(ethers.ZeroAddress);
      await ethers.provider.send("evm_mine", []);
      await token.connect(voter1).delegate(await voter1.getAddress());
      await token.connect(voter2).delegate(await voter2.getAddress());
      // Mine blocks to create checkpoints (checkpoints are created at end of block where delegation happens)
      // Need to mine at least 1 block after delegation for checkpoint to be available
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);
      
      // Verify checkpoints are created by checking voting power
      const voter1Power = await token.getVotes(await voter1.getAddress());
      const voter2Power = await token.getVotes(await voter2.getAddress());
      if (voter1Power === 0n || voter2Power === 0n) {
        // If still 0, try one more delegation cycle
        await token.connect(voter1).delegate(await voter1.getAddress());
        await token.connect(voter2).delegate(await voter2.getAddress());
        await ethers.provider.send("evm_mine", []);
      }
    });

    it("should allow toggling council voting mode", async function () {
      // Initially direct voting
      expect(await governance.useCouncilVoting()).to.be.false;

      // Toggle to council voting (admin only)
      await governance.connect(admin).setUseCouncilVoting(true);
      expect(await governance.useCouncilVoting()).to.be.true;

      // Toggle back
      await governance.connect(admin).setUseCouncilVoting(false);
      expect(await governance.useCouncilVoting()).to.be.false;
    });

    it("should only allow council members to vote when council voting is enabled", async function () {
      // Enable council voting
      await governance.connect(admin).setUseCouncilVoting(true);

      // Create a proposal
      const targets = [await token.getAddress()];
      const values = [0];
      const calldatas = ["0x"];
      const description = "Test proposal";

      // Ensure delegation is set and checkpoint is created
      // Always re-delegate right before proposing to ensure fresh checkpoint
      // This is necessary after mining many blocks in beforeEach
      
      // Verify voter1 has tokens
      const voter1Balance = await token.balanceOf(await voter1.getAddress());
      expect(voter1Balance).to.be.gt(0, "voter1 must have tokens");
      
      // Verify threshold
      const threshold = await governance.proposalThreshold();
      expect(voter1Balance).to.be.gte(threshold, `voter1 must have enough balance (has ${voter1Balance}, needs ${threshold})`);
      
      // Delegate to zero address first to reset delegation
      await token.connect(voter1).delegate(ethers.ZeroAddress);
      await ethers.provider.send("evm_mine", []);
      
      // Delegate back to self to create fresh checkpoint
      await token.connect(voter1).delegate(await voter1.getAddress());
      // Mine at least one block after delegation for checkpoint to be created
      // Checkpoints are created at the end of the block where delegation happens
      await ethers.provider.send("evm_mine", []);
      
      // Verify delegation is set (required for ERC20Votes)
      const delegates = await token.delegates(await voter1.getAddress());
      expect(delegates).to.equal(await voter1.getAddress(), "voter1 must be delegated to self");
      
      // Verify voting power calculation at the block that will be used for proposer validation
      // Governor uses block.number + votingDelay() for proposer validation
      const currentBlock = await ethers.provider.getBlockNumber();
      const votingDelay = await governance.votingDelay();
      const proposalBlock = currentBlock + Number(votingDelay);
      
      // Test that _getVotes returns balance for proposer validation
      // This should work because blockNumber (proposalBlock) >= currentBlock
      const votesAtProposalBlock = await governance.getVotes(await voter1.getAddress(), proposalBlock);
      expect(votesAtProposalBlock).to.be.gte(threshold, `Votes at proposal block ${proposalBlock} should be >= threshold (got ${votesAtProposalBlock}, need ${threshold})`);
      
      // Create proposal - the contract will use balance when delegation is set
      const proposalId = await governance.connect(voter1).propose.staticCall(targets, values, calldatas, description);
      await governance.connect(voter1).propose(targets, values, calldatas, description);
      
      // Mine 2 blocks to move past voting delay
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      // Council member should be able to vote
      await expect(governance.connect(councilMember1).castVote(proposalId, 1))
        .to.not.be.reverted;

      // Non-council member should not be able to vote
      await expect(governance.connect(voter1).castVote(proposalId, 1))
        .to.be.revertedWith("Governance: not council member");
    });

    it("should allow all tokenholders to vote when council voting is disabled", async function () {
      // Ensure council voting is disabled
      await governance.connect(admin).setUseCouncilVoting(false);

      // Create a proposal
      const targets = [await token.getAddress()];
      const values = [0];
      const calldatas = ["0x"];
      const description = "Test proposal";

      // Ensure voter1 has delegated and voting power is recorded
      // Re-delegate to ensure fresh checkpoints after all block mining
      await token.connect(voter1).delegate(await voter1.getAddress());
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);
      
      // Verify voter1 has enough voting power
      const votingPower = await token.getVotes(await voter1.getAddress());
      const threshold = await governance.proposalThreshold();
      expect(votingPower).to.be.gte(threshold, "voter1 must have enough voting power");
      
      // Create proposal and get the actual proposal ID from return value using staticCall
      const proposalId = await governance.connect(voter1).propose.staticCall(targets, values, calldatas, description);
      await governance.connect(voter1).propose(targets, values, calldatas, description);
      
      // Mine 2 blocks to move past voting delay
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      // Any tokenholder should be able to vote
      await expect(governance.connect(voter1).castVote(proposalId, 1))
        .to.not.be.reverted;

      await expect(governance.connect(voter2).castVote(proposalId, 1))
        .to.not.be.reverted;
    });

    it("should use council member voting power from election", async function () {
      // Enable council voting
      await governance.connect(admin).setUseCouncilVoting(true);

      // Create a proposal
      const targets = [await token.getAddress()];
      const values = [0];
      const calldatas = ["0x"];
      const description = "Test proposal";

      // Ensure voter1 has delegated and voting power is recorded before proposing
      // Always re-delegate right before proposing to ensure fresh checkpoint
      // This is necessary after mining many blocks in beforeEach
      
      // Verify voter1 has tokens and enough balance
      const threshold = await governance.proposalThreshold();
      const balance = await token.balanceOf(await voter1.getAddress());
      expect(balance).to.be.gte(threshold, `voter1 must have enough balance (has ${balance}, needs ${threshold})`);
      
      // Delegate to zero address first to reset delegation
      await token.connect(voter1).delegate(ethers.ZeroAddress);
      await ethers.provider.send("evm_mine", []);
      
      // Delegate back to self to create fresh checkpoint
      await token.connect(voter1).delegate(await voter1.getAddress());
      // Mine at least one block after delegation for checkpoint to be created
      await ethers.provider.send("evm_mine", []);
      
      // Verify delegation is set (required for ERC20Votes)
      const delegates = await token.delegates(await voter1.getAddress());
      expect(delegates).to.equal(await voter1.getAddress(), "voter1 must be delegated to self");
      
      // Verify voting power calculation at the block that will be used for proposer validation
      // Governor uses block.number + votingDelay() for proposer validation
      const currentBlock = await ethers.provider.getBlockNumber();
      const votingDelay = await governance.votingDelay();
      const proposalBlock = currentBlock + Number(votingDelay);
      
      // Test that _getVotes returns balance for proposer validation
      // This should work because blockNumber (proposalBlock) >= currentBlock
      const votesAtProposalBlock = await governance.getVotes(await voter1.getAddress(), proposalBlock);
      expect(votesAtProposalBlock).to.be.gte(threshold, `Votes at proposal block ${proposalBlock} should be >= threshold (got ${votesAtProposalBlock}, need ${threshold})`);
      
      // Create proposal - the contract will use balance when delegation is set
      const proposalId = await governance.connect(voter1).propose.staticCall(targets, values, calldatas, description);
      await governance.connect(voter1).propose(targets, values, calldatas, description);
      // Mine 2 blocks to move past voting delay
      await ethers.provider.send("evm_mine", []);
      await ethers.provider.send("evm_mine", []);

      // Council member votes
      await governance.connect(councilMember1).castVote(proposalId, 1);

      // Check voting power (should be votes received in election)
      const councilMemberVotingPower = await council.getCouncilMemberVotingPower(await councilMember1.getAddress());
      expect(councilMemberVotingPower).to.be.greaterThan(0);

      // Proposal should reflect the vote
      // In OpenZeppelin Governor v5, use proposalVotes() instead of proposals mapping
      const proposalVotes = await governance.proposalVotes(proposalId);
      expect(proposalVotes.forVotes).to.equal(councilMemberVotingPower);
    });
  });

  describe("Council Configuration", function () {
    it("should allow governance to update election period", async function () {
      const newPeriod = ELECTION_PERIOD * 2;
      
      // Governance needs to be granted role (already done in beforeEach)
      // But we need to grant it to the governanceAccount signer, not the contract
      await council.grantRole(
        await council.GOVERNANCE_ROLE(),
        await governanceAccount.getAddress()
      );

      // This would typically be done via a governance proposal
      // For testing, we'll use the governance account directly
      await expect(council.connect(governanceAccount).setElectionPeriod(newPeriod))
        .to.not.be.reverted;
    });

    it("should allow governance to update term length", async function () {
      const newLength = TERM_LENGTH * 2;
      
      // Grant role to governanceAccount if not already granted
      const hasRole = await council.hasRole(
        await council.GOVERNANCE_ROLE(),
        await governanceAccount.getAddress()
      );
      if (!hasRole) {
        await council.grantRole(
          await council.GOVERNANCE_ROLE(),
          await governanceAccount.getAddress()
        );
      }
      
      await expect(council.connect(governanceAccount).setTermLength(newLength))
        .to.not.be.reverted;
    });
  });
});
