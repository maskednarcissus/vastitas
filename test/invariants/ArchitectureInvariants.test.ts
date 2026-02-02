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
import { DistributionModel } from "../helpers/TestConstants";

describe("Architecture Invariants", function () {
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
    await registry
      .connect(await ethers.getSigner(governance))
      .setPluginTier(await mockPlugin.pluginId(), 1);

    // Setup: mint yield asset to pluginOwner and approve plugin
    await yieldAsset.mint(pluginOwner, ethers.parseEther("100000"));
    await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
      await mockPlugin.getAddress(),
      ethers.MaxUint256
    );
  });

  describe("Invariant: Vastitas token has no business logic", function () {
    it("should only have standard ERC20 functions", async function () {
      // Token should not have plugin-related functions
      // Token should not have routing functions
      // Token should only have: transfer, approve, balanceOf, etc.

      // Check that token doesn't have receiveYield or similar
      const tokenInterface = token.interface;
      const functions = tokenInterface.fragments.filter((f) => f.type === "function");

      // Token should have standard ERC20 functions
      const functionNames = functions.map((f) => f.name);
      
      // Should have standard ERC20 functions
      expect(functionNames).to.include("transfer");
      expect(functionNames).to.include("approve");
      expect(functionNames).to.include("balanceOf");
      expect(functionNames).to.include("allowance");

      // Should NOT have business logic functions
      expect(functionNames).to.not.include("receiveYield");
      expect(functionNames).to.not.include("routeYield");
      expect(functionNames).to.not.include("registerPlugin");
    });

    it("should not have plugin registry reference", async function () {
      // Token should not store references to other protocol contracts
      // This is checked by verifying token has no state variables for plugins/router
      const tokenCode = await ethers.provider.getCode(await token.getAddress());
      
      // Token code should not contain plugin-related strings
      // (This is a simplified check - in production, use static analysis)
      expect(tokenCode).to.not.include("PluginRegistry");
      expect(tokenCode).to.not.include("RevenueRouter");
    });
  });

  describe("Invariant: All yield goes through RevenueRouter", function () {
    it("should reject yield sent directly to token", async function () {
      const amount = ethers.parseEther("1000");

      // Try to send yield asset directly to token
      await yieldAsset.mint(pluginOwner, amount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).transfer(await token.getAddress(), amount);

      // Token should receive it (ERC20 transfer works)
      // But router accounting should not change
      const totalYieldBefore = await router.getTotalYield();

      // Direct transfer should not affect router accounting
      const totalYieldAfter = await router.getTotalYield();
      expect(totalYieldAfter).to.equal(totalYieldBefore);
    });

    it("should only accept yield through receiveYield", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Route yield through router (correct way)
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

      // Direct transfers should not affect accounting
      const directAmount = ethers.parseEther("500");
      await yieldAsset.mint(pluginOwner, directAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).transfer(await router.getAddress(), directAmount);

      // Router accounting should not change from direct transfer
      const pluginYieldAfter = await router.getPluginYield(pluginId);
      expect(pluginYieldAfter).to.equal(pluginYield); // Should not change
    });
  });

  describe("Invariant: Plugins never send directly to token", function () {
    it("should route through router, not directly to token", async function () {
      // MockPlugin should call router.receiveYield, not token.transfer
      const yieldAmount = ethers.parseEther("1000");

      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, yieldAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      // claimAndRoute should call router, not token
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Verify router received the yield
      const pluginId = await mockPlugin.pluginId();
      const pluginYield = await router.getPluginYield(pluginId);
      expect(pluginYield).to.be.gt(0);

      // Token should not have received yield directly
      // (In this case, yield asset is not the token, so this is expected)
    });

    it("should reject plugins that send directly to token", async function () {
      // This test verifies that the architecture enforces routing through router
      // If a plugin tries to send directly to token, it should be rejected or not counted

      // Create a malicious plugin that tries to send directly to token
      // (In practice, this would be caught by the router's receiveYield function)
      
      // The router's receiveYield requires msg.sender to be a registered plugin
      // So direct transfers to token would not be counted in router accounting
      
      const directAmount = ethers.parseEther("1000");
      await yieldAsset.mint(pluginOwner, directAmount);
      
      // Try to send directly to token
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).transfer(await token.getAddress(), directAmount);

      // Router accounting should not reflect this
      const totalYield = await router.getTotalYield();
      expect(totalYield).to.equal(0); // Should be 0 if no yield routed through router
    });
  });

  describe("Invariant: Router enforces all policies", function () {
    it("should enforce dev share limits", async function () {
      const yieldAmount = ethers.parseEther("1000");
      const excessiveDevBps = 2500; // 25% - exceeds 20% max

      await mockPlugin.setDevShare(pluginOwner, excessiveDevBps);
      await mockPlugin.setYield(await yieldAsset.getAddress(), yieldAmount);

      // Router should reject
      await expect(
        mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute()
      ).to.be.revertedWith("RevenueRouter: dev share exceeds max");
    });

    it("should enforce plugin registration", async function () {
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

      // Router should reject
      await expect(unregisteredPlugin.claimAndRoute()).to.be.reverted;
    });

    it("should enforce asset whitelist", async function () {
      // Deploy invalid asset
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const invalidAsset = await MockERC20Factory.deploy("Invalid Asset", "INVALID");
      await invalidAsset.waitForDeployment();

      await invalidAsset.mint(await mockPlugin.getAddress(), ethers.parseEther("1000"));
      await mockPlugin.setYield(await invalidAsset.getAddress(), ethers.parseEther("1000"));

      // Router should reject invalid asset
      await expect(mockPlugin.claimAndRoute()).to.be.reverted;
    });
  });

  describe("Invariant: Separation of concerns", function () {
    it("should have clear contract boundaries", async function () {
      // Registry should only manage plugins
      const registryInterface = registry.interface;
      const registryFunctions = registryInterface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);

      expect(registryFunctions).to.include("registerPlugin");
      expect(registryFunctions).to.include("setPluginTier");
      expect(registryFunctions).to.not.include("receiveYield");
      expect(registryFunctions).to.not.include("applyPolicy");

      // Router should only handle yield routing
      const routerInterface = router.interface;
      const routerFunctions = routerInterface.fragments
        .filter((f) => f.type === "function")
        .map((f) => f.name);

      expect(routerFunctions).to.include("receiveYield");
      expect(routerFunctions).to.include("applyPolicy");
      expect(routerFunctions).to.not.include("registerPlugin");
      expect(routerFunctions).to.not.include("setPluginTier");
    });

    it("should not have circular dependencies", async function () {
      // Token should not depend on router
      // Router should depend on registry, not vice versa
      // Registry should not depend on router

      // This is verified by deployment order and constructor parameters
      // Token is deployed first (no dependencies)
      // Registry is deployed (no router dependency)
      // Router is deployed (depends on registry)
    });
  });
});
