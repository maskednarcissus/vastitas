import { expect } from "chai";
import { ethers } from "hardhat";
import {
  EmergencyCouncil,
  PluginRegistry,
  RevenueRouter,
  SwapModule,
  MockPlugin,
} from "../../typechain-types";

describe("EmergencyCouncil - Governance Tests", function () {
  let council: EmergencyCouncil;
  let registry: PluginRegistry;
  let router: RevenueRouter;
  let swapModule: SwapModule;
  let mockPlugin: MockPlugin;

  let admin: string;
  let councilMember1: string;
  let councilMember2: string;
  let user: string;

  beforeEach(async function () {
    const [
      deployer,
      adminAccount,
      councilMember1Account,
      councilMember2Account,
      userAccount,
    ] = await ethers.getSigners();

    admin = await adminAccount.getAddress();
    councilMember1 = await councilMember1Account.getAddress();
    councilMember2 = await councilMember2Account.getAddress();
    user = await userAccount.getAddress();

    // Deploy registry
    const RegistryFactory = await ethers.getContractFactory("PluginRegistry");
    registry = await RegistryFactory.deploy(admin, admin);
    await registry.waitForDeployment();

    // Deploy tokens for swap module
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const treasuryAsset = await MockERC20Factory.deploy("Treasury Asset", "TREASURY");
    await treasuryAsset.waitForDeployment();

    // Deploy token and treasury
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    const token = await TokenFactory.deploy(
      "Vastitas",
      "Vastitas",
      ethers.parseEther("1000000000"),
      deployer.address,
      deployer.address
    );
    await token.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
    const treasury = await TreasuryFactory.deploy(admin, admin);
    await treasury.waitForDeployment();

    // Deploy swap module
    const SwapModuleFactory = await ethers.getContractFactory("SwapModule");
    swapModule = await SwapModuleFactory.deploy(
      await treasuryAsset.getAddress(),
      ethers.ZeroAddress, // router
      ethers.ZeroAddress, // uniswap router
      admin
    );
    await swapModule.waitForDeployment();

    // Deploy router (simplified for testing)
    const RouterFactory = await ethers.getContractFactory("RevenueRouter");
    router = await RouterFactory.deploy(
      await registry.getAddress(),
      await swapModule.getAddress(),
      await token.getAddress(), // token (must be non-zero)
      await treasury.getAddress(), // treasury (must be non-zero)
      0, // distribution model
      admin,
      admin
    );
    await router.waitForDeployment();

    // Deploy emergency council
    const CouncilFactory = await ethers.getContractFactory("EmergencyCouncil");
    council = await CouncilFactory.deploy(
      await registry.getAddress(),
      await router.getAddress(),
      await swapModule.getAddress(),
      [councilMember1, councilMember2]
    );
    await council.waitForDeployment();

    // Grant ADMIN_ROLE to EmergencyCouncil on PluginRegistry so it can quarantine plugins
    // Use adminAccount (which has DEFAULT_ADMIN_ROLE) to grant the role
    await registry.connect(adminAccount).grantRole(
      await registry.ADMIN_ROLE(),
      await council.getAddress()
    );

    // Grant DEFAULT_ADMIN_ROLE to admin on EmergencyCouncil for management functions
    await council.grantRole(
      await council.DEFAULT_ADMIN_ROLE(),
      admin
    );

    // Deploy mock plugin
    const pluginId = ethers.id("test-plugin");
    const MockPluginFactory = await ethers.getContractFactory("MockPlugin");
    mockPlugin = await MockPluginFactory.deploy(
      pluginId,
      [ethers.ZeroAddress],
      await router.getAddress()
    );
    await mockPlugin.waitForDeployment();

    // Register plugin
    await registry.registerPlugin(await mockPlugin.getAddress());
  });

  describe("Council Powers", function () {
    it("should allow council to pause swaps", async function () {
      const councilMember1Signer = await ethers.getSigner(councilMember1);
      await expect(council.connect(councilMember1Signer).pauseSwaps())
        .to.emit(council, "SwapPaused")
        .withArgs(councilMember1);
    });

    it("should allow council to unpause swaps", async function () {
      const councilMember1Signer = await ethers.getSigner(councilMember1);
      await council.connect(councilMember1Signer).pauseSwaps();
      await expect(council.connect(councilMember1Signer).unpauseSwaps())
        .to.emit(council, "SwapUnpaused")
        .withArgs(councilMember1);
    });

    it("should allow council to quarantine plugin", async function () {
      const pluginId = await mockPlugin.pluginId();
      const councilMember1Signer = await ethers.getSigner(councilMember1);

      await expect(council.connect(councilMember1Signer).quarantinePlugin(pluginId))
        .to.emit(council, "PluginQuarantined")
        .withArgs(pluginId, councilMember1);

      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.isActive).to.be.false;
    });

    it("should allow council to unquarantine plugin", async function () {
      const pluginId = await mockPlugin.pluginId();
      const councilMember1Signer = await ethers.getSigner(councilMember1);

      await council.connect(councilMember1Signer).quarantinePlugin(pluginId);
      await expect(council.connect(councilMember1Signer).unquarantinePlugin(pluginId))
        .to.emit(council, "PluginUnquarantined")
        .withArgs(pluginId, councilMember1);

      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.isActive).to.be.true;
    });

    it("should reject non-council member actions", async function () {
      const pluginId = await mockPlugin.pluginId();
      const userSigner = await ethers.getSigner(user);

      await expect(
        council.connect(userSigner).pauseSwaps()
      ).to.be.reverted;

      await expect(
        council.connect(userSigner).quarantinePlugin(pluginId)
      ).to.be.reverted;
    });
  });

  describe("Council Management", function () {
    it("should allow admin to add council member", async function () {
      const [_, __, ___, ____, _____, newMemberAccount] = await ethers.getSigners();
      const newMember = await newMemberAccount.getAddress();
      const adminSigner = await ethers.getSigner(admin);

      await council.connect(adminSigner).addCouncilMember(newMember);
      
      // Verify member has role
      const councilMemberRole = await council.COUNCIL_MEMBER_ROLE();
      expect(await council.hasRole(councilMemberRole, newMember)).to.be.true;
    });

    it("should allow admin to remove council member", async function () {
      const adminSigner = await ethers.getSigner(admin);

      await council.connect(adminSigner).removeCouncilMember(councilMember1);
      
      const councilMemberRole = await council.COUNCIL_MEMBER_ROLE();
      expect(await council.hasRole(councilMemberRole, councilMember1)).to.be.false;
    });

    it("should reject non-admin council management", async function () {
      const userSigner = await ethers.getSigner(user);
      const [_, __, ___, ____, _____, newMemberAccount] = await ethers.getSigners();
      const newMember = await newMemberAccount.getAddress();

      await expect(
        council.connect(userSigner).addCouncilMember(newMember)
      ).to.be.reverted;

      await expect(
        council.connect(userSigner).removeCouncilMember(councilMember1)
      ).to.be.reverted;
    });
  });
});
