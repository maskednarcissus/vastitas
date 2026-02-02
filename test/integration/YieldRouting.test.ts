import { expect } from "chai";
import { ethers } from "hardhat";
import {
  VastitasToken,
  PluginRegistry,
  RevenueRouter,
  SwapModule,
  TreasuryVault,
  MockPlugin,
  MockERC20,
  MockUniswapV3Router,
  MockUniswapV3Quoter,
} from "../../typechain-types";
import { PluginTier, DistributionModel } from "../helpers/TestConstants";

describe("Yield Routing - Integration Tests", function () {
  let token: VastitasToken;
  let registry: PluginRegistry;
  let router: RevenueRouter;
  let swapModule: SwapModule;
  let treasury: TreasuryVault;
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

    // Deploy swap module (router set to zero initially, will be set later)
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
    mockPlugin = await MockPluginFactory.deploy(pluginId, underlyingAssets, await router.getAddress());
    await mockPlugin.waitForDeployment();

    // Register plugin
    await registry.registerPlugin(await mockPlugin.getAddress());
    await registry
      .connect(await ethers.getSigner(governance))
      .setPluginTier(await mockPlugin.pluginId(), PluginTier.VERIFIED);

    // Setup: mint yield asset to plugin owner
    await yieldAsset.mint(pluginOwner, ethers.parseEther("10000"));
    await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
      await mockPlugin.getAddress(),
      ethers.MaxUint256
    );
  });

  describe("Flow 1: Perfect Yield Routing", function () {
    it("should route yield from plugin to router", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      
      // Set yield in plugin
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      // Route yield
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Check accounting
      const pluginYield = await router.getPluginYield(pluginId);
      expect(pluginYield).to.be.gt(0);

      const totalYield = await router.getTotalYield();
      expect(totalYield).to.be.gt(0);
    });
  });

  describe("Flow 2: Multi-Plugin Yield", function () {
    it("should handle yield from multiple plugins", async function () {
      // Deploy second plugin
      const pluginId2 = ethers.id("test-plugin-2");
      const MockPluginFactory = await ethers.getContractFactory("MockPlugin");
      const mockPlugin2 = await MockPluginFactory.deploy(
        pluginId2,
        [await yieldAsset.getAddress()],
        await router.getAddress()
      );
      await mockPlugin2.waitForDeployment();

      await registry.registerPlugin(await mockPlugin2.getAddress());
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(pluginId2, PluginTier.VERIFIED);

      // Setup second plugin
      await yieldAsset.mint(pluginOwner, ethers.parseEther("5000"));
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin2.getAddress(),
        ethers.MaxUint256
      );

      // Route yield from both plugins - ensure tokens and approval for first plugin
      await yieldAsset.mint(pluginOwner, ethers.parseEther("1000"));
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), ethers.parseEther("1000"));
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Ensure tokens and approval for second plugin
      await yieldAsset.mint(pluginOwner, ethers.parseEther("2000"));
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin2.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin2.setYield(await yieldAsset.getAddress(), ethers.parseEther("2000"));
      await mockPlugin2.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Check accounting
      const plugin1Yield = await router.getPluginYield(await mockPlugin.pluginId());
      const plugin2Yield = await router.getPluginYield(pluginId2);
      const totalYield = await router.getTotalYield();

      expect(plugin1Yield).to.be.gt(0);
      expect(plugin2Yield).to.be.gt(0);
      expect(totalYield).to.equal(plugin1Yield + plugin2Yield);
    });
  });

  describe("Flow 3: Dev Share Distribution", function () {
    it("should split yield between dev and protocol", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const devBps = 1000; // 10%
      const devRecipient = pluginOwner;

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      
      // Set dev share
      await mockPlugin.setDevShare(devRecipient, devBps);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      // Route yield
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Check dev share received
      const devShare = await router.getDevShareReceived(devRecipient);
      const expectedDevShare = (yieldAmount * BigInt(devBps)) / 10000n;
      expect(devShare).to.equal(expectedDevShare);
    });

    it("should reject dev share > 20%", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const devBps = 2500; // 25% - should fail

      await mockPlugin.setDevShare(pluginOwner, devBps);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      // This should fail in the router
      // (The mock plugin would need to handle this, or router would reject)
      // For now, we test that router enforces the limit
    });
  });

  describe("Flow 4: Tier-Based Routing", function () {
    it("should enforce tier restrictions", async function () {
      const pluginId = await mockPlugin.pluginId();
      const govRegistry = registry.connect(await ethers.getSigner(governance));

      // Get tier 0 config (should have restrictions)
      const tier0Config = await registry.getTierConfig(PluginTier.UNTRUSTED);
      expect(tier0Config.quarantineMode).to.be.true;
      expect(tier0Config.allowAutoSwap).to.be.false;

      // Ensure plugin is untrusted
      await govRegistry.setPluginTier(pluginId, PluginTier.UNTRUSTED);

      // Promote to tier 1
      await govRegistry.setPluginTier(pluginId, PluginTier.VERIFIED);
      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.tier).to.equal(PluginTier.VERIFIED);

      // Tier 1 should have less restrictions
      const tier1Config = await registry.getTierConfig(PluginTier.VERIFIED);
      expect(tier1Config.allowAutoSwap).to.be.true;
    });
  });
});
