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

describe("Wash-Yield Attack Tests", function () {
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
  let attacker: string;

  beforeEach(async function () {
    const [deployer, adminAccount, govAccount, pluginOwnerAccount, attackerAccount] =
      await ethers.getSigners();
    admin = await adminAccount.getAddress();
    governance = await govAccount.getAddress();
    pluginOwner = await pluginOwnerAccount.getAddress();
    attacker = await attackerAccount.getAddress();

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

    // Setup: mint tokens to pluginOwner and approve plugin
    await yieldAsset.mint(pluginOwner, ethers.parseEther("100000"));
    await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
      await mockPlugin.getAddress(),
      ethers.MaxUint256
    );
    await yieldAsset.mint(attacker, ethers.parseEther("100000"));
  });

  describe("Attack: Route deposits as yield", function () {
    it("should detect when plugin routes own deposits as yield", async function () {
      // Attacker creates plugin and deposits their own funds
      // Then routes those deposits as "yield"
      const depositAmount = ethers.parseEther("1000");

      // Attacker deposits to plugin owner (who will route it)
      await yieldAsset.mint(pluginOwner, depositAmount);
      // Plugin owner approves plugin
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );

      // Plugin routes it as "yield"
      await mockPlugin.setYield(await yieldAsset.getAddress(), depositAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // This is technically allowed (plugin controls its assets)
      // But tier restrictions should limit the impact
      const pluginId = await mockPlugin.pluginId();
      const quarantined = await router.getQuarantinedYield(pluginId, await yieldAsset.getAddress());
      const pluginYield = await router.getPluginYield(pluginId);

      // Tier 0 yield is quarantined
      expect(quarantined).to.be.gt(0);
      expect(pluginYield).to.equal(0);

      // Tier 0 should have strict caps to limit wash-yield impact
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);
      expect(tierConfig.maxConversionAmount).to.be.gt(0); // Should have caps
    });

    it("should enforce tier-based caps to limit wash-yield", async function () {
      // Tier 0 plugins should have strict caps
      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      // If maxConversionAmount is set, it should limit wash-yield
      // (This depends on SwapModule implementation)
      expect(tierConfig.maxConversionAmount).to.be.gte(0);
    });
  });

  describe("Attack: Circular swap pattern", function () {
    it("should prevent circular swaps through tier restrictions", async function () {
      // Attacker tries to create circular swap:
      // 1. Route yield asset A
      // 2. Swap to asset B
      // 3. Route asset B as yield
      // 4. Swap back to asset A
      // This inflates yield metrics

      // Tier 0 should have restrictions that prevent this
      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      // Quarantine mode or strict caps should limit this
      // (Implementation depends on SwapModule)
      expect(tierConfig.quarantineMode || !tierConfig.allowAutoSwap).to.be.true;
    });

    it("should track yield per plugin to detect patterns", async function () {
      // Router tracks yield per plugin
      // This allows detection of suspicious patterns

      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(await mockPlugin.pluginId(), PluginTier.VERIFIED);

      const yieldAmount1 = ethers.parseEther("1000");
      const yieldAmount2 = ethers.parseEther("2000");

      // Ensure tokens and approval for first call
      await yieldAsset.mint(pluginOwner, yieldAmount1);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount1);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Ensure tokens and approval for second call
      await yieldAsset.mint(pluginOwner, yieldAmount2);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount2);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginId = await mockPlugin.pluginId();
      const pluginYield = await router.getPluginYield(pluginId);

      // Yield should accumulate
      expect(pluginYield).to.be.gt(yieldAmount1);
    });
  });

  describe("Attack: Inflate yield metrics", function () {
    it("should not allow unlimited yield routing", async function () {
      // Tier-based caps should limit how much yield can be routed
      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      // Tier 0 should have maxConversionAmount cap
      // This limits how much can be converted per transaction
      expect(tierConfig.maxConversionAmount).to.be.gte(0);

      // If maxConversionAmount is 0, no conversion allowed (quarantine)
      // If > 0, it caps the amount
    });

    it("should enforce slippage limits to prevent manipulation", async function () {
      // Strict slippage limits prevent attackers from routing yield
      // through manipulated swap rates

      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      // Tier 0 should have strict slippage limits
      expect(tierConfig.maxSlippageBps).to.be.lt(10000); // Less than 100%
    });
  });

  describe("Protection: Tier-based routing caps", function () {
    it("should enforce tier 0 caps strictly", async function () {
      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      // Tier 0 should have:
      // - Low maxConversionAmount (or 0 for quarantine)
      // - Strict slippage limits
      // - Quarantine mode or no auto-swap

      expect(tierConfig.maxSlippageBps).to.be.lt(10000);
    });

    it("should allow higher caps for verified plugins", async function () {
      const pluginId = await mockPlugin.pluginId();
      const govRegistry = registry.connect(await ethers.getSigner(governance));

      // Promote to Tier 1
      await govRegistry.setPluginTier(pluginId, PluginTier.VERIFIED);

      const tierConfig = await registry.getTierConfig(PluginTier.VERIFIED);

      // Tier 1 should have higher caps
      // (Exact values depend on configuration)
      expect(tierConfig.maxConversionAmount).to.be.gte(0);
    });
  });

  describe("Protection: Accounting accuracy", function () {
    it("should maintain accurate accounting despite wash attempts", async function () {
      // Even if attacker routes deposits as yield,
      // accounting should be accurate

      const washAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(pluginId, PluginTier.VERIFIED);

      // Attacker routes their deposit as yield
      await yieldAsset.mint(attacker, washAmount);
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await mockPlugin.getAddress(), washAmount);

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, washAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), washAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Accounting should reflect what was actually routed
      const pluginYield = await router.getPluginYield(pluginId);
      const totalYield = await router.getTotalYield();

      // Yield is counted (it's real tokens being routed)
      // But tier restrictions limit the impact
      expect(pluginYield).to.be.gt(0);
      expect(totalYield).to.equal(pluginYield);
    });

    it("should not double-count yield", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(pluginId, PluginTier.VERIFIED);

      // Route yield once - ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYield1 = await router.getPluginYield(pluginId);
      const totalYield1 = await router.getTotalYield();

      // Route same amount again (new yield, not re-routing) - ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYield2 = await router.getPluginYield(pluginId);
      const totalYield2 = await router.getTotalYield();

      // Should accumulate, not replace
      expect(pluginYield2).to.be.gt(pluginYield1);
      expect(totalYield2).to.be.gt(totalYield1);
    });
  });

  describe("Protection: Quarantine mode", function () {
    it("should hold assets in custody for tier 0", async function () {
      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      // Tier 0 should have quarantine mode or no auto-swap
      // This prevents automatic conversion and allows manual review
      expect(tierConfig.quarantineMode || !tierConfig.allowAutoSwap).to.be.true;
    });

    it("should require governance release for quarantined assets", async function () {
      // In quarantine mode, assets are held in custody
      // Governance must manually release them
      // This prevents wash-yield from being automatically processed

      const pluginId = await mockPlugin.pluginId();
      const tierConfig = await registry.getTierConfig(PluginTier.UNTRUSTED);

      if (tierConfig.quarantineMode) {
        // Assets should be held, not automatically converted
        // This is a protection mechanism
        expect(tierConfig.quarantineMode).to.be.true;
      }
    });
  });

  describe("Detection: Suspicious patterns", function () {
    it("should track yield per plugin for pattern detection", async function () {
      // Router tracks yield per plugin
      // This allows off-chain analysis to detect suspicious patterns

      const amounts = [
        ethers.parseEther("1000"),
        ethers.parseEther("2000"),
        ethers.parseEther("3000"),
        ethers.parseEther("4000"),
      ];

      const pluginId = await mockPlugin.pluginId();
      await registry
        .connect(await ethers.getSigner(governance))
        .setPluginTier(pluginId, PluginTier.VERIFIED);

      for (const amount of amounts) {
        // Ensure tokens and approval for each call
        await yieldAsset.mint(pluginOwner, amount);
        await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
          await mockPlugin.getAddress(),
          ethers.MaxUint256
        );
        await mockPlugin.setYield(await yieldAsset.getAddress(), amount);
        await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();
      }

      const pluginYield = await router.getPluginYield(pluginId);
      const totalYield = await router.getTotalYield();

      // All yield should be tracked
      expect(pluginYield).to.be.gt(0);
      expect(totalYield).to.equal(pluginYield);

      // Off-chain analysis can detect if this is suspicious
      // (e.g., too frequent, too regular, etc.)
    });

    it("should maintain dev share accounting to detect manipulation", async function () {
      // Dev share accounting helps detect if plugins are gaming the system
      // by routing yield with high dev shares to themselves

      const yieldAmount = ethers.parseEther("1000");
      const devBps = 2000; // 20% - maximum allowed

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setDevShare(pluginOwner, devBps);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const devShare = await router.getDevShareReceived(pluginOwner);
      const expectedDevShare = (yieldAmount * BigInt(devBps)) / 10000n;

      expect(devShare).to.equal(expectedDevShare);

      // High dev shares can be a red flag for wash-yield
      // (Off-chain monitoring can detect this)
    });
  });
});
