import { expect } from "chai";
import { ethers } from "hardhat";
import { RevenueRouter, PluginRegistry, SwapModule, VastitasToken, TreasuryVault } from "../../typechain-types";
import { DistributionModel } from "../helpers/TestConstants";

describe("RevenueRouter - Immutable Constraints Tests", function () {
  let router: RevenueRouter;
  let registry: PluginRegistry;
  let swapModule: SwapModule;
  let token: VastitasToken;
  let treasury: TreasuryVault;

  let admin: string;
  let governance: string;

  beforeEach(async function () {
    const [deployer, adminAccount, govAccount] = await ethers.getSigners();
    admin = await adminAccount.getAddress();
    governance = await govAccount.getAddress();

    // Deploy contracts
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    token = await TokenFactory.deploy(
      "Vastitas",
      "Vastitas",
      ethers.parseEther("1000000000"),
      deployer.address,
      deployer.address
    );
    await token.waitForDeployment();

    const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
    treasury = await TreasuryFactory.deploy(admin, governance);
    await treasury.waitForDeployment();

    const RegistryFactory = await ethers.getContractFactory("PluginRegistry");
    registry = await RegistryFactory.deploy(admin, governance);
    await registry.waitForDeployment();

    // Deploy treasury asset
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    const treasuryAsset = await MockERC20Factory.deploy("Treasury Asset", "TREASURY");
    await treasuryAsset.waitForDeployment();

    const SwapModuleFactory = await ethers.getContractFactory("SwapModule");
    swapModule = await SwapModuleFactory.deploy(
      await treasuryAsset.getAddress(), // treasury asset (must be non-zero)
      ethers.ZeroAddress, // router
      ethers.ZeroAddress, // uniswap router
      admin
    );
    await swapModule.waitForDeployment();

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
  });

  describe("Immutable Constraints", function () {
    it("should enforce max dev share cap (20%)", async function () {
      const maxDevShare = await router.MAX_DEV_SHARE_BPS();
      expect(maxDevShare).to.equal(2000); // 20%
    });

    it("should enforce max governance redirect cap (30%)", async function () {
      const maxRedirect = await router.MAX_GOVERNANCE_REDIRECT_BPS();
      expect(maxRedirect).to.equal(3000); // 30%
    });

  });

  describe("Distribution Splits", function () {
    it("should enforce splits sum to 100%", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await expect(
        govRouter.setDistributionSplits(5000, 3000, 1000) // Sums to 90%
      ).to.be.revertedWith("RevenueRouter: splits must sum to 100%");
    });

    it("should enforce treasury share cap", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await expect(
        govRouter.setDistributionSplits(5900, 1000, 3100) // Treasury = 31% > 30% cap, sums to 100%
      ).to.be.revertedWith("RevenueRouter: treasury share exceeds max");
    });

    it("should allow valid distribution splits", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      await expect(
        govRouter.setDistributionSplits(7000, 2000, 1000) // 70% buyback, 20% stakers, 10% treasury
      ).to.emit(router, "DistributionSplitsUpdated");

      expect(await router.buybackShareBps()).to.equal(7000);
      expect(await router.stakerShareBps()).to.equal(2000);
      expect(await router.treasuryShareBps()).to.equal(1000);
    });
  });

  describe("Staker Share Protection", function () {
    it("should require timelock to set staker share to 0 if it was > 0", async function () {
      const govRouter = router.connect(await ethers.getSigner(governance));

      // First set staker share to > 0
      await govRouter.setDistributionSplits(7000, 2000, 1000);
      expect(await router.stakerShareBps()).to.equal(2000);

      // Try to set to 0 without timelock (should fail)
      await expect(
        govRouter.setDistributionSplits(8000, 0, 2000)
      ).to.be.revertedWith("RevenueRouter: staker share reduction requires timelock");
    });
  });
});
