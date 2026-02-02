import { expect } from "chai";
import hre from "hardhat";
import "@nomicfoundation/hardhat-chai-matchers";

const ethers = (hre as any).ethers;

describe("VastitasToken - Unit Tests", function () {
  let token: any;
  let owner: string;
  let user1: string;
  let user2: string;
  let ownerSigner: any;
  let user1Signer: any;
  let user2Signer: any;

  beforeEach(async function () {
    const [deployer, user1Account, user2Account] = await ethers.getSigners();
    ownerSigner = deployer;
    user1Signer = user1Account;
    user2Signer = user2Account;
    owner = await deployer.getAddress();
    user1 = await user1Account.getAddress();
    user2 = await user2Account.getAddress();

    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    token = await TokenFactory.deploy(
      "Vastitas",
      "Vastitas",
      ethers.parseEther("1000000000"),
      owner,
      owner
    );
    await token.waitForDeployment();
  });

  describe("ERC-20 Compliance", function () {
    it("should have correct name and symbol", async function () {
      expect(await token.name()).to.equal("Vastitas");
      expect(await token.symbol()).to.equal("Vastitas");
    });

    it("should mint initial supply to owner", async function () {
      const balance = await token.balanceOf(owner);
      expect(balance).to.equal(ethers.parseEther("1000000000"));
    });

    it("should set token owner (minter) correctly", async function () {
      expect(await token.owner()).to.equal(owner);
    });

    it("should transfer tokens correctly", async function () {
      const amount = ethers.parseEther("1000");
      await token.transfer(user1, amount);
      expect(await token.balanceOf(user1)).to.equal(amount);
      expect(await token.balanceOf(owner)).to.equal(ethers.parseEther("999999000"));
    });

    it("should approve and transferFrom correctly", async function () {
      const amount = ethers.parseEther("500");
      await token.approve(user1, amount);
      expect(await token.allowance(owner, user1)).to.equal(amount);

      const user1Token = token.connect(user1Signer);
      await user1Token.transferFrom(owner, user2, amount);
      expect(await token.balanceOf(user2)).to.equal(amount);
    });
  });

  describe("Minting (Option 2)", function () {
    it("should allow owner to mint", async function () {
      const mintAmount = ethers.parseEther("123");
      await expect(token.mint(user1, mintAmount))
        .to.emit(token, "Transfer")
        .withArgs(ethers.ZeroAddress, user1, mintAmount);
      expect(await token.balanceOf(user1)).to.equal(mintAmount);
    });

    it("should revert if non-owner tries to mint", async function () {
      const mintAmount = ethers.parseEther("123");
      const tokenAsUser1 = token.connect(user1Signer);
      await expect(tokenAsUser1.mint(user1, mintAmount)).to.be.reverted;
    });
  });

  describe("Burn Functionality", function () {
    it("should burn tokens from sender", async function () {
      const burnAmount = ethers.parseEther("1000");
      const initialBalance = await token.balanceOf(owner);
      await token.burn(burnAmount);
      expect(await token.balanceOf(owner)).to.equal(initialBalance - burnAmount);
    });

    it("should burn tokens from approved address", async function () {
      const burnAmount = ethers.parseEther("500");
      await token.approve(user1, burnAmount);
      
      const user1Token = token.connect(user1Signer);
      await user1Token.burnFrom(owner, burnAmount);
      
      expect(await token.balanceOf(owner)).to.equal(ethers.parseEther("999999500"));
    });

    it("should revert if burn amount exceeds balance", async function () {
      const burnAmount = ethers.parseEther("2000000000"); // 2B tokens, exceeds 1B supply
      await expect(token.burn(burnAmount)).to.be.reverted;
    });
  });

  describe("Token Minimalism", function () {
    it("should not have any business logic functions", async function () {
      // Token should only have standard ERC-20 functions + burn
      // This is a structural test - if we add plugin logic here, it's a violation
      const tokenInterface = token.interface;
      const functions = tokenInterface.fragments.filter((f: any) => f.type === "function");
      const functionNames = functions.map((f: any) => f.name);
      
      // Should have standard ERC-20 functions
      expect(functionNames).to.include("transfer");
      expect(functionNames).to.include("approve");
      expect(functionNames).to.include("balanceOf");
      
      // Should NOT have plugin/router functions
      expect(functionNames).to.not.include("receiveYield");
      expect(functionNames).to.not.include("registerPlugin");
    });
  });
});
