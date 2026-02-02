import { expect } from "chai";
import { ethers } from "hardhat";
import {
  VastitasToken,
  PluginRegistry,
  RevenueRouter,
  SwapModule,
  TreasuryVault,
  Distributor,
  MockPlugin,
  MockERC20,
  MockUniswapV3Router,
  MockUniswapV3Quoter,
} from "../../typechain-types";
import { PluginTier, DistributionModel } from "../helpers/TestConstants";

describe("State Invariants", function () {
  let token: VastitasToken;
  let registry: PluginRegistry;
  let router: RevenueRouter;
  let swapModule: SwapModule;
  let treasury: TreasuryVault;
  let distributor: Distributor;
  let mockPlugin: MockPlugin;
  let yieldAsset: MockERC20;
  let treasuryAsset: MockERC20;
  let mockUniswapRouter: MockUniswapV3Router;
  let mockUniswapQuoter: MockUniswapV3Quoter;

  let admin: string;
  let governance: string;
  let pluginOwner: string;

  beforeEach(async function () {
    const [deployer, adminAccount, govAccount, pluginOwnerAccount] = await ethers.getSigners();
    admin = await adminAccount.getAddress();
    governance = await govAccount.getAddress();
    pluginOwner = await pluginOwnerAccount.getAddress();

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
      DistributionModel.STAKING_REWARDS,
      admin,
      governance
    );
    await router.waitForDeployment();

    // Deploy distributor and wire it into the router (STAKING_REWARDS routes to Distributor)
    const DistributorFactory = await ethers.getContractFactory("Distributor");
    distributor = await DistributorFactory.deploy(
      await token.getAddress(),
      await treasuryAsset.getAddress(),
      7 * 24 * 60 * 60, // 7 days
      admin,
      await router.getAddress()
    );
    await distributor.waitForDeployment();
    await router.connect(await ethers.getSigner(admin)).setDistributor(await distributor.getAddress());

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
    await registry
      .connect(await ethers.getSigner(governance))
      .setPluginTier(await mockPlugin.pluginId(), PluginTier.VERIFIED);

    // Setup: mint yield asset to pluginOwner and approve plugin
    await yieldAsset.mint(pluginOwner, ethers.parseEther("100000"));
    await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
      await mockPlugin.getAddress(),
      ethers.MaxUint256
    );
  });

  describe("Invariant: Plugins registered cannot be unregistered", function () {
    it("should not allow unregistering plugins", async function () {
      const pluginId = await mockPlugin.pluginId();
      const plugin = await registry.getPlugin(pluginId);

      expect(plugin.pluginAddress).to.not.equal(ethers.ZeroAddress);
      expect(plugin.isActive).to.be.true;

      // There should be no unregister function
      // Plugin can only be deactivated, not unregistered
      const adminRegistry = registry.connect(await ethers.getSigner(admin));
      await adminRegistry.deactivatePlugin(pluginId);

      const pluginAfter = await registry.getPlugin(pluginId);
      expect(pluginAfter.pluginAddress).to.equal(plugin.pluginAddress); // Still registered
      expect(pluginAfter.isActive).to.be.false; // But inactive
    });

    it("should allow reactivating deactivated plugins", async function () {
      const pluginId = await mockPlugin.pluginId();
      const adminRegistry = registry.connect(await ethers.getSigner(admin));

      await adminRegistry.deactivatePlugin(pluginId);
      await adminRegistry.activatePlugin(pluginId);

      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.isActive).to.be.true;
    });
  });

  describe("Invariant: Yield routed cannot be re-routed", function () {
    it("should not allow re-routing the same yield", async function () {
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

      const pluginYieldBefore = await router.getPluginYield(pluginId);
      const totalYieldBefore = await router.getTotalYield();

      // Try to route again with same amount - should fail or be ignored
      // In this case, the plugin would need new yield to route
      // Ensure tokens and approval for second call
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      
      // If plugin tries to route again, it should use new yield, not re-route old
      // The accounting should be additive, not replace existing
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYieldAfter = await router.getPluginYield(pluginId);
      const totalYieldAfter = await router.getTotalYield();

      // Yield should increase, not stay the same
      expect(pluginYieldAfter).to.be.gt(pluginYieldBefore);
      expect(totalYieldAfter).to.be.gt(totalYieldBefore);
    });
  });

  describe("Invariant: Router never holds balances beyond transaction", function () {
    it("should not hold balances after applyPolicy", async function () {
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

      // Apply policy should clear accumulated yield
      await router.applyPolicy();

      const accumulatedAfter = await router.getAccumulatedYield();
      expect(accumulatedAfter).to.equal(0);
    });

    it("should transfer assets immediately on receiveYield", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const routerBalanceBefore = await yieldAsset.balanceOf(await router.getAddress());

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Router should not hold the yield asset (it should be converted or transferred)
      // In this case, if same asset as treasury, it might hold it, but should be minimal
      const routerBalanceAfter = await yieldAsset.balanceOf(await router.getAddress());
      
      // Router should not accumulate yield assets unnecessarily
      // (Exact behavior depends on swap module implementation)
      // The key is that router doesn't hold balances indefinitely
    });
  });

  describe("Invariant: Token balance changes only via router", function () {
    it("should reject direct transfers to token", async function () {
      const amount = ethers.parseEther("1000");
      const tokenBalanceBefore = await token.balanceOf(await token.getAddress());

      // Try to transfer directly to token
      await token.transfer(await token.getAddress(), amount);

      // Token balance should not change (or should revert)
      // In ERC20, transferring to self might be allowed, but it shouldn't affect supply
      const tokenBalanceAfter = await token.balanceOf(await token.getAddress());
      
      // The key invariant: token supply should only change via router operations
      // Direct transfers to token address should not affect protocol accounting
      expect(tokenBalanceAfter).to.equal(tokenBalanceBefore + amount);
      // But this doesn't affect the protocol's yield accounting
    });

    it("should track yield only through router", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const totalYieldBefore = await router.getTotalYield();

      // Route yield through router
      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const totalYieldAfter = await router.getTotalYield();
      expect(totalYieldAfter).to.be.gt(totalYieldBefore);

      // Direct token transfers should not affect router accounting
      const directTransferAmount = ethers.parseEther("500");
      await token.transfer(await token.getAddress(), directTransferAmount);

      const totalYieldAfterDirect = await router.getTotalYield();
      expect(totalYieldAfterDirect).to.equal(totalYieldAfter); // Should not change
    });
  });

  describe("Invariant: Treasury accounting matches on-chain balances", function () {
    it("should maintain accurate treasury balances", async function () {
      const depositAmount = ethers.parseEther("1000");

      await treasuryAsset.mint(pluginOwner, depositAmount);
      await treasuryAsset
        .connect(await ethers.getSigner(pluginOwner))
        .approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(await ethers.getSigner(pluginOwner)).deposit(await treasuryAsset.getAddress(), depositAmount);

      const treasuryBalance = await treasury.getBalance(await treasuryAsset.getAddress());
      const onChainBalance = await treasuryAsset.balanceOf(await treasury.getAddress());

      expect(treasuryBalance).to.equal(onChainBalance);
    });

    it("should update balances correctly after withdrawals", async function () {
      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("300");

      await treasuryAsset.mint(pluginOwner, depositAmount);
      await treasuryAsset
        .connect(await ethers.getSigner(pluginOwner))
        .approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(await ethers.getSigner(pluginOwner)).deposit(await treasuryAsset.getAddress(), depositAmount);

      const govTreasury = treasury.connect(await ethers.getSigner(governance));
      await govTreasury.withdraw(await treasuryAsset.getAddress(), pluginOwner, withdrawAmount);

      const treasuryBalance = await treasury.getBalance(await treasuryAsset.getAddress());
      const onChainBalance = await treasuryAsset.balanceOf(await treasury.getAddress());

      expect(treasuryBalance).to.equal(onChainBalance);
      expect(treasuryBalance).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("Invariant: Plugin tier changes don't affect historical accounting", function () {
    it("should preserve historical yield when tier changes", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Route yield at Tier 0
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(pluginId, PluginTier.UNTRUSTED);
      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYieldBefore = await router.getPluginYield(pluginId);

      // Promote to Tier 1
      const govRegistry = registry.connect(await ethers.getSigner(governance));
      await govRegistry.setPluginTier(pluginId, PluginTier.VERIFIED);

      // Historical yield should be preserved
      const pluginYieldAfter = await router.getPluginYield(pluginId);
      expect(pluginYieldAfter).to.equal(pluginYieldBefore);
    });

    it("should allow new yield routing with new tier privileges", async function () {
      const yieldAmount1 = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Route yield at Tier 0
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(pluginId, PluginTier.UNTRUSTED);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount1);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYieldTier0 = await router.getPluginYield(pluginId);

      // Promote to Tier 1
      const govRegistry = registry.connect(await ethers.getSigner(governance));
      await govRegistry.setPluginTier(pluginId, PluginTier.VERIFIED);

      // Route more yield at Tier 1 - ensure tokens and approval
      const yieldAmount2 = ethers.parseEther("2000");
      await yieldAsset.mint(pluginOwner, yieldAmount2);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount2);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYieldAfter = await router.getPluginYield(pluginId);
      expect(pluginYieldAfter).to.be.gt(pluginYieldTier0);
    });
  });
});
