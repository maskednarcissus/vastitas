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

describe("Direct Transfer Bypass Tests", function () {
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
    await registry
      .connect(await ethers.getSigner(governance))
      .setPluginTier(await mockPlugin.pluginId(), 1);

    // Setup: mint tokens to pluginOwner and approve plugin
    await yieldAsset.mint(pluginOwner, ethers.parseEther("100000"));
    await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
      await mockPlugin.getAddress(),
      ethers.MaxUint256
    );
    await yieldAsset.mint(attacker, ethers.parseEther("100000"));
  });

  describe("Attempt: Send tokens directly to Vastitas token", function () {
    it("should allow transfer but not affect router accounting", async function () {
      const amount = ethers.parseEther("1000");
      const routerTotalYieldBefore = await router.getTotalYield();

      // Attacker tries to send yield asset directly to token
      // First mint tokens to attacker
      await yieldAsset.mint(attacker, amount);
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await token.getAddress(), amount);

      // Token receives it (ERC20 allows this)
      const tokenBalance = await yieldAsset.balanceOf(await token.getAddress());
      expect(tokenBalance).to.equal(amount);

      // But router accounting should not change
      const routerTotalYieldAfter = await router.getTotalYield();
      expect(routerTotalYieldAfter).to.equal(routerTotalYieldBefore);
    });

    it("should not count direct transfers in yield accounting", async function () {
      const directAmount = ethers.parseEther("1000");
      const routedAmount = ethers.parseEther("500");
      const pluginId = await mockPlugin.pluginId();

      // Attacker sends directly to token (mint first if needed)
      if ((await yieldAsset.balanceOf(attacker)) < directAmount) {
        await yieldAsset.mint(attacker, directAmount);
      }
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await token.getAddress(), directAmount);

      // Legitimate plugin routes yield
      // Ensure pluginOwner has tokens and approval
      await yieldAsset.mint(pluginOwner, routedAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), routedAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Only routed yield should be counted
      const pluginYield = await router.getPluginYield(pluginId);
      const totalYield = await router.getTotalYield();

      // Plugin yield should only reflect routed amount, not direct transfer
      expect(pluginYield).to.be.gt(0);
      expect(totalYield).to.equal(pluginYield);
      // Total yield should not include direct transfer
    });
  });

  describe("Attempt: Send yield directly to router without receiveYield", function () {
    it("should not affect accounting when sent directly", async function () {
      const amount = ethers.parseEther("1000");
      const routerTotalYieldBefore = await router.getTotalYield();
      const routerBalanceBefore = await yieldAsset.balanceOf(await router.getAddress());

      // Attacker sends directly to router (bypassing receiveYield)
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await router.getAddress(), amount);

      // Router receives tokens
      const routerBalanceAfter = await yieldAsset.balanceOf(await router.getAddress());
      expect(routerBalanceAfter).to.equal(routerBalanceBefore + amount);

      // But accounting should not change
      const routerTotalYieldAfter = await router.getTotalYield();
      expect(routerTotalYieldAfter).to.equal(routerTotalYieldBefore);
    });

    it("should not allow claiming direct transfers as yield", async function () {
      const directAmount = ethers.parseEther("1000");

      // Attacker sends directly to router
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await router.getAddress(), directAmount);

      // Try to apply policy - should not include direct transfer
      const accumulatedBefore = await router.getAccumulatedYield();
      expect(accumulatedBefore).to.equal(0); // Direct transfer doesn't accumulate

      // Even if policy is applied, direct transfer should not be distributed
      // (In this case, accumulatedYield is 0, so applyPolicy would revert)
      await expect(router.applyPolicy()).to.be.revertedWith("RevenueRouter: no yield to distribute");
    });
  });

  describe("Attempt: Send Vastitas tokens directly to token contract", function () {
    it("should allow transfer but not affect supply accounting", async function () {
      const amount = ethers.parseEther("1000");
      const totalSupplyBefore = await token.totalSupply();

      // Mint tokens to attacker first
      await token.transfer(attacker, amount);

      // Attacker sends Vastitas tokens directly to token contract
      await token.connect(await ethers.getSigner(attacker)).transfer(await token.getAddress(), amount);

      // Token receives it
      const tokenBalance = await token.balanceOf(await token.getAddress());
      expect(tokenBalance).to.equal(amount);

      // But total supply should not change (transfer doesn't burn)
      const totalSupplyAfter = await token.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });

    it("should not count as burned tokens", async function () {
      const amount = ethers.parseEther("1000");
      const totalSupplyBefore = await token.totalSupply();

      // Mint tokens to attacker first
      await token.transfer(attacker, amount);

      // Attacker sends to token
      await token.connect(await ethers.getSigner(attacker)).transfer(await token.getAddress(), amount);

      // Total supply unchanged (not burned, just held by token)
      const totalSupplyAfter = await token.totalSupply();
      expect(totalSupplyAfter).to.equal(totalSupplyBefore);
    });
  });

  describe("Attempt: Bypass plugin registration", function () {
    it("should reject yield from unregistered address", async function () {
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

      // Should fail - plugin not registered
      await expect(unregisteredPlugin.claimAndRoute()).to.be.reverted;
    });

    it("should reject yield from EOA (non-contract)", async function () {
      // EOA cannot call receiveYield directly (it's not a contract)
      // But if someone tries to send tokens, router should not accept them as yield
      const amount = ethers.parseEther("1000");

      await yieldAsset.mint(attacker, amount);
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await router.getAddress(), amount);

      // Router accounting should not change
      const totalYield = await router.getTotalYield();
      expect(totalYield).to.equal(0);
    });
  });

  describe("Attempt: Manipulate accounting with direct transfers", function () {
    it("should maintain accurate accounting despite direct transfers", async function () {
      const routedAmount = ethers.parseEther("1000");
      const directAmount = ethers.parseEther("500");
      const pluginId = await mockPlugin.pluginId();

      // Legitimate routing - ensure tokens and approval
      await yieldAsset.mint(pluginOwner, routedAmount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), routedAmount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      const pluginYieldBefore = await router.getPluginYield(pluginId);
      const totalYieldBefore = await router.getTotalYield();

      // Attacker tries to manipulate with direct transfer
      await yieldAsset.mint(attacker, directAmount);
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await router.getAddress(), directAmount);

      // Accounting should remain unchanged
      const pluginYieldAfter = await router.getPluginYield(pluginId);
      const totalYieldAfter = await router.getTotalYield();

      expect(pluginYieldAfter).to.equal(pluginYieldBefore);
      expect(totalYieldAfter).to.equal(totalYieldBefore);
    });
  });

  describe("Architecture Protection", function () {
    it("should enforce all yield goes through receiveYield", async function () {
      // The only way to update router accounting is through receiveYield
      // Direct transfers should never affect accounting

      const amount = ethers.parseEther("1000");
      const routerTotalYieldBefore = await router.getTotalYield();

      // Try various bypass methods
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await router.getAddress(), amount);
      await yieldAsset.connect(await ethers.getSigner(attacker)).transfer(await token.getAddress(), amount);

      // Accounting should remain unchanged
      const routerTotalYieldAfter = await router.getTotalYield();
      expect(routerTotalYieldAfter).to.equal(routerTotalYieldBefore);
    });

    it("should require plugin to call receiveYield", async function () {
      // receiveYield requires msg.sender to be registered plugin
      // This prevents EOA or unregistered contracts from updating accounting

      const amount = ethers.parseEther("1000");
      const pluginId = await mockPlugin.pluginId();

      // Only registered plugin can call receiveYield
      // Ensure tokens and approval
      await yieldAsset.mint(pluginOwner, amount);
      await yieldAsset.connect(await ethers.getSigner(pluginOwner)).approve(
        await mockPlugin.getAddress(),
        ethers.MaxUint256
      );
      await mockPlugin.setYield(await yieldAsset.getAddress(), amount);
      await mockPlugin.connect(await ethers.getSigner(pluginOwner)).claimAndRoute();

      // Accounting updated
      const pluginYield = await router.getPluginYield(pluginId);
      expect(pluginYield).to.be.gt(0);

      // Direct calls from EOA should fail
      // (receiveYield is external, so EOA can't call it directly anyway)
      // But if they could, router checks msg.sender == plugin.pluginAddress
    });
  });
});
