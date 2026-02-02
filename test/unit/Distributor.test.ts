import { expect } from "chai";
import { ethers } from "hardhat";
import { Distributor, VastitasToken, MockERC20 } from "../../typechain-types";
import { time } from "@nomicfoundation/hardhat-network-helpers";

describe("Distributor - Unit Tests", function () {
  let distributor: Distributor;
  let stakeToken: VastitasToken;
  let rewardToken: MockERC20;
  let admin: string;
  let router: string;
  let user1: string;
  let user2: string;

  const EPOCH_DURATION = 7 * 24 * 60 * 60; // 7 days

  beforeEach(async function () {
    const [deployer, adminAccount, routerAccount, user1Account, user2Account] = await ethers.getSigners();
    admin = await adminAccount.getAddress();
    router = await routerAccount.getAddress();
    user1 = await user1Account.getAddress();
    user2 = await user2Account.getAddress();

    // Deploy stake token (Vastitas)
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    stakeToken = await TokenFactory.deploy(
      "Vastitas",
      "Vastitas",
      ethers.parseEther("1000000000"),
      deployer.address,
      deployer.address
    );
    await stakeToken.waitForDeployment();

    // Deploy reward token
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    rewardToken = await MockERC20Factory.deploy("Reward Token", "REWARD");
    await rewardToken.waitForDeployment();

    // Deploy distributor
    const DistributorFactory = await ethers.getContractFactory("Distributor");
    distributor = await DistributorFactory.deploy(
      await stakeToken.getAddress(),
      await rewardToken.getAddress(),
      EPOCH_DURATION,
      admin,
      router
    );
    await distributor.waitForDeployment();

    // Setup: mint stake tokens to users
    await stakeToken.transfer(user1, ethers.parseEther("10000"));
    await stakeToken.transfer(user2, ethers.parseEther("10000"));
  });

  describe("Constructor", function () {
    it("should set tokens correctly", async function () {
      expect(await distributor.stakeToken()).to.equal(await stakeToken.getAddress());
      expect(await distributor.rewardToken()).to.equal(await rewardToken.getAddress());
    });

    it("should set epoch duration correctly", async function () {
      expect(await distributor.epochDuration()).to.equal(EPOCH_DURATION);
    });

    it("should initialize epoch 1", async function () {
      expect(await distributor.currentEpoch()).to.equal(1);
    });

    it("should reject zero stake token", async function () {
      const DistributorFactory = await ethers.getContractFactory("Distributor");
      await expect(
        DistributorFactory.deploy(
          ethers.ZeroAddress,
          await rewardToken.getAddress(),
          EPOCH_DURATION,
          admin,
          router
        )
      ).to.be.revertedWith("Distributor: zero stake token");
    });

    it("should reject zero reward token", async function () {
      const DistributorFactory = await ethers.getContractFactory("Distributor");
      await expect(
        DistributorFactory.deploy(
          await stakeToken.getAddress(),
          ethers.ZeroAddress,
          EPOCH_DURATION,
          admin,
          router
        )
      ).to.be.revertedWith("Distributor: zero reward token");
    });

    it("should reject zero epoch duration", async function () {
      const DistributorFactory = await ethers.getContractFactory("Distributor");
      await expect(
        DistributorFactory.deploy(
          await stakeToken.getAddress(),
          await rewardToken.getAddress(),
          0,
          admin,
          router
        )
      ).to.be.revertedWith("Distributor: zero epoch duration");
    });
  });

  describe("stake", function () {
    it("should stake tokens correctly", async function () {
      const amount = ethers.parseEther("1000");

      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), amount);

      await expect(distributor.connect(await ethers.getSigner(user1)).stake(amount))
        .to.emit(distributor, "Staked")
        .withArgs(user1, amount);

      expect(await distributor.getStakedAmount(user1)).to.equal(amount);
      expect(await distributor.getTotalStaked()).to.equal(amount);
    });

    it("should reject zero amount", async function () {
      await expect(distributor.connect(await ethers.getSigner(user1)).stake(0)).to.be.revertedWith(
        "Distributor: zero amount"
      );
    });

    it("should accumulate stakes", async function () {
      const amount1 = ethers.parseEther("1000");
      const amount2 = ethers.parseEther("500");

      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), amount1 + amount2);

      await distributor.connect(await ethers.getSigner(user1)).stake(amount1);
      await distributor.connect(await ethers.getSigner(user1)).stake(amount2);

      expect(await distributor.getStakedAmount(user1)).to.equal(amount1 + amount2);
    });
  });

  describe("unstake", function () {
    beforeEach(async function () {
      // Setup: stake some tokens
      const amount = ethers.parseEther("1000");
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), amount);
      await distributor.connect(await ethers.getSigner(user1)).stake(amount);
    });

    it("should unstake tokens correctly", async function () {
      const amount = ethers.parseEther("500");

      await expect(distributor.connect(await ethers.getSigner(user1)).unstake(amount))
        .to.emit(distributor, "Unstaked")
        .withArgs(user1, amount);

      expect(await distributor.getStakedAmount(user1)).to.equal(ethers.parseEther("500"));
      expect(await distributor.getTotalStaked()).to.equal(ethers.parseEther("500"));
    });

    it("should reject zero amount", async function () {
      await expect(distributor.connect(await ethers.getSigner(user1)).unstake(0)).to.be.revertedWith(
        "Distributor: zero amount"
      );
    });

    it("should reject insufficient stake", async function () {
      const amount = ethers.parseEther("2000");

      await expect(
        distributor.connect(await ethers.getSigner(user1)).unstake(amount)
      ).to.be.revertedWith("Distributor: insufficient stake");
    });
  });

  describe("distributeRewards", function () {
    beforeEach(async function () {
      // Setup: stake tokens
      const amount = ethers.parseEther("1000");
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), amount);
      await distributor.connect(await ethers.getSigner(user1)).stake(amount);
    });

    it("should distribute rewards correctly", async function () {
      const rewardAmount = ethers.parseEther("100");

      // Advance to next epoch so stake counts
      await time.increase(EPOCH_DURATION + 1);

      await rewardToken.mint(router, rewardAmount);
      await rewardToken.connect(await ethers.getSigner(router)).approve(await distributor.getAddress(), rewardAmount);

      await expect(
        distributor.connect(await ethers.getSigner(router)).distributeRewards(rewardAmount)
      )
        .to.emit(distributor, "RewardsDistributed")
        .withArgs(2, rewardAmount);

      expect(await distributor.getEpochRewards(2)).to.equal(rewardAmount);
    });

    it("should reject zero amount", async function () {
      await expect(
        distributor.connect(await ethers.getSigner(router)).distributeRewards(0)
      ).to.be.revertedWith("Distributor: zero amount");
    });

    it("should reject non-router calls", async function () {
      const rewardAmount = ethers.parseEther("100");

      await rewardToken.mint(user1, rewardAmount);
      await rewardToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), rewardAmount);

      await expect(
        distributor.connect(await ethers.getSigner(user1)).distributeRewards(rewardAmount)
      ).to.be.reverted;
    });
  });

  describe("claimRewards", function () {
    beforeEach(async function () {
      // Setup: stake tokens and distribute rewards
      const stakeAmount = ethers.parseEther("1000");
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), stakeAmount);
      await distributor.connect(await ethers.getSigner(user1)).stake(stakeAmount);

      // Advance to next epoch so stake counts
      await time.increase(EPOCH_DURATION + 1);

      const rewardAmount = ethers.parseEther("100");
      await rewardToken.mint(router, rewardAmount);
      await rewardToken.connect(await ethers.getSigner(router)).approve(await distributor.getAddress(), rewardAmount);
      await distributor.connect(await ethers.getSigner(router)).distributeRewards(rewardAmount);

      // Advance again to finalize epoch 2
      await time.increase(EPOCH_DURATION + 1);
    });

    it("should claim rewards correctly", async function () {
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), 1);
      await distributor.connect(await ethers.getSigner(user1)).stake(1); // Trigger epoch advance

      // Ensure we're claiming for the right epoch (epoch 2, which was finalized)
      const currentEpoch = await distributor.currentEpoch();
      expect(currentEpoch).to.be.gte(3); // Should be 3 or more after advancing

      const user1BalanceBefore = await rewardToken.balanceOf(user1);
      const epochRewards = await distributor.getEpochRewards(2);
      expect(epochRewards).to.equal(ethers.parseEther("100"));

      await expect(distributor.connect(await ethers.getSigner(user1)).claimRewards(2))
        .to.emit(distributor, "RewardsClaimed");

      const user1BalanceAfter = await rewardToken.balanceOf(user1);
      expect(user1BalanceAfter - user1BalanceBefore).to.equal(ethers.parseEther("100"));
    });

    it("should reject claim for current epoch", async function () {
      // Distribute rewards for current epoch
      const rewardAmount = ethers.parseEther("50");
      await rewardToken.mint(router, rewardAmount);
      await rewardToken.connect(await ethers.getSigner(router)).approve(await distributor.getAddress(), rewardAmount);
      await distributor.connect(await ethers.getSigner(router)).distributeRewards(rewardAmount);

      await expect(
        distributor.connect(await ethers.getSigner(user1)).claimRewards(await distributor.currentEpoch())
      ).to.be.revertedWith("Distributor: epoch not finalized");
    });

    it("should reject double claim", async function () {
      // Trigger epoch advance to finalize epoch 1
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), 1);
      await distributor.connect(await ethers.getSigner(user1)).stake(1); // Minimal stake to trigger epoch advance

      // First claim should succeed
      await distributor.connect(await ethers.getSigner(user1)).claimRewards(2);

      // Second claim should fail
      await expect(distributor.connect(await ethers.getSigner(user1)).claimRewards(2)).to.be.revertedWith(
        "Distributor: already claimed"
      );
    });

    it("should reject claim with no stake", async function () {
      // Need to advance epoch first (epoch check comes before stake check)
      // Trigger epoch advance by staking a minimal amount
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), 1);
      await distributor.connect(await ethers.getSigner(user1)).stake(1); // Minimal stake to trigger advance
      
      // Now epoch should be advanced, so we can test the "no stake" error
      await expect(distributor.connect(await ethers.getSigner(user2)).claimRewards(2)).to.be.revertedWith(
        "Distributor: no stake"
      );
    });
  });

  describe("Pro-rata Distribution", function () {
    it("should distribute rewards pro-rata based on stake", async function () {
      // User1 stakes 1000
      const stake1 = ethers.parseEther("1000");
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), stake1);
      await distributor.connect(await ethers.getSigner(user1)).stake(stake1);

      // User2 stakes 2000
      const stake2 = ethers.parseEther("2000");
      await stakeToken.connect(await ethers.getSigner(user2)).approve(await distributor.getAddress(), stake2);
      await distributor.connect(await ethers.getSigner(user2)).stake(stake2);

      // Advance to next epoch so stake counts
      await time.increase(EPOCH_DURATION + 1);

      // Distribute 300 rewards
      const rewardAmount = ethers.parseEther("300");
      await rewardToken.mint(router, rewardAmount);
      await rewardToken.connect(await ethers.getSigner(router)).approve(await distributor.getAddress(), rewardAmount);
      await distributor.connect(await ethers.getSigner(router)).distributeRewards(rewardAmount);

      // Advance epoch
      await time.increase(EPOCH_DURATION + 1);
      
      // Trigger epoch advance by staking a minimal amount
      await stakeToken.connect(await ethers.getSigner(user1)).approve(await distributor.getAddress(), 1);
      await distributor.connect(await ethers.getSigner(user1)).stake(1); // Minimal stake to trigger advance

      // User1 should get 100 (1/3 of 300)
      // User2 should get 200 (2/3 of 300)
      const user1BalanceBefore = await rewardToken.balanceOf(user1);
      const user2BalanceBefore = await rewardToken.balanceOf(user2);

      // Ensure stake is maintained when claiming (don't unstake before claiming)
      await distributor.connect(await ethers.getSigner(user1)).claimRewards(2);
      await distributor.connect(await ethers.getSigner(user2)).claimRewards(2);

      const user1BalanceAfter = await rewardToken.balanceOf(user1);
      const user2BalanceAfter = await rewardToken.balanceOf(user2);

      expect(user1BalanceAfter - user1BalanceBefore).to.equal(ethers.parseEther("100"));
      // Allow for 1 wei rounding difference due to division
      const user2Reward = user2BalanceAfter - user2BalanceBefore;
      expect(user2Reward).to.be.closeTo(ethers.parseEther("200"), 1);
    });
  });

  describe("setEpochDuration", function () {
    it("should update epoch duration", async function () {
      const adminDistributor = distributor.connect(await ethers.getSigner(admin));
      const newDuration = EPOCH_DURATION * 2;

      await adminDistributor.setEpochDuration(newDuration);

      expect(await distributor.epochDuration()).to.equal(newDuration);
    });

    it("should reject zero duration", async function () {
      const adminDistributor = distributor.connect(await ethers.getSigner(admin));

      await expect(adminDistributor.setEpochDuration(0)).to.be.revertedWith("Distributor: zero duration");
    });

    it("should reject non-admin calls", async function () {
      await expect(
        distributor.connect(await ethers.getSigner(user1)).setEpochDuration(EPOCH_DURATION * 2)
      ).to.be.reverted;
    });
  });
});
