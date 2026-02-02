import { expect } from "chai";
import { ethers } from "hardhat";
import { PluginRegistry, MockPlugin } from "../../typechain-types";
import { PluginTier } from "../helpers/TestConstants";

describe("PluginRegistry - Unit Tests", function () {
  let registry: PluginRegistry;
  let mockPlugin: MockPlugin;
  let admin: string;
  let governance: string;
  let user: string;

  beforeEach(async function () {
    const [deployer, adminAccount, govAccount, userAccount] = await ethers.getSigners();
    admin = await adminAccount.getAddress();
    governance = await govAccount.getAddress();
    user = await userAccount.getAddress();

    const RegistryFactory = await ethers.getContractFactory("PluginRegistry");
    registry = await RegistryFactory.deploy(admin, governance);
    await registry.waitForDeployment();

    // Deploy mock plugin
    const pluginId = ethers.id("test-plugin-1");
    const underlyingAssets = [ethers.ZeroAddress]; // Will be set properly in tests
    const routerAddress = await registry.getAddress(); // Placeholder

    const MockPluginFactory = await ethers.getContractFactory("MockPlugin");
    mockPlugin = await MockPluginFactory.deploy(pluginId, underlyingAssets, routerAddress);
    await mockPlugin.waitForDeployment();
  });

  describe("Plugin Registration", function () {
    it("should register a plugin with Tier 0 by default", async function () {
      const pluginId = await mockPlugin.pluginId();
      await registry.registerPlugin(await mockPlugin.getAddress());

      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.pluginAddress).to.equal(await mockPlugin.getAddress());
      expect(plugin.tier).to.equal(PluginTier.UNTRUSTED);
      expect(plugin.isActive).to.be.true;
    });

    it("should reject zero address plugin", async function () {
      await expect(registry.registerPlugin(ethers.ZeroAddress)).to.be.revertedWith(
        "PluginRegistry: zero address"
      );
    });

    it("should reject duplicate registration", async function () {
      await registry.registerPlugin(await mockPlugin.getAddress());
      await expect(registry.registerPlugin(await mockPlugin.getAddress())).to.be.revertedWith(
        "PluginRegistry: already registered"
      );
    });
  });

  describe("Tier Management", function () {
    beforeEach(async function () {
      await registry.registerPlugin(await mockPlugin.getAddress());
    });

    it("should allow governance to update plugin tier", async function () {
      const pluginId = await mockPlugin.pluginId();
      const govRegistry = registry.connect(await ethers.getSigner(governance));

      await govRegistry.setPluginTier(pluginId, PluginTier.VERIFIED);
      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.tier).to.equal(PluginTier.VERIFIED);
    });

    it("should reject tier update from non-governance", async function () {
      const pluginId = await mockPlugin.pluginId();
      const userRegistry = registry.connect(await ethers.getSigner(user));

      await expect(userRegistry.setPluginTier(pluginId, PluginTier.VERIFIED)).to.be.reverted;
    });
  });

  describe("Tier Configuration", function () {
    it("should have default tier configurations", async function () {
      const tier0Config = await registry.getTierConfig(PluginTier.UNTRUSTED);
      expect(tier0Config.quarantineMode).to.be.true;
      expect(tier0Config.allowAutoSwap).to.be.false;

      const tier1Config = await registry.getTierConfig(PluginTier.VERIFIED);
      expect(tier1Config.quarantineMode).to.be.false;
      expect(tier1Config.allowAutoSwap).to.be.true;

      const tier2Config = await registry.getTierConfig(PluginTier.CORE);
      expect(tier2Config.maxConversionAmount).to.equal(ethers.MaxUint256);
    });

    it("should allow governance to update tier config", async function () {
      const govRegistry = registry.connect(await ethers.getSigner(governance));
      const newConfig = {
        maxConversionAmount: ethers.parseEther("50000"),
        maxSlippageBps: 200,
        allowAutoSwap: true,
        quarantineMode: false,
      };

      await govRegistry.setTierConfig(PluginTier.UNTRUSTED, newConfig);
      const config = await registry.getTierConfig(PluginTier.UNTRUSTED);
      expect(config.maxConversionAmount).to.equal(newConfig.maxConversionAmount);
    });

    it("should reject invalid slippage (>100%)", async function () {
      const govRegistry = registry.connect(await ethers.getSigner(governance));
      const invalidConfig = {
        maxConversionAmount: ethers.parseEther("10000"),
        maxSlippageBps: 10001, // > 100%
        allowAutoSwap: true,
        quarantineMode: false,
      };

      await expect(govRegistry.setTierConfig(PluginTier.UNTRUSTED, invalidConfig)).to.be.revertedWith(
        "PluginRegistry: invalid slippage"
      );
    });
  });

  describe("Plugin Caps", function () {
    beforeEach(async function () {
      await registry.registerPlugin(await mockPlugin.getAddress());
    });

    it("should allow governance to set plugin caps", async function () {
      const pluginId = await mockPlugin.pluginId();
      const govRegistry = registry.connect(await ethers.getSigner(governance));

      const caps = {
        enabled: true,
        maxConversionAmount: ethers.parseEther("1000"),
        maxSlippageBps: 150,
      };

      await govRegistry.setPluginCaps(pluginId, caps);
      const stored = await registry.getPluginCaps(pluginId);
      expect(stored.enabled).to.equal(true);
      expect(stored.maxConversionAmount).to.equal(caps.maxConversionAmount);
      expect(stored.maxSlippageBps).to.equal(caps.maxSlippageBps);
    });

    it("should reject caps update from non-governance", async function () {
      const pluginId = await mockPlugin.pluginId();
      const userRegistry = registry.connect(await ethers.getSigner(user));

      await expect(
        userRegistry.setPluginCaps(pluginId, {
          enabled: true,
          maxConversionAmount: ethers.parseEther("1000"),
          maxSlippageBps: 150,
        })
      ).to.be.reverted;
    });

    it("should reject invalid slippage caps (>100%)", async function () {
      const pluginId = await mockPlugin.pluginId();
      const govRegistry = registry.connect(await ethers.getSigner(governance));

      await expect(
        govRegistry.setPluginCaps(pluginId, {
          enabled: true,
          maxConversionAmount: ethers.parseEther("1000"),
          maxSlippageBps: 10001,
        })
      ).to.be.revertedWith("PluginRegistry: invalid slippage");
    });
  });

  describe("Plugin Activation", function () {
    beforeEach(async function () {
      await registry.registerPlugin(await mockPlugin.getAddress());
    });

    it("should allow admin to deactivate plugin", async function () {
      const pluginId = await mockPlugin.pluginId();
      const adminRegistry = registry.connect(await ethers.getSigner(admin));

      await adminRegistry.deactivatePlugin(pluginId);
      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.isActive).to.be.false;
    });

    it("should allow admin to reactivate plugin", async function () {
      const pluginId = await mockPlugin.pluginId();
      const adminRegistry = registry.connect(await ethers.getSigner(admin));

      await adminRegistry.deactivatePlugin(pluginId);
      await adminRegistry.activatePlugin(pluginId);
      const plugin = await registry.getPlugin(pluginId);
      expect(plugin.isActive).to.be.true;
    });
  });
});
