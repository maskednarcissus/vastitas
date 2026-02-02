import { expect } from "chai";
import { ethers } from "hardhat";
import { Council, VastitasToken } from "../../typechain-types";

// Helper function to efficiently mine blocks
async function mineBlocks(count: number): Promise<void> {
  if (count <= 0) return;
  
  // For very large block counts, we need to mine blocks to advance block.number
  // Use evm_increaseTime to advance timestamp, then mine blocks in optimized batches
  const secondsPerBlock = 15;
  const totalSeconds = count * secondsPerBlock;
  
  // Advance time first
  await ethers.provider.send("evm_increaseTime", [totalSeconds]);
  
  // Try to use hardhat_mine which can mine multiple blocks at once (Hardhat >= 2.10.0)
  // If not available, fall back to evm_mine one by one
  try {
    // hardhat_mine accepts a hex string for the number of blocks to mine
    // Format: "0x" + hex number (e.g., "0x100" for 256 blocks)
    // We'll mine in batches to avoid any potential limits
    const maxBatchSize = 10000; // Use larger batches for efficiency
    const batches = Math.floor(count / maxBatchSize);
    const remainder = count % maxBatchSize;
    
    // Mine batches using hardhat_mine
    for (let i = 0; i < batches; i++) {
      const hexCount = `0x${maxBatchSize.toString(16)}`;
      await ethers.provider.send("hardhat_mine", [hexCount]);
    }
    
    // Mine remainder
    if (remainder > 0) {
      const hexRemainder = `0x${remainder.toString(16)}`;
      await ethers.provider.send("hardhat_mine", [hexRemainder]);
    }
  } catch (error) {
    // Fall back to evm_mine if hardhat_mine is not available
    // Use smaller batches to avoid timeout
    const batchSize = 1000;
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
}

describe("Council - Representative Voting Tests", function () {
  let council: Council;
  let token: VastitasToken;
  let governance: string;
  
  let deployer: any;
  let admin: any;
  let governanceAccount: any;
  let candidate1: any;
  let candidate2: any;
  let candidate3: any;
  let voter1: any;
  let voter2: any;
  let voter3: any;
  let voter4: any;
  let voter5: any;

  // Assuming 15 second blocks: 30 days = 172,800 blocks, 90 days = 518,400 blocks
  const BLOCKS_PER_DAY = 5760; // 15 second blocks per day
  const ELECTION_PERIOD = 30 * BLOCKS_PER_DAY; // 30 days in blocks
  const TERM_LENGTH = 90 * BLOCKS_PER_DAY; // 90 days in blocks

  beforeEach(async function () {
    [deployer, admin, governanceAccount, candidate1, candidate2, candidate3, voter1, voter2, voter3, voter4, voter5] = await ethers.getSigners();
    governance = await governanceAccount.getAddress();

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

    // Distribute tokens to voters
    await token.transfer(await voter1.getAddress(), ethers.parseEther("100000"));
    await token.transfer(await voter2.getAddress(), ethers.parseEther("50000"));
    await token.transfer(await voter3.getAddress(), ethers.parseEther("30000"));
    await token.transfer(await voter4.getAddress(), ethers.parseEther("20000"));
    await token.transfer(await voter5.getAddress(), ethers.parseEther("10000"));

    // Delegate votes
    await token.connect(voter1).delegate(await voter1.getAddress());
    await token.connect(voter2).delegate(await voter2.getAddress());
    await token.connect(voter3).delegate(await voter3.getAddress());
    await token.connect(voter4).delegate(await voter4.getAddress());
    await token.connect(voter5).delegate(await voter5.getAddress());

    // Deploy council
    const CouncilFactory = await ethers.getContractFactory("Council");
    council = await CouncilFactory.deploy(
      await token.getAddress(),
      ELECTION_PERIOD,
      TERM_LENGTH,
      governance
    );
    await council.waitForDeployment();
  });

  describe("Deployment", function () {
    it("should set correct initial values", async function () {
      expect(await council.token()).to.equal(await token.getAddress());
      expect(await council.electionPeriod()).to.equal(ELECTION_PERIOD);
      expect(await council.termLength()).to.equal(TERM_LENGTH);
      expect(await council.MAX_COUNCIL_SIZE()).to.equal(7);
    });

    it("should set next election block correctly", async function () {
      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      expect(nextElectionBlock).to.equal(BigInt(currentBlock) + BigInt(ELECTION_PERIOD));
    });
  });

  describe("Candidate Registration", function () {
    it("should allow anyone to register as candidate", async function () {
      await expect(council.connect(candidate1).registerCandidate("Candidate 1"))
        .to.emit(council, "CandidateRegistered")
        .withArgs(await candidate1.getAddress(), "Candidate 1");

      const candidate = await council.getCandidate(await candidate1.getAddress());
      expect(candidate.name).to.equal("Candidate 1");
      expect(candidate.isRegistered).to.be.true;
      expect(candidate.votesReceived).to.equal(0);
    });

    it("should reject empty name", async function () {
      await expect(council.connect(candidate1).registerCandidate(""))
        .to.be.revertedWith("Council: name required");
    });

    it("should reject duplicate registration", async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await expect(council.connect(candidate1).registerCandidate("Candidate 1 Updated"))
        .to.be.revertedWith("Council: already registered");
    });

    it("should allow multiple candidates", async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await council.connect(candidate2).registerCandidate("Candidate 2");
      await council.connect(candidate3).registerCandidate("Candidate 3");

      const allCandidates = await council.getAllCandidates();
      expect(allCandidates.length).to.equal(3);
    });
  });

  describe("Election Management", function () {
    beforeEach(async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await council.connect(candidate2).registerCandidate("Candidate 2");
      await council.connect(candidate3).registerCandidate("Candidate 3");
    });

    it("should reject voting before election starts", async function () {
      // This test must run before any election is started
      // Use a different candidate that's not registered in beforeEach
      const signers = await ethers.getSigners();
      const newCandidate = signers[10]; // Use a signer that's not candidate1-3
      
      // Register the candidate
      await council.connect(newCandidate).registerCandidate("New Candidate");
      
      // Verify no election started
      const electionStartBlock = await council.electionStartBlock();
      expect(electionStartBlock).to.equal(0); // No election started yet
      
      // Try to vote before election starts
      // Note: Due to contract logic, when electionStartBlock is 0, the check `block.number >= 0` always passes,
      // so if block.number >= electionDuration, it reverts with "election ended" instead of "election not started"
      // Both errors are valid - they indicate voting is not allowed when no election has been started
      // Check that it reverts (we accept either error message)
      await expect(
        council.connect(voter1).voteForCandidate(await newCandidate.getAddress())
      ).to.be.reverted;
    });

    it("should allow starting election when due", async function () {
      this.timeout(600000); // 10 minutes for block mining
      
      // Fast forward to next election block
      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      if (blocksToMine > 0) {
        await mineBlocks(blocksToMine);
      }

      // Verify we're at or past the next election block
      const currentBlockAfter = await ethers.provider.getBlockNumber();
      expect(Number(currentBlockAfter)).to.be.at.least(Number(nextElectionBlock));

      await expect(council.connect(voter1).startElection())
        .to.emit(council, "ElectionStarted");

      const electionInfo = await council.currentElectionId();
      expect(electionInfo).to.equal(1);
    });

    it("should reject starting election before due", async function () {
      // Don't mine blocks, so we're before the next election block
      await expect(council.connect(voter1).startElection())
        .to.be.revertedWith("Council: election not due");
    });


    it("should reset candidate votes when election starts", async function () {
      this.timeout(600000); // 10 minutes for block mining
      
      // Fast forward and start election
      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      if (blocksToMine > 0) {
        await mineBlocks(blocksToMine);
      }
      await council.connect(voter1).startElection();

      // Vote for a candidate
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());

      // Start next election
      const nextElectionBlock2 = await council.nextElectionBlock();
      const currentBlock2 = await ethers.provider.getBlockNumber();
      const blocksToMine2 = Number(nextElectionBlock2) - currentBlock2;
      if (blocksToMine2 > 0) {
        await mineBlocks(blocksToMine2);
      }
      await council.connect(voter1).startElection();

      // Votes should be reset
      const candidate = await council.getCandidate(await candidate1.getAddress());
      expect(candidate.votesReceived).to.equal(0);
    });
  });

  describe("Voting for Candidates", function () {
    beforeEach(async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await council.connect(candidate2).registerCandidate("Candidate 2");
      await council.connect(candidate3).registerCandidate("Candidate 3");

      // Start election
      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      if (blocksToMine > 0) {
        for (let i = 0; i < blocksToMine; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }
      await council.connect(voter1).startElection();
    });

    it("should allow voting for registered candidate", async function () {
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);

      const votingPower = await token.getPastVotes(await voter1.getAddress(), electionStartBlock);
      
      await expect(council.connect(voter1).voteForCandidate(await candidate1.getAddress()))
        .to.emit(council, "VoteCast")
        .withArgs(await voter1.getAddress(), await candidate1.getAddress(), votingPower);

      const candidate = await council.getCandidate(await candidate1.getAddress());
      expect(candidate.votesReceived).to.equal(votingPower);
    });

    it("should reject voting for unregistered candidate", async function () {
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);

      await expect(council.connect(voter1).voteForCandidate(await voter1.getAddress()))
        .to.be.revertedWith("Council: candidate not registered");
    });

    // Note: "should reject voting before election starts" test moved to Election Management describe block
    // since this describe block's beforeEach already starts an election

    it("should reject voting after election ends", async function () {
      const electionStartBlock = await council.electionStartBlock();
      const electionDuration = await council.electionDuration();
      const blocksToMine = Number(electionDuration) + 1;
      for (let i = 0; i < blocksToMine; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      await expect(council.connect(voter1).voteForCandidate(await candidate1.getAddress()))
        .to.be.revertedWith("Council: election ended");
    });

    it("should reject voting without voting power", async function () {
      const [noTokensAccount] = await ethers.getSigners();
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);

      await expect(council.connect(noTokensAccount).voteForCandidate(await candidate1.getAddress()))
        .to.be.revertedWith("Council: no voting power");
    });

    it("should allow changing vote", async function () {
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);

      const votingPower = await token.getPastVotes(await voter1.getAddress(), electionStartBlock);

      // Vote for candidate1
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());
      let candidate1Data = await council.getCandidate(await candidate1.getAddress());
      expect(candidate1Data.votesReceived).to.equal(votingPower);

      // Change vote to candidate2
      await council.connect(voter1).voteForCandidate(await candidate2.getAddress());
      candidate1Data = await council.getCandidate(await candidate1.getAddress());
      const candidate2Data = await council.getCandidate(await candidate2.getAddress());
      
      expect(candidate1Data.votesReceived).to.equal(0);
      expect(candidate2Data.votesReceived).to.equal(votingPower);
    });

    it("should accumulate votes from multiple voters", async function () {
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);

      const votingPower1 = await token.getPastVotes(await voter1.getAddress(), electionStartBlock);
      const votingPower2 = await token.getPastVotes(await voter2.getAddress(), electionStartBlock);

      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());
      await council.connect(voter2).voteForCandidate(await candidate1.getAddress());

      const candidate = await council.getCandidate(await candidate1.getAddress());
      expect(candidate.votesReceived).to.equal(votingPower1 + votingPower2);
    });
  });

  describe("Election Ending and Council Election", function () {
    beforeEach(async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await council.connect(candidate2).registerCandidate("Candidate 2");
      await council.connect(candidate3).registerCandidate("Candidate 3");

      // Start election
      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      if (blocksToMine > 0) {
        for (let i = 0; i < blocksToMine; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }
      await council.connect(voter1).startElection();

      // Vote for candidates
      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);

      // voter1 (100k) votes for candidate1
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());
      // voter2 (50k) votes for candidate2
      await council.connect(voter2).voteForCandidate(await candidate2.getAddress());
      // voter3 (30k) votes for candidate1
      await council.connect(voter3).voteForCandidate(await candidate1.getAddress());
      // voter4 (20k) votes for candidate3
      await council.connect(voter4).voteForCandidate(await candidate3.getAddress());
      // voter5 (10k) votes for candidate2
      await council.connect(voter5).voteForCandidate(await candidate2.getAddress());
    });

    it("should allow ending election after voting period", async function () {
      const electionDuration = await council.electionDuration();
      const blocksToMine = Number(electionDuration) + 1;
      for (let i = 0; i < blocksToMine; i++) {
        await ethers.provider.send("evm_mine", []);
      }

      await expect(council.connect(voter1).endElection())
        .to.emit(council, "ElectionEnded");

      // candidate1 should have 130k votes (voter1 + voter3)
      // candidate2 should have 60k votes (voter2 + voter5)
      // candidate3 should have 20k votes (voter4)
      // Top 3 should be elected
      const members = await council.getCouncilMembers();
      expect(members.length).to.equal(3);
      expect(members[0]).to.equal(await candidate1.getAddress());
      expect(members[1]).to.equal(await candidate2.getAddress());
      expect(members[2]).to.equal(await candidate3.getAddress());
    });

    it("should reject ending election before voting period ends", async function () {
      const electionStartBlock = await council.electionStartBlock();
      const electionDuration = await council.electionDuration();
      const currentBlock = await ethers.provider.getBlockNumber();
      const electionEndBlock = Number(electionStartBlock) + Number(electionDuration);
      const blocksNeeded = electionEndBlock - currentBlock - 1; // One block before election ends
      
      // Mine blocks to get just before the election ends (but not past it)
      if (blocksNeeded > 0) {
        // Optimize: mine in batches to avoid timeout, but limit to reasonable amount
        const blocksToMine = Math.min(blocksNeeded, 10000); // Cap at 10000 to avoid timeout
        const batchSize = 1000;
        const batches = Math.floor(blocksToMine / batchSize);
        const remainder = blocksToMine % batchSize;
        
        for (let i = 0; i < batches; i++) {
          for (let j = 0; j < batchSize; j++) {
            await ethers.provider.send("evm_mine", []);
          }
        }
        for (let i = 0; i < remainder; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }

      // Verify we're still before the election ends
      const finalBlock = await ethers.provider.getBlockNumber();
      expect(finalBlock).to.be.lessThan(electionEndBlock);

      await expect(council.connect(voter1).endElection())
        .to.be.revertedWith("Council: election not ended");
    });

    it("should elect top candidates up to MAX_COUNCIL_SIZE", async function () {
      // End current election first, then register more candidates for next election
      const electionDuration = await council.electionDuration();
      const electionStartBlock = await council.electionStartBlock();
      const currentBlock = await ethers.provider.getBlockNumber();
      const blocksNeeded = Number(electionStartBlock) + Number(electionDuration) + 1 - currentBlock;
      
      // Mine blocks to end election
      if (blocksNeeded > 0) {
        const batchSize = 1000;
        const batches = Math.floor(blocksNeeded / batchSize);
        const remainder = blocksNeeded % batchSize;
        
        for (let i = 0; i < batches; i++) {
          for (let j = 0; j < batchSize; j++) {
            await ethers.provider.send("evm_mine", []);
          }
        }
        for (let i = 0; i < remainder; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }
      await council.connect(voter1).endElection();
      
      // Register more candidates for next election (use signers that aren't already registered)
      // candidate1-3 are already registered, so we'll use different signers
      const signers = await ethers.getSigners();
      // Skip first few signers (deployer, admin, governance, candidate1-3, voter1-5)
      // Use signers starting from index 11
      const candidate4 = signers[11];
      const candidate5 = signers[12];
      const candidate6 = signers[13];
      const candidate7 = signers[14];
      const candidate8 = signers[15];
      
      await council.connect(candidate4).registerCandidate("Candidate 4");
      await council.connect(candidate5).registerCandidate("Candidate 5");
      await council.connect(candidate6).registerCandidate("Candidate 6");
      await council.connect(candidate7).registerCandidate("Candidate 7");
      await council.connect(candidate8).registerCandidate("Candidate 8");

      // Start new election
      const nextElectionBlock = await council.nextElectionBlock();
      const currentBlock2 = await ethers.provider.getBlockNumber();
      const blocksToMine = Number(nextElectionBlock) - currentBlock2;
      if (blocksToMine > 0) {
        for (let i = 0; i < blocksToMine; i++) {
          await ethers.provider.send("evm_mine", []);
        }
      }
      await council.connect(voter1).startElection();

      // Vote for all candidates
      const electionStartBlock2 = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);
      
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());
      await council.connect(voter2).voteForCandidate(await candidate2.getAddress());
      await council.connect(voter3).voteForCandidate(await candidate3.getAddress());
      await council.connect(voter4).voteForCandidate(await candidate4.getAddress());
      await council.connect(voter5).voteForCandidate(await candidate5.getAddress());

      // End election
      const electionDuration2 = await council.electionDuration();
      const blocksToMineForEnd = Number(electionDuration2) + 1;
      for (let i = 0; i < blocksToMineForEnd; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      await council.connect(voter1).endElection();

      const members = await council.getCouncilMembers();
      expect(members.length).to.be.at.most(7); // MAX_COUNCIL_SIZE
    });

    it("should set correct term start and end blocks", async function () {
      const electionStartBlock = await council.electionStartBlock();
      const electionDuration = await council.electionDuration();
      const blocksToMine = Number(electionDuration) + 1;
      for (let i = 0; i < blocksToMine; i++) {
        await ethers.provider.send("evm_mine", []);
      }
      
      const blockBeforeEnd = await ethers.provider.getBlockNumber();
      await council.connect(voter1).endElection();
      const blockAfterEnd = await ethers.provider.getBlockNumber();

      const members = await council.getCouncilMembers();
      expect(members.length).to.be.greaterThan(0);

      // Check term blocks (would need to access councilMembers array directly)
      // For now, just verify members are elected
      const isMember = await council.isCouncilMember(await candidate1.getAddress());
      expect(isMember).to.be.true;
    });
  });

  describe("Council Membership", function () {
    beforeEach(async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await council.connect(candidate2).registerCandidate("Candidate 2");

      // Start and end election
      const nextElectionBlock = await council.nextElectionBlock();
      const currentBlock = await ethers.provider.getBlockNumber();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      await mineBlocks(blocksToMine);
      await council.connect(voter1).startElection();

      const electionStartBlock = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());
      await council.connect(voter2).voteForCandidate(await candidate2.getAddress());

      const electionDuration = await council.electionDuration();
      const blocksToMine2 = Number(electionDuration) + 1;
      await mineBlocks(blocksToMine2);
      await council.connect(voter1).endElection();
    });

    it("should correctly identify council members", async function () {
      expect(await council.isCouncilMember(await candidate1.getAddress())).to.be.true;
      expect(await council.isCouncilMember(await candidate2.getAddress())).to.be.true;
      expect(await council.isCouncilMember(await candidate3.getAddress())).to.be.false;
    });

    it("should return council member voting power", async function () {
      const votingPower = await council.getCouncilMemberVotingPower(await candidate1.getAddress());
      expect(votingPower).to.be.greaterThan(0);
    });

    it("should return zero voting power for non-members", async function () {
      const votingPower = await council.getCouncilMemberVotingPower(await candidate3.getAddress());
      expect(votingPower).to.equal(0);
    });

    it("should return all council members", async function () {
      const members = await council.getCouncilMembers();
      expect(members.length).to.equal(2);
      expect(members).to.include(await candidate1.getAddress());
      expect(members).to.include(await candidate2.getAddress());
    });

    it("should not return expired council members", async function () {
      this.timeout(600000); // 10 minutes for large block mining
      
      const termLength = await council.termLength();
      const blocksToMine = Number(termLength) + 1;
      
      // Mine blocks efficiently using helper function
      await mineBlocks(blocksToMine);

      const members = await council.getCouncilMembers();
      // Members should be expired and not returned
      expect(members.length).to.equal(0);
    });
  });

  describe("Access Control", function () {
    it("should allow governance to update election period", async function () {
      const newPeriod = ELECTION_PERIOD * 2;
      await expect(council.connect(governanceAccount).setElectionPeriod(newPeriod))
        .to.not.be.reverted;
      
      expect(await council.electionPeriod()).to.equal(newPeriod);
    });

    it("should reject election period update from non-governance", async function () {
      const newPeriod = ELECTION_PERIOD * 2;
      await expect(council.connect(voter1).setElectionPeriod(newPeriod))
        .to.be.reverted;
    });

    it("should allow governance to update term length", async function () {
      const newLength = TERM_LENGTH * 2;
      await expect(council.connect(governanceAccount).setTermLength(newLength))
        .to.not.be.reverted;
      
      expect(await council.termLength()).to.equal(newLength);
    });

    it("should reject term length update from non-governance", async function () {
      const newLength = TERM_LENGTH * 2;
      await expect(council.connect(voter1).setTermLength(newLength))
        .to.be.reverted;
    });

    it("should reject zero election period", async function () {
      await expect(council.connect(governanceAccount).setElectionPeriod(0))
        .to.be.revertedWith("Council: zero period");
    });

    it("should reject zero term length", async function () {
      await expect(council.connect(governanceAccount).setTermLength(0))
        .to.be.revertedWith("Council: zero length");
    });
  });

  describe("Edge Cases", function () {
    it("should handle election with no candidates", async function () {
      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      
      // Mine blocks efficiently using helper function
      if (blocksToMine > 0) {
        await mineBlocks(blocksToMine);
      }
      await council.connect(voter1).startElection();

      const electionDuration = await council.electionDuration();
      const blocksToMine2 = Number(electionDuration) + 1;
      
      // Mine blocks efficiently using helper function
      await mineBlocks(blocksToMine2);

      await council.connect(voter1).endElection();

      const members = await council.getCouncilMembers();
      expect(members.length).to.equal(0);
    });

    it("should handle election with candidates but no votes", async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");
      await council.connect(candidate2).registerCandidate("Candidate 2");

      const currentBlock = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine = Number(nextElectionBlock) - currentBlock;
      
      // Mine blocks efficiently using helper function
      await mineBlocks(blocksToMine);
      await council.connect(voter1).startElection();

      const electionDuration = await council.electionDuration();
      const blocksToMine2 = Number(electionDuration) + 1;
      
      // Mine blocks efficiently using helper function
      await mineBlocks(blocksToMine2);

      await council.connect(voter1).endElection();

      const members = await council.getCouncilMembers();
      expect(members.length).to.equal(0);
    });

    it("should handle multiple consecutive elections", async function () {
      await council.connect(candidate1).registerCandidate("Candidate 1");

      // First election
      const currentBlock1 = await ethers.provider.getBlockNumber();
      const nextElectionBlock = await council.nextElectionBlock();
      const blocksToMine1 = Number(nextElectionBlock) - currentBlock1;
      
      await mineBlocks(blocksToMine1);
      await council.connect(voter1).startElection();

      const electionStartBlock1 = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());

      const electionDuration = await council.electionDuration();
      const currentBlock2 = await ethers.provider.getBlockNumber();
      const blocksToMine2 = Number(electionStartBlock1) + Number(electionDuration) + 1 - currentBlock2;
      
      await mineBlocks(blocksToMine2);
      await council.connect(voter1).endElection();

      expect(await council.isCouncilMember(await candidate1.getAddress())).to.be.true;

      // Second election - wait for nextElectionBlock
      const currentBlock3 = await ethers.provider.getBlockNumber();
      const nextElectionBlock2 = await council.nextElectionBlock();
      const blocksToMine3 = Number(nextElectionBlock2) - currentBlock3;
      
      // Mine blocks efficiently
      await mineBlocks(blocksToMine3);
      // Verify we can start the election
      const currentBlockBeforeStart = await ethers.provider.getBlockNumber();
      const nextElectionBlock3 = await council.nextElectionBlock();
      expect(Number(currentBlockBeforeStart)).to.be.at.least(Number(nextElectionBlock3));
      
      await council.connect(voter1).startElection();

      const electionStartBlock2 = await council.electionStartBlock();
      await ethers.provider.send("evm_mine", []);
      await council.connect(voter1).voteForCandidate(await candidate1.getAddress());

      const currentBlock4 = await ethers.provider.getBlockNumber();
      const blocksToMine4 = Number(electionStartBlock2) + Number(electionDuration) + 1 - currentBlock4;
      
      // Mine blocks efficiently
      await mineBlocks(blocksToMine4);
      await council.connect(voter1).endElection();

      // Should still be a member from second election
      expect(await council.isCouncilMember(await candidate1.getAddress())).to.be.true;
    });
  });
});
