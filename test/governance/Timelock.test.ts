import { expect } from "chai";
import { ethers } from "hardhat";
import { Timelock } from "../../typechain-types";

describe("Timelock - Governance Tests", function () {
  let timelock: Timelock;
  let proposers: string[];
  let executors: string[];
  let admin: string;

  beforeEach(async function () {
    const [deployer, proposer1, proposer2, executor1, executor2, adminAccount] = await ethers.getSigners();
    proposers = [await proposer1.getAddress(), await proposer2.getAddress()];
    executors = [await executor1.getAddress(), await executor2.getAddress()];
    admin = await adminAccount.getAddress();

    const TimelockFactory = await ethers.getContractFactory("Timelock");
    timelock = await TimelockFactory.deploy(
      2 * 24 * 60 * 60, // 2 days (STANDARD_DELAY)
      proposers,
      executors,
      admin
    );
    await timelock.waitForDeployment();
  });

  describe("Delay Configuration", function () {
    it("should have correct standard delay", async function () {
      const standardDelay = await timelock.STANDARD_DELAY();
      expect(standardDelay).to.equal(2 * 24 * 60 * 60); // 2 days
    });

    it("should have correct high-impact delay", async function () {
      const highImpactDelay = await timelock.HIGH_IMPACT_DELAY();
      expect(highImpactDelay).to.equal(7 * 24 * 60 * 60); // 7 days
    });

    it("should return correct delay for proposal types", async function () {
      const standardDelay = await timelock.getDelayForProposalType(0);
      const highImpactDelay = await timelock.getDelayForProposalType(1);

      expect(standardDelay).to.equal(2 * 24 * 60 * 60);
      expect(highImpactDelay).to.equal(7 * 24 * 60 * 60);
    });

    it("should reject invalid proposal type", async function () {
      await expect(timelock.getDelayForProposalType(2)).to.be.revertedWith(
        "Timelock: invalid proposal type"
      );
    });
  });

  describe("Access Control", function () {
    it("should allow proposers to propose", async function () {
      // proposers array is set up in beforeEach with proposer1 and proposer2
      // Check that the first proposer in the array has the PROPOSER_ROLE
      const hasRole = await timelock.hasRole(await timelock.PROPOSER_ROLE(), proposers[0]);
      expect(hasRole).to.be.true;
    });
  });
});
