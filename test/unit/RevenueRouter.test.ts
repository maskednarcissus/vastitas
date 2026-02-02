import { expect } from "chai";
import { ethers } from "hardhat";
import {
  RevenueRouter,
  PluginRegistry,
  SwapModule,
  VastitasToken,
  TreasuryVault,
  MockPlugin,
  MockERC20,
  MockUniswapV3Router,
  MockUniswapV3Quoter,
  Distributor,
} from "../../typechain-types";
import { PluginTier, DistributionModel } from "../helpers/TestConstants";

describe("RevenueRouter - Unit Tests", function () {
  let router: RevenueRouter;
  let registry: PluginRegistry;
  let swapModule: SwapModule;
  let token: VastitasToken;
  let treasury: TreasuryVault;
  let mockPlugin: MockPlugin;
  let yieldAsset: MockERC20;
  let treasuryAsset: MockERC20;
  let mockUniswapRouter: MockUniswapV3Router;
  let mockUniswapQuoter: MockUniswapV3Quoter;
  let distributor: Distributor;

  let admin: string;
  let governance: string;
  let pluginOwner: string;
  let devRecipient: string;

  beforeEach(async function () {
    const [deployer, adminAccount, govAccount, pluginOwnerAccount, devAccount] =
      await ethers.getSigners();
    admin = await adminAccount.getAddress();
    governance = await govAccount.getAddress();
    pluginOwner = await pluginOwnerAccount.getAddress();
    devRecipient = await devAccount.getAddress();

    // Deploy tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    treasuryAsset = await MockERC20Factory.deploy("Treasury Asset", "TREASURY");
    await treasuryAsset.waitForDeployment();

    yieldAsset = await MockERC20Factory.deploy("Yield Asset", "YIELD");
    await yieldAsset.waitForDeployment();

    // Deploy mock Uniswap router
    const MockUniswapFactory = await ethers.getContractFactory("MockUniswapV3Router");
    mockUniswapRouter = await MockUniswapFactory.deploy();
    await mockUniswapRouter.waitForDeployment();

    // Deploy mock Uniswap quoter
    const MockQuoterFactory = await ethers.getContractFactory("MockUniswapV3Quoter");
    mockUniswapQuoter = await MockQuoterFactory.deploy();
    await mockUniswapQuoter.waitForDeployment();

    // Set exchange rate: 1 YIELD = 0.5 TREASURY (for testing)
    await mockUniswapRouter.setExchangeRate(
      await yieldAsset.getAddress(),
      await treasuryAsset.getAddress(),
      ethers.parseEther("0.5")
    );
    await mockUniswapQuoter.setExchangeRate(
      await yieldAsset.getAddress(),
      await treasuryAsset.getAddress(),
      ethers.parseEther("0.5")
    );

    // Mint treasuryAsset to mock router so it can execute swaps
    await treasuryAsset.mint(await mockUniswapRouter.getAddress(), ethers.parseEther("1000000"));

    // Deploy Vastitas token
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    token = await TokenFactory.deploy(
      "Vastitas",
      "Vastitas",
      ethers.parseEther("1000000000"),
      deployer.address,
      deployer.address
    );
    await token.waitForDeployment();

    // Deploy treasury
    const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
    treasury = await TreasuryFactory.deploy(admin, governance);
    await treasury.waitForDeployment();

    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("PluginRegistry");
    registry = await RegistryFactory.deploy(admin, governance);
    await registry.waitForDeployment();

    // Deploy swap module
    const SwapModuleFactory = await ethers.getContractFactory("SwapModule");
    swapModule = await SwapModuleFactory.deploy(
      await treasuryAsset.getAddress(),
      ethers.ZeroAddress, // Router set later
      await mockUniswapRouter.getAddress(), // Uniswap router
      admin
    );
    await swapModule.waitForDeployment();

    // Deploy router
    const RouterFactory = await ethers.getContractFactory("RevenueRouter");
    router = await RouterFactory.deploy(
      await registry.getAddress(),
      await swapModule.getAddress(),
      await token.getAddress(),
      await treasury.getAddress(),
      DistributionModel.BUYBACK_ONLY,
      admin,
      governance
    );
    await router.waitForDeployment();

    // Set router in swap module (requires admin role)
    await swapModule.connect(await ethers.getSigner(admin)).setRouter(await router.getAddress());
    await swapModule.connect(await ethers.getSigner(admin)).setUniswapQuoter(await mockUniswapQuoter.getAddress());

    // Whitelist swap route (yieldAsset -> treasuryAsset) (requires admin role)
    await swapModule.connect(await ethers.getSigner(admin)).setRouteWhitelist(
      await yieldAsset.getAddress(),
      await treasuryAsset.getAddress(),
      true
    );

    // Deploy mock plugin
    const pluginId = ethers.id("test-plugin-1");
    const underlyingAssets = [await yieldAsset.getAddress()];
    const MockPluginFactory = await ethers.getContractFactory("MockPlugin");
    mockPlugin = await MockPluginFactory.deploy(
      pluginId,
      underlyingAssets,
      await router.getAddress()
    );
    await mockPlugin.waitForDeployment();

    // Register plugin
    await registry.registerPlugin(await mockPlugin.getAddress());

    // Set plugin tier to VERIFIED for auto-swap tests
    await registry
      .connect(await ethers.getSigner(governance))
      .setPluginTier(await mockPlugin.pluginId(), PluginTier.VERIFIED);

    // Deploy distributor (for staking rewards)
    const DistributorFactory = await ethers.getContractFactory("Distributor");
    distributor = await DistributorFactory.deploy(
      await token.getAddress(),
      await treasuryAsset.getAddress(),
      7 * 24 * 60 * 60,
      admin,
      await router.getAddress()
    );
    await distributor.waitForDeployment();
    await router.connect(await ethers.getSigner(admin)).setDistributor(await distributor.getAddress());

    // Setup: mint yield asset to pluginOwner and approve plugin
    await yieldAsset.mint(pluginOwner, ethers.parseEther("100000"));
    await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
      await mockPlugin.getAddress(),
      ethers.MaxUint256
    );
  });

  describe("Quarantine Lifecycle", function () {
    it("should release quarantined yield and make it distributable", async function () {
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(await mockPlugin.pluginId(), PluginTier.UNTRUSTED);

      const yieldAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const quarantinedBefore = await router.getQuarantinedYield(
        await mockPlugin.pluginId(),
        await yieldAsset.getAddress()
      );
      expect(quarantinedBefore).to.equal(yieldAmount);

      // Promote plugin so swap limits allow conversion
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(await mockPlugin.pluginId(), PluginTier.VERIFIED);

      const accumulatedBefore = await router.getAccumulatedYield();
      await expect(
        router.connect(await ethers.getSigner(governance)).releaseQuarantinedYield(
          await mockPlugin.pluginId(),
          await yieldAsset.getAddress(),
          0
        )
      ).to.emit(router, "QuarantinedYieldReleased");

      const quarantinedAfter = await router.getQuarantinedYield(
        await mockPlugin.pluginId(),
        await yieldAsset.getAddress()
      );
      expect(quarantinedAfter).to.equal(0);

      const accumulatedAfter = await router.getAccumulatedYield();
      expect(accumulatedAfter).to.be.gt(accumulatedBefore);
    });

    it("should sweep quarantined yield to treasury vault", async function () {
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(await mockPlugin.pluginId(), PluginTier.UNTRUSTED);

      const yieldAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const treasuryBalanceBefore = await yieldAsset.balanceOf(await treasury.getAddress());

      await expect(
        router.connect(await ethers.getSigner(governance)).sweepQuarantinedYieldToTreasury(
          await mockPlugin.pluginId(),
          await yieldAsset.getAddress(),
          0
        )
      ).to.emit(router, "QuarantinedYieldSwept");

      const treasuryBalanceAfter = await yieldAsset.balanceOf(await treasury.getAddress());
      expect(treasuryBalanceAfter).to.be.gt(treasuryBalanceBefore);

      const quarantinedAfter = await router.getQuarantinedYield(
        await mockPlugin.pluginId(),
        await yieldAsset.getAddress()
      );
      expect(quarantinedAfter).to.equal(0);
    });
  });

  describe("Constructor", function () {
    it("should set immutable addresses correctly", async function () {
      expect(await router.pluginRegistry()).to.equal(await registry.getAddress());
      expect(await router.swapModule()).to.equal(await swapModule.getAddress());
      expect(await router.vastitasToken()).to.equal(await token.getAddress());
      expect(await router.treasuryVault()).to.equal(await treasury.getAddress());
    });

    it("should set initial distribution model", async function () {
      expect(await router.distributionModel()).to.equal(DistributionModel.BUYBACK_ONLY);
    });

    it("should reject zero addresses", async function () {
      const RouterFactory = await ethers.getContractFactory("RevenueRouter");
      await expect(
        RouterFactory.deploy(
          ethers.ZeroAddress,
          await swapModule.getAddress(),
          await token.getAddress(),
          await treasury.getAddress(),
          DistributionModel.BUYBACK_ONLY,
          admin,
          governance
        )
      ).to.be.revertedWith("RevenueRouter: zero registry");
    });
  });

  describe("receiveYield", function () {
    it("should receive yield from registered plugin", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYield = await router.getPluginYield(pluginId);
      expect(pluginYield).to.be.gt(0);
    });

    it("should quarantine yield for untrusted tier", async function () {
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(await mockPlugin.pluginId(), PluginTier.UNTRUSTED);

      const yieldAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const quarantined = await router.getQuarantinedYield(
        await mockPlugin.pluginId(),
        await yieldAsset.getAddress()
      );
      expect(quarantined).to.equal(yieldAmount);
      expect(await router.getPluginYield(await mockPlugin.pluginId())).to.equal(0);
    });

    it("should reject yield from unregistered plugin", async function () {
      // Deploy unregistered plugin
      const pluginId2 = ethers.id("unregistered-plugin");
      const MockPluginFactory = await ethers.getContractFactory("MockPlugin");
      const unregisteredPlugin = await MockPluginFactory.deploy(
        pluginId2,
        [await yieldAsset.getAddress()],
        await router.getAddress()
      );
      await unregisteredPlugin.waitForDeployment();

      await yieldAsset.mint(await unregisteredPlugin.getAddress(), ethers.parseEther("1000"));
      await unregisteredPlugin.setYield(await yieldAsset.getAddress(), ethers.parseEther("1000"));

      // Should fail because plugin is not registered
      await expect(unregisteredPlugin.claimAndRoute()).to.be.reverted;
    });

    it("should reject yield from inactive plugin", async function () {
      const pluginId = await mockPlugin.pluginId();
      const adminRegistry = registry.connect(await ethers.getSigner(admin));

      // Deactivate plugin (requires ADMIN_ROLE)
      await adminRegistry.deactivatePlugin(pluginId);

      await mockPlugin.setYield(await yieldAsset.getAddress(), ethers.parseEther("1000"));
      await expect(mockPlugin.claimAndRoute()).to.be.reverted;
    });

    it("should reject zero amount", async function () {
      await mockPlugin.setYield(await yieldAsset.getAddress(), 0);
      await expect(mockPlugin.claimAndRoute()).to.be.reverted;
    });

    it("should reject invalid asset for plugin", async function () {
      // Deploy another asset
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const invalidAsset = await MockERC20Factory.deploy("Invalid Asset", "INVALID");
      await invalidAsset.waitForDeployment();

      await invalidAsset.mint(await mockPlugin.getAddress(), ethers.parseEther("1000"));
      await mockPlugin.setYield(await invalidAsset.getAddress(), ethers.parseEther("1000"));

      await expect(mockPlugin.claimAndRoute()).to.be.reverted;
    });

    it("should calculate and transfer dev share correctly", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const devBps = 1000; // 10%
      const expectedDevShare = (yieldAmount * BigInt(devBps)) / 10000n;

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      
      await mockPlugin.setDevShare(devRecipient, devBps);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      const devBalanceBefore = await yieldAsset.balanceOf(devRecipient);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();
      const devBalanceAfter = await yieldAsset.balanceOf(devRecipient);

      expect(devBalanceAfter - devBalanceBefore).to.equal(expectedDevShare);

      const devShareReceived = await router.getDevShareReceived(devRecipient);
      expect(devShareReceived).to.equal(expectedDevShare);
    });

    it("should reject dev share > 20%", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const devBps = 2500; // 25% - exceeds MAX_DEV_SHARE_BPS (2000)

      // Ensure tokens and approval (needed even for revert tests)
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );

      await mockPlugin.setDevShare(devRecipient, devBps);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      await expect(
        mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute()
      ).to.be.revertedWith("RevenueRouter: dev share exceeds max");
    });

    it("should enforce per-plugin conversion caps", async function () {
      const pluginId = await mockPlugin.pluginId();
      await registry.connect(await ethers.getSigner(governance)).setPluginCaps(pluginId, {
        enabled: true,
        maxConversionAmount: ethers.parseEther("100"),
        maxSlippageBps: 100,
      });

      const yieldAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      await expect(
        mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute()
      ).to.be.revertedWith("RevenueRouter: conversion amount exceeds cap");
    });

    it("should handle zero dev share", async function () {
      const yieldAmount = ethers.parseEther("1000");

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );

      await mockPlugin.setDevShare(ethers.ZeroAddress, 0);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      await expect(
        mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute()
      ).to.not.be.reverted;
    });

    it("should enforce slippage limits via quoter", async function () {
      // Make quoter optimistic and router pessimistic to trigger slippage failure
      await mockUniswapQuoter.setExchangeRate(
        await yieldAsset.getAddress(),
        await treasuryAsset.getAddress(),
        ethers.parseEther("1")
      );
      await mockUniswapRouter.setExchangeRate(
        await yieldAsset.getAddress(),
        await treasuryAsset.getAddress(),
        ethers.parseEther("0.5")
      );

      const govRegistry = registry.connect(await ethers.getSigner(governance));
      await govRegistry.setTierConfig(PluginTier.VERIFIED, {
        maxConversionAmount: ethers.parseEther("100000"),
        maxSlippageBps: 100, // 1%
        allowAutoSwap: true,
        quarantineMode: false,
      });

      const yieldAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      await expect(
        mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute()
      ).to.be.revertedWith("MockUniswapV3Router: insufficient output");
    });

    it("should update accounting correctly", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYield = await router.getPluginYield(pluginId);
      const totalYield = await router.getTotalYield();
      const accumulatedYield = await router.getAccumulatedYield();

      expect(pluginYield).to.be.gt(0);
      expect(totalYield).to.equal(pluginYield);
      expect(accumulatedYield).to.equal(pluginYield);
    });

    it("should emit YieldReceived event", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      await expect(mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute())
        .to.emit(router, "YieldReceived")
        .withArgs(pluginId, await yieldAsset.getAddress(), yieldAmount, ethers.ZeroAddress, 0);
    });

    it("should be paused when paused", async function () {
      const adminRouter = router.connect(await ethers.getSigner(admin));
      await adminRouter.pause();

      // Ensure tokens and approval (needed even for revert tests)
      const yieldAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await expect(
        mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute()
      ).to.be.reverted; // Pausable uses custom error in OpenZeppelin v5
    });
  });

  describe("applyPolicy", function () {
    beforeEach(async function () {
      // Setup: route some yield first
      const yieldAmount = ethers.parseEther("1000");
      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();
    });

    it("should distribute yield according to splits", async function () {
      const accumulatedBefore = await router.getAccumulatedYield();
      expect(accumulatedBefore).to.be.gt(0);

      // Apply policy
      await router.applyPolicy();

      const accumulatedAfter = await router.getAccumulatedYield();
      expect(accumulatedAfter).to.equal(0);
    });

    it("should reject when no yield to distribute", async function () {
      // Apply policy once
      await router.applyPolicy();

      // Try again - should fail
      await expect(router.applyPolicy()).to.be.revertedWith("RevenueRouter: no yield to distribute");
    });

    it("should send yield to distributor when model is BUYBACK_ONLY (deprecated)", async function () {
      const distributorBalanceBefore = await treasuryAsset.balanceOf(await distributor.getAddress());
      await router.applyPolicy();
      const distributorBalanceAfter = await treasuryAsset.balanceOf(await distributor.getAddress());

      expect(distributorBalanceAfter).to.be.gt(distributorBalanceBefore);
    });

    it("should send staking rewards to distributor when model is STAKING_REWARDS", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));
      await govRouter.setDistributionModel(DistributionModel.STAKING_REWARDS);

      const distributorBalanceBefore = await treasuryAsset.balanceOf(await distributor.getAddress());
      await router.applyPolicy();
      const distributorBalanceAfter = await treasuryAsset.balanceOf(await distributor.getAddress());

      expect(distributorBalanceAfter).to.be.gt(distributorBalanceBefore);
    });

    it("should distribute using splits when model is HYBRID", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));
      await govRouter.setDistributionModel(DistributionModel.HYBRID);
      await govRouter.setDistributionSplits(7000, 2000, 1000);

      const distributorBefore = await treasuryAsset.balanceOf(await distributor.getAddress());
      const treasuryBefore = await treasuryAsset.balanceOf(await treasury.getAddress());

      await router.applyPolicy();

      const distributorAfter = await treasuryAsset.balanceOf(await distributor.getAddress());
      const treasuryAfter = await treasuryAsset.balanceOf(await treasury.getAddress());

      expect(distributorAfter).to.be.gt(distributorBefore);
      expect(treasuryAfter).to.be.gt(treasuryBefore);
    });

    it("should emit YieldApplied events", async function () {
      await expect(router.applyPolicy()).to.emit(router, "YieldApplied");
    });
  });

  describe("setDistributionSplits", function () {
    it("should update splits correctly", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await govRouter.setDistributionSplits(7000, 2000, 1000); // 70% buyback, 20% staker, 10% treasury

      expect(await router.buybackShareBps()).to.equal(7000);
      expect(await router.stakerShareBps()).to.equal(2000);
      expect(await router.treasuryShareBps()).to.equal(1000);
    });

    it("should reject splits that don't sum to 100%", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await expect(govRouter.setDistributionSplits(7000, 2000, 500)).to.be.revertedWith(
        "RevenueRouter: splits must sum to 100%"
      );
    });

    it("should reject treasury share > 30%", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await expect(govRouter.setDistributionSplits(6000, 500, 3500)).to.be.revertedWith(
        "RevenueRouter: treasury share exceeds max"
      );
    });

    it("should require timelock to reduce staker share to 0", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      // First set staker share > 0
      await govRouter.setDistributionSplits(8000, 2000, 0);

      // Try to reduce to 0 without timelock - should fail
      await expect(govRouter.setDistributionSplits(10000, 0, 0)).to.be.revertedWith(
        "RevenueRouter: staker share reduction requires timelock"
      );
    });

    it("should reject unauthorized calls", async function () {
      const userRouter = router.connect(await ethers.getSigner(pluginOwner));

      await expect(userRouter.setDistributionSplits(7000, 2000, 1000)).to.be.revertedWith(
        "RevenueRouter: unauthorized"
      );
    });
  });

  describe("setDistributionModel", function () {
    it("should update distribution model", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await govRouter.setDistributionModel(DistributionModel.STAKING_REWARDS);

      expect(await router.distributionModel()).to.equal(DistributionModel.STAKING_REWARDS);
    });

    it("should emit DistributionModelUpdated event", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await expect(govRouter.setDistributionModel(DistributionModel.STAKING_REWARDS))
        .to.emit(router, "DistributionModelUpdated")
        .withArgs(DistributionModel.BUYBACK_ONLY, DistributionModel.STAKING_REWARDS);
    });

    it("should reject unauthorized calls", async function () {
      const userRouter = router.connect(await ethers.getSigner(pluginOwner));

      await expect(userRouter.setDistributionModel(DistributionModel.STAKING_REWARDS)).to.be.revertedWith(
        "RevenueRouter: unauthorized"
      );
    });
  });

  describe("setTimelock", function () {
    it("should set timelock address", async function () {
      const adminRouter = router.connect(await ethers.getSigner(admin));
      const [timelockAccount] = await ethers.getSigners();

      await adminRouter.setTimelock(await timelockAccount.getAddress());

      expect(await router.timelock()).to.equal(await timelockAccount.getAddress());
    });

    it("should reject zero address", async function () {
      const adminRouter = router.connect(await ethers.getSigner(admin));

      await expect(adminRouter.setTimelock(ethers.ZeroAddress)).to.be.revertedWith(
        "RevenueRouter: zero timelock"
      );
    });

    it("should only allow setting once", async function () {
      const adminRouter = router.connect(await ethers.getSigner(admin));
      const [timelockAccount1, timelockAccount2] = await ethers.getSigners();

      await adminRouter.setTimelock(await timelockAccount1.getAddress());

      await expect(adminRouter.setTimelock(await timelockAccount2.getAddress())).to.be.revertedWith(
        "RevenueRouter: timelock already set"
      );
    });

    it("should reject unauthorized calls", async function () {
      const userRouter = router.connect(await ethers.getSigner(pluginOwner));
      const [timelockAccount] = await ethers.getSigners();

      await expect(userRouter.setTimelock(await timelockAccount.getAddress())).to.be.reverted;
    });
  });

  describe("Accounting Functions", function () {
    it("should return correct plugin yield", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYield = await router.getPluginYield(pluginId);
      expect(pluginYield).to.be.gt(0);
    });

    it("should return correct total yield", async function () {
      const yieldAmount = ethers.parseEther("1000");

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const totalYield = await router.getTotalYield();
      expect(totalYield).to.be.gt(0);
    });

    it("should return correct accumulated yield", async function () {
      const yieldAmount = ethers.parseEther("1000");

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const accumulatedYield = await router.getAccumulatedYield();
      expect(accumulatedYield).to.be.gt(0);
    });

    it("should return zero dev share for unregistered recipient", async function () {
      const [unregisteredRecipient] = await ethers.getSigners();
      const devShare = await router.getDevShareReceived(await unregisteredRecipient.getAddress());
      expect(devShare).to.equal(0);
    });
  });

  describe("Pause/Unpause", function () {
    it("should pause when called by admin", async function () {
      const adminRouter = router.connect(await ethers.getSigner(admin));
      await adminRouter.pause();

      expect(await router.paused()).to.be.true;
    });

    it("should unpause when called by admin", async function () {
      const adminRouter = router.connect(await ethers.getSigner(admin));
      await adminRouter.pause();
      await adminRouter.unpause();

      expect(await router.paused()).to.be.false;
    });

    it("should reject pause by non-admin", async function () {
      const userRouter = router.connect(await ethers.getSigner(pluginOwner));

      await expect(userRouter.pause()).to.be.reverted;
    });
  });
});
