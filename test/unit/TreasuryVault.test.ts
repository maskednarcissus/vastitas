import { expect } from "chai";
import { ethers } from "hardhat";
import { TreasuryVault, MockERC20 } from "../../typechain-types";

describe("TreasuryVault - Unit Tests", function () {
  let treasury: TreasuryVault;
  let token: MockERC20;
  let admin: string;
  let treasurer: string;
  let user: string;
  let userSigner: any;

  beforeEach(async function () {
    const [deployer, adminAccount, treasurerAccount, userAccount] = await ethers.getSigners();
    admin = await adminAccount.getAddress();
    treasurer = await treasurerAccount.getAddress();
    user = await userAccount.getAddress();
    userSigner = userAccount;

    // Deploy token
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    token = await MockERC20Factory.deploy("Test Token", "TEST");
    await token.waitForDeployment();

    // Deploy treasury
    const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
    treasury = await TreasuryFactory.deploy(admin, treasurer);
    await treasury.waitForDeployment();
  });

  describe("Constructor", function () {
    it("should set admin role correctly", async function () {
      expect(await treasury.hasRole(await treasury.DEFAULT_ADMIN_ROLE(), admin)).to.be.true;
      expect(await treasury.hasRole(await treasury.ADMIN_ROLE(), admin)).to.be.true;
    });

    it("should set treasurer role correctly", async function () {
      expect(await treasury.hasRole(await treasury.TREASURER_ROLE(), treasurer)).to.be.true;
    });

    it("should allow zero treasurer address", async function () {
      const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
      const treasuryNoTreasurer = await TreasuryFactory.deploy(admin, ethers.ZeroAddress);
      await treasuryNoTreasurer.waitForDeployment();

      // Should deploy successfully
      expect(await treasuryNoTreasurer.getAddress()).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("deposit", function () {
    it("should deposit tokens correctly", async function () {
      const amount = ethers.parseEther("1000");

      await token.mint(user, amount);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount);

      await expect(treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), amount))
        .to.emit(treasury, "Deposit")
        .withArgs(await token.getAddress(), user, amount);

      const balance = await treasury.getBalance(await token.getAddress());
      expect(balance).to.equal(amount);
    });

    it("should reject zero token address", async function () {
      const amount = ethers.parseEther("1000");

      await expect(
        treasury.connect(await ethers.getSigner(user)).deposit(ethers.ZeroAddress, amount)
      ).to.be.revertedWith("TreasuryVault: zero token");
    });

    it("should reject zero amount", async function () {
      await expect(
        treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), 0)
      ).to.be.revertedWith("TreasuryVault: zero amount");
    });

    it("should allow anyone to deposit", async function () {
      const amount = ethers.parseEther("1000");

      await token.mint(user, amount);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount);

      await expect(treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), amount))
        .to.not.be.reverted;
    });
  });

  describe("withdraw", function () {
    beforeEach(async function () {
      // Setup: deposit some tokens
      const amount = ethers.parseEther("1000");
      await token.mint(user, amount);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount);
      await treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), amount);
    });

    it("should withdraw tokens correctly", async function () {
      const amount = ethers.parseEther("500");
      const treasurerSigner = await ethers.getSigner(treasurer);

      await expect(
        treasury.connect(treasurerSigner).withdraw(await token.getAddress(), user, amount)
      )
        .to.emit(treasury, "Withdrawal")
        .withArgs(await token.getAddress(), user, amount, treasurer);

      const balance = await treasury.getBalance(await token.getAddress());
      expect(balance).to.equal(ethers.parseEther("500"));
    });

    it("should reject zero token address", async function () {
      const amount = ethers.parseEther("500");
      const treasurerSigner = await ethers.getSigner(treasurer);

      await expect(
        treasury.connect(treasurerSigner).withdraw(ethers.ZeroAddress, user, amount)
      ).to.be.revertedWith("TreasuryVault: zero token");
    });

    it("should reject zero recipient address", async function () {
      const amount = ethers.parseEther("500");
      const treasurerSigner = await ethers.getSigner(treasurer);

      await expect(
        treasury.connect(treasurerSigner).withdraw(await token.getAddress(), ethers.ZeroAddress, amount)
      ).to.be.revertedWith("TreasuryVault: zero recipient");
    });

    it("should reject zero amount", async function () {
      const treasurerSigner = await ethers.getSigner(treasurer);

      await expect(
        treasury.connect(treasurerSigner).withdraw(await token.getAddress(), user, 0)
      ).to.be.revertedWith("TreasuryVault: zero amount");
    });

    it("should reject withdrawal by non-treasurer", async function () {
      const amount = ethers.parseEther("500");

      await expect(
        treasury.connect(await ethers.getSigner(user)).withdraw(await token.getAddress(), user, amount)
      ).to.be.reverted;
    });

    it("should allow admin to withdraw (if admin has TREASURER_ROLE)", async function () {
      const amount = ethers.parseEther("500");
      const adminSigner = await ethers.getSigner(admin);

      await expect(
        treasury.connect(adminSigner).withdraw(await token.getAddress(), user, amount)
      ).to.not.be.reverted;
    });
  });

  describe("getBalance", function () {
    it("should return zero for empty treasury", async function () {
      const balance = await treasury.getBalance(await token.getAddress());
      expect(balance).to.equal(0);
    });

    it("should return correct balance after deposit", async function () {
      const amount = ethers.parseEther("1000");

      await token.mint(user, amount);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount);
      await treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), amount);

      const balance = await treasury.getBalance(await token.getAddress());
      expect(balance).to.equal(amount);
    });

    it("should return correct balance after withdrawal", async function () {
      const depositAmount = ethers.parseEther("1000");
      const withdrawAmount = ethers.parseEther("300");

      await token.mint(user, depositAmount);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), depositAmount);
      await treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), depositAmount);

      const treasurerSigner = await ethers.getSigner(treasurer);
      await treasury.connect(treasurerSigner).withdraw(await token.getAddress(), user, withdrawAmount);

      const balance = await treasury.getBalance(await token.getAddress());
      expect(balance).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("Access Control", function () {
    it("should enforce role-based access for withdrawals", async function () {
      const amount = ethers.parseEther("1000");

      await token.mint(user, amount);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount);
      await treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), amount);

      // User cannot withdraw
      await expect(
        treasury.connect(await ethers.getSigner(user)).withdraw(await token.getAddress(), user, amount)
      ).to.be.reverted;

      // Treasurer can withdraw
      const treasurerSigner = await ethers.getSigner(treasurer);
      await expect(
        treasury.connect(treasurerSigner).withdraw(await token.getAddress(), user, amount)
      ).to.not.be.reverted;
    });
  });

  describe("Multiple Tokens", function () {
    it("should handle multiple token types", async function () {
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      const token2 = await MockERC20Factory.deploy("Test Token 2", "TEST2");
      await token2.waitForDeployment();

      const amount1 = ethers.parseEther("1000");
      const amount2 = ethers.parseEther("2000");

      // Deposit token1
      await token.mint(user, amount1);
      await token.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount1);
      await treasury.connect(await ethers.getSigner(user)).deposit(await token.getAddress(), amount1);

      // Deposit token2
      await token2.mint(user, amount2);
      await token2.connect(await ethers.getSigner(user)).approve(await treasury.getAddress(), amount2);
      await treasury.connect(await ethers.getSigner(user)).deposit(await token2.getAddress(), amount2);

      expect(await treasury.getBalance(await token.getAddress())).to.equal(amount1);
      expect(await treasury.getBalance(await token2.getAddress())).to.equal(amount2);
    });
  });
  
  describe("Native ETH Support", function () {
    it("should receive native ETH via receive()", async function () {
      const amount = ethers.parseEther("1");
      const sender = user;
      
      const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());
      
      await expect(
        userSigner.sendTransaction({
          to: await treasury.getAddress(),
          value: amount,
        })
      ).to.emit(treasury, "ETHDeposit")
        .withArgs(sender, amount);
      
      const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(amount);
    });
    
    it("should receive native ETH via fallback()", async function () {
      const amount = ethers.parseEther("0.5");
      const sender = user;
      
      const treasuryBalanceBefore = await ethers.provider.getBalance(await treasury.getAddress());
      
      // Send ETH with empty calldata (triggers fallback)
      await expect(
        userSigner.sendTransaction({
          to: await treasury.getAddress(),
          value: amount,
          data: "0x",
        })
      ).to.emit(treasury, "ETHDeposit")
        .withArgs(sender, amount);
      
      const treasuryBalanceAfter = await ethers.provider.getBalance(await treasury.getAddress());
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(amount);
    });
    
    it("should allow treasurer to withdraw ETH", async function () {
      // First deposit ETH
      const depositAmount = ethers.parseEther("2");
      await userSigner.sendTransaction({
        to: await treasury.getAddress(),
        value: depositAmount,
      });
      
      const withdrawAmount = ethers.parseEther("1");
      const recipient = user;
      const recipientBalanceBefore = await ethers.provider.getBalance(recipient);
      
      const treasurerSigner = await ethers.getSigner(treasurer);
      const tx = await treasury.connect(treasurerSigner).withdrawETH(recipient, withdrawAmount);
      const receipt = await tx.wait();
      const gasUsed = receipt?.gasUsed || 0n;
      const gasPrice = receipt?.gasPrice || 0n;
      const gasCost = gasUsed * gasPrice;
      
      const recipientBalanceAfter = await ethers.provider.getBalance(recipient);
      // Account for gas costs
      const balanceDiff = recipientBalanceAfter - recipientBalanceBefore;
      expect(balanceDiff).to.be.closeTo(withdrawAmount, ethers.parseEther("0.01"));
      
      // Check treasury ETH balance decreased
      const treasuryETHBalance = await treasury.getETHBalance();
      expect(treasuryETHBalance).to.equal(depositAmount - withdrawAmount);
    });
    
    it("should get ETH balance correctly", async function () {
      expect(await treasury.getETHBalance()).to.equal(0);
      
      const amount = ethers.parseEther("1.5");
      await userSigner.sendTransaction({
        to: await treasury.getAddress(),
        value: amount,
      });
      
      expect(await treasury.getETHBalance()).to.equal(amount);
    });
    
    it("should reject ETH withdrawal by non-treasurer", async function () {
      const amount = ethers.parseEther("1");
      await userSigner.sendTransaction({
        to: await treasury.getAddress(),
        value: amount,
      });
      
      await expect(
        treasury.connect(await ethers.getSigner(user)).withdrawETH(user, amount)
      ).to.be.reverted;
    });

    it("should allow admin to withdraw ETH", async function () {
      const amount = ethers.parseEther("1");
      await userSigner.sendTransaction({
        to: await treasury.getAddress(),
        value: amount,
      });

      const adminSigner = await ethers.getSigner(admin);
      await expect(
        treasury.connect(adminSigner).withdrawETH(user, amount)
      ).to.not.be.reverted;
    });
    
    it("should handle ETH from multiple senders", async function () {
      const amount1 = ethers.parseEther("0.5");
      const amount2 = ethers.parseEther("0.3");
      
      await userSigner.sendTransaction({
        to: await treasury.getAddress(),
        value: amount1,
      });
      
      const [sender2] = await ethers.getSigners();
      await sender2.sendTransaction({
        to: await treasury.getAddress(),
        value: amount2,
      });
      
      expect(await treasury.getETHBalance()).to.equal(amount1 + amount2);
    });
  });
});
