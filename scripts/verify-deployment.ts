/**
 * @title Production Deployment Verification Script
 * @notice Verifies all contracts are deployed correctly and configured for production
 * @dev Run this script after deployment to ensure everything is production-ready
 */

import { ethers } from "hardhat";
import { Contract } from "ethers";

interface DeploymentConfig {
  network: string;
  contracts: {
    [key: string]: {
      address: string;
      verified: boolean;
      configured: boolean;
    };
  };
}

async function verifyContract(
  name: string,
  address: string,
  constructorArgs: any[],
  libraries?: { [key: string]: string }
): Promise<boolean> {
  try {
    console.log(`\nðŸ” Verifying ${name} at ${address}...`);
    await hre.run("verify:verify", {
      address: address,
      constructorArguments: constructorArgs,
      libraries: libraries,
    });
    console.log(`âœ… ${name} verified successfully`);
    return true;
  } catch (error: any) {
    if (error.message.includes("Already Verified")) {
      console.log(`âœ… ${name} already verified`);
      return true;
    }
    console.error(`âŒ Failed to verify ${name}:`, error.message);
    return false;
  }
}

async function checkContractConfiguration(
  contract: Contract,
  name: string,
  checks: Array<{ description: string; check: () => Promise<boolean> }>
): Promise<boolean> {
  console.log(`\nðŸ“‹ Checking ${name} configuration...`);
  let allPassed = true;

  for (const { description, check } of checks) {
    try {
      const result = await check();
      if (result) {
        console.log(`  âœ… ${description}`);
      } else {
        console.log(`  âŒ ${description}`);
        allPassed = false;
      }
    } catch (error: any) {
      console.log(`  âŒ ${description} - Error: ${error.message}`);
      allPassed = false;
    }
  }

  return allPassed;
}

async function main() {
  console.log("ðŸš€ Starting Production Deployment Verification...\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (Chain ID: ${network.chainId})`);
  console.log(`Deployer: ${deployer.address}\n`);

  // Load deployment addresses from environment or deployment artifacts
  // In production, these should be stored in a deployment registry
  const deploymentAddresses = {
    treasuryAsset: process.env.TREASURY_ASSET || "",
    VastitasToken: process.env.MONTE_DAO_TOKEN || "",
    treasuryVault: process.env.TREASURY_VAULT || "",
    pluginRegistry: process.env.PLUGIN_REGISTRY || "",
    swapModule: process.env.SWAP_MODULE || "",
    revenueRouter: process.env.REVENUE_ROUTER || "",
    distributor: process.env.DISTRIBUTOR || "",
    timelock: process.env.TIMELOCK || "",
    council: process.env.COUNCIL || "",
    governance: process.env.GOVERNANCE || "",
    emergencyCouncil: process.env.EMERGENCY_COUNCIL || "",
    uniswapRouter: process.env.UNISWAP_V3_ROUTER || "",
  };

  const verificationResults: { [key: string]: boolean } = {};
  const configurationResults: { [key: string]: boolean } = {};

  // Verify all contracts are deployed
  console.log("ðŸ“¦ Checking contract deployments...");
  for (const [name, address] of Object.entries(deploymentAddresses)) {
    if (!address || address === "") {
      console.log(`  âš ï¸  ${name}: Not deployed or address not set`);
      continue;
    }

    const code = await ethers.provider.getCode(address);
    if (code === "0x") {
      console.log(`  âŒ ${name}: No contract at ${address}`);
      verificationResults[name] = false;
    } else {
      console.log(`  âœ… ${name}: Deployed at ${address}`);
      verificationResults[name] = true;
    }
  }

  // Verify SwapModule configuration
  if (deploymentAddresses.swapModule) {
    const swapModule = await ethers.getContractAt("SwapModule", deploymentAddresses.swapModule);
    const configPassed = await checkContractConfiguration(
      swapModule,
      "SwapModule",
      [
        {
          description: "Treasury asset is set",
          check: async () => {
            const treasuryAsset = await swapModule.getTreasuryAsset();
            return treasuryAsset !== ethers.ZeroAddress;
          },
        },
        {
          description: "Router is configured",
          check: async () => {
            const router = await swapModule.router();
            return router !== ethers.ZeroAddress;
          },
        },
        {
          description: "Uniswap router is configured",
          check: async () => {
            const uniswapRouter = await swapModule.uniswapRouter();
            return uniswapRouter !== ethers.ZeroAddress;
          },
        },
      ]
    );
    configurationResults["SwapModule"] = configPassed;
  }

  // Verify RevenueRouter configuration
  if (deploymentAddresses.revenueRouter) {
    const revenueRouter = await ethers.getContractAt(
      "RevenueRouter",
      deploymentAddresses.revenueRouter
    );
    const configPassed = await checkContractConfiguration(
      revenueRouter,
      "RevenueRouter",
      [
        {
          description: "Plugin registry is set",
          check: async () => {
            const registry = await revenueRouter.pluginRegistry();
            return registry !== ethers.ZeroAddress;
          },
        },
        {
          description: "Swap module is set",
          check: async () => {
            const swapModule = await revenueRouter.swapModule();
            return swapModule !== ethers.ZeroAddress;
          },
        },
        {
          description: "Vastitas token is set",
          check: async () => {
            const token = await revenueRouter.vastitasToken();
            return token !== ethers.ZeroAddress;
          },
        },
        {
          description: "Treasury vault is set",
          check: async () => {
            const treasury = await revenueRouter.treasuryVault();
            return treasury !== ethers.ZeroAddress;
          },
        },
      ]
    );
    configurationResults["RevenueRouter"] = configPassed;
  }

  // Verify PluginRegistry configuration
  if (deploymentAddresses.pluginRegistry) {
    const registry = await ethers.getContractAt("PluginRegistry", deploymentAddresses.pluginRegistry);
    const configPassed = await checkContractConfiguration(
      registry,
      "PluginRegistry",
      [
        {
          description: "Admin role is set",
          check: async () => {
            const adminRole = await registry.DEFAULT_ADMIN_ROLE();
            const hasAdmin = await registry.hasRole(adminRole, deployer.address);
            return hasAdmin;
          },
        },
      ]
    );
    configurationResults["PluginRegistry"] = configPassed;
  }

  // Summary
  console.log("\n" + "=".repeat(60));
  console.log("ðŸ“Š Verification Summary");
  console.log("=".repeat(60));

  const allDeployed = Object.values(verificationResults).every((v) => v);
  const allConfigured = Object.values(configurationResults).every((v) => v);

  console.log(`\nDeployment Status: ${allDeployed ? "âœ… PASS" : "âŒ FAIL"}`);
  console.log(`Configuration Status: ${allConfigured ? "âœ… PASS" : "âŒ FAIL"}`);

  if (allDeployed && allConfigured) {
    console.log("\nðŸŽ‰ All checks passed! Contracts are production-ready.");
    process.exit(0);
  } else {
    console.log("\nâš ï¸  Some checks failed. Please review the output above.");
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
