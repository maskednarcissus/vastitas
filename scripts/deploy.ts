/**
 * Vastitas Deployment Script (Resumable)
 * 
 * This script supports resumable deployments - if deployment fails partway through,
 * you can resume from where it left off.
 * 
 * USAGE:
 * 
 * 1. Normal deployment (deploy all contracts):
 *    npx hardhat run scripts/deploy.ts --network sepolia
 * 
 * 2. Resume failed deployment (automatically skips already-deployed contracts):
 *    npx hardhat run scripts/deploy.ts --network sepolia
 *    (The script will load addresses from deployments/{network}.json)
 * 
 * 3. Deploy only specific contracts:
 *    DEPLOY_CONTRACTS=governance,emergencyCouncil npx hardhat run scripts/deploy.ts --network sepolia
 * 
 * 4. Skip specific contracts:
 *    SKIP_CONTRACTS=distributor,emergencyCouncil npx hardhat run scripts/deploy.ts --network sepolia
 * 
 * 5. Use existing contract addresses (override deployment file):
 *    EXISTING_TOKEN_ADDRESS=0x... EXISTING_TREASURY_ADDRESS=0x... npx hardhat run scripts/deploy.ts --network sepolia
 * 
 * Contract names (for DEPLOY_CONTRACTS/SKIP_CONTRACTS):
 * - treasuryAsset, token, treasury, registry, swapModule, router, distributor,
 *   timelock, council, governance, emergencyCouncil
 * 
 * Deployment addresses are saved to: deployments/{network}.json
 */

import hre from "hardhat";
import * as fs from "fs";
import * as path from "path";

interface DeploymentAddresses {
  network: string;
  deployedAt: string;
  contracts: {
    treasuryAsset?: string;
    token?: string;
    treasury?: string;
    registry?: string;
    swapModule?: string;
    router?: string;
    distributor?: string;
    timelock?: string;
    council?: string;
    governance?: string;
    emergencyCouncil?: string;
  };
}

const ethers = (hre as any).ethers;

 function getChainDisplayName(chainId: bigint, networkName: string): string {
   switch (Number(chainId)) {
     case 56:
     case 97:
       return "BNB Smart Chain";
     case 137:
     case 80001:
     case 80002:
       return "Polygon PoS";
     case 42161:
     case 421614:
       return "Arbitrum";
     case 8453:
     case 84532:
       return "Base";
     default: {
       const normalized = (networkName || "").trim();
       if (!normalized) return "";
       return normalized
         .split(/[-_\s]+/g)
         .filter(Boolean)
         .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
         .join(" ");
     }
   }
 }

function resolveAddress(value: string | undefined, fallback: string): string {
  // Treat empty, undefined, or placeholder values as missing - use fallback
  if (!value || value.trim() === "" || value.trim().toUpperCase() === "REPLACE_ME") {
    return fallback;
  }
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid address: ${value}`);
  }
  return value;
}

function requireAddress(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(`${name} must be set for production deployments`);
  }
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return value;
}

function loadDeploymentAddresses(networkName: string): DeploymentAddresses | null {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  const deploymentFile = path.join(deploymentsDir, `${networkName}.json`);
  
  if (fs.existsSync(deploymentFile)) {
    try {
      const content = fs.readFileSync(deploymentFile, "utf-8");
      return JSON.parse(content) as DeploymentAddresses;
    } catch (error) {
      console.warn(`Failed to load deployment file: ${error}`);
      return null;
    }
  }
  return null;
}

function saveDeploymentAddresses(networkName: string, addresses: DeploymentAddresses, updateEnv: boolean = false): void {
  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }
  const deploymentFile = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(addresses, null, 2));
  console.log(`âœ“ Deployment addresses saved to ${deploymentFile}`);
  
  // Only update .env file if explicitly requested (usually at the end)
  if (updateEnv) {
    updateEnvFile(addresses);
  }
}

function updateEnvFile(addresses: DeploymentAddresses): void {
  // Always use root packages-dao/.env file (go up two levels: scripts -> package -> packages-dao)
  const envPath = process.env.ROOT_ENV_PATH
    ? path.resolve(process.env.ROOT_ENV_PATH)
    : path.join(__dirname, "..", "..", ".env");
  const envExamplePath = path.join(__dirname, "..", "env.example");
  
  let envContent = "";
  const contractVars: { [key: string]: string } = {
    "TREASURY_ASSET_ADDRESS": addresses.contracts.treasuryAsset || "",
    "MONTE_TOKEN_ADDRESS": addresses.contracts.token || "",
    // Alias used by other packages + production-config
    "TREASURY_ADDRESS": addresses.contracts.treasury || "",
    "TREASURY_VAULT_ADDRESS": addresses.contracts.treasury || "",
    "PLUGIN_REGISTRY_ADDRESS": addresses.contracts.registry || "",
    "SWAP_MODULE_ADDRESS": addresses.contracts.swapModule || "",
    "REVENUE_ROUTER_ADDRESS": addresses.contracts.router || "",
    "DISTRIBUTOR_ADDRESS": addresses.contracts.distributor || "",
    "TIMELOCK_ADDRESS": addresses.contracts.timelock || "",
    "COUNCIL_ADDRESS": addresses.contracts.council || "",
    "GOVERNANCE_ADDRESS": addresses.contracts.governance || "",
    "EMERGENCY_COUNCIL_ADDRESS": addresses.contracts.emergencyCouncil || "",
  };

  // Filter out empty values
  const nonEmptyVars: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(contractVars)) {
    if (value) {
      nonEmptyVars[key] = value;
    }
  }

  // If no addresses to save, skip
  if (Object.keys(nonEmptyVars).length === 0) {
    return;
  }

  // Read existing .env if it exists, otherwise use env.example as template
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, "utf-8");
  } else if (fs.existsSync(envExamplePath)) {
    envContent = fs.readFileSync(envExamplePath, "utf-8");
  }

  // Parse and update env file
  const lines = envContent.split("\n");
  const updatedLines: string[] = [];
  const updatedVars = new Set<string>();
  let foundContractSection = false;

  // Process existing lines
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    
    // Track if we're in the contract addresses section
    if (trimmed.includes("Deployed Contract Addresses") || trimmed.includes("Contract Addresses")) {
      foundContractSection = true;
    }
    
    // Skip empty lines and comments (but preserve them)
    if (!trimmed || trimmed.startsWith("#")) {
      updatedLines.push(line);
      continue;
    }

    // Check if this line is a contract address variable
    const match = trimmed.match(/^([A-Z_]+)=(.*)$/);
    if (match) {
      const varName = match[1];
      
      // If it's a contract address variable, update it
      if (nonEmptyVars.hasOwnProperty(varName)) {
        updatedLines.push(`${varName}=${nonEmptyVars[varName]}`);
        updatedVars.add(varName);
        continue;
      }
    }

    // Keep original line
    updatedLines.push(line);
  }

  // Add any contract addresses that weren't in the file
  const contractVarNames = Object.keys(nonEmptyVars);
  const missingVars = contractVarNames.filter(v => !updatedVars.has(v));
  
  if (missingVars.length > 0) {
    // Add a newline if last line isn't empty
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim() !== "") {
      updatedLines.push("");
    }
    
    // Add section header if not found
    if (!foundContractSection) {
      updatedLines.push(`# Deployed Contract Addresses (${addresses.network}) (auto-generated by deploy script)`);
    }
    
    // Add missing contract addresses
    for (const varName of missingVars) {
      updatedLines.push(`${varName}=${nonEmptyVars[varName]}`);
    }
  }

  // Write back to .env
  fs.writeFileSync(envPath, updatedLines.join("\n"));
}

function shouldDeployContract(contractName: string, existingAddresses: DeploymentAddresses | null): boolean {
  // Check if contract should be skipped via env var
  const skipContracts = process.env.SKIP_CONTRACTS?.split(",").map(s => s.trim().toLowerCase()) || [];
  if (skipContracts.includes(contractName.toLowerCase())) {
    console.log(`â­ï¸  Skipping ${contractName} (SKIP_CONTRACTS)`);
    return false;
  }

  // Check if only specific contracts should be deployed
  const deployOnly = process.env.DEPLOY_CONTRACTS?.split(",").map(s => s.trim().toLowerCase()) || [];
  if (deployOnly.length > 0 && !deployOnly.includes(contractName.toLowerCase())) {
    console.log(`â­ï¸  Skipping ${contractName} (not in DEPLOY_CONTRACTS)`);
    return false;
  }

  // Check if contract already exists
  if (existingAddresses?.contracts[contractName as keyof typeof existingAddresses.contracts]) {
    const existingAddr = existingAddresses.contracts[contractName as keyof typeof existingAddresses.contracts];
    console.log(`â­ï¸  Skipping ${contractName} (already deployed at ${existingAddr})`);
    return false;
  }

  return true;
}

function getExistingContractAddress(contractName: string, existingAddresses: DeploymentAddresses | null): string | null {
  // If FORCE_REDEPLOY is set, ignore existing addresses
  if (process.env.FORCE_REDEPLOY === "true") {
    return null;
  }

  // First check env var (highest priority)
  const envVar = `EXISTING_${contractName.toUpperCase().replace(/([A-Z])/g, "_$1")}_ADDRESS`;
  const envAddr = process.env[envVar];
  if (envAddr && ethers.isAddress(envAddr)) {
    console.log(`ðŸ“Œ Using existing ${contractName} from env: ${envAddr}`);
    return envAddr;
  }

  // Then check deployment file
  if (existingAddresses?.contracts[contractName as keyof typeof existingAddresses.contracts]) {
    return existingAddresses.contracts[contractName as keyof typeof existingAddresses.contracts] || null;
  }

  return null;
}

async function main() {
  const allSigners = await ethers.getSigners();
  const deployer = allSigners[0];
  
  // For testnet, if only one signer is available, reuse it for all roles
  // For production, multiple signers should be configured
  const adminSigner = allSigners[1] || deployer;
  const governanceSigner = allSigners[2] || deployer;
  const treasurerSigner = allSigners[3] || deployer;
  
  // Use Hardhat's network name (matches `--network <name>`)
  const networkName = hre.network.name;
  const network = await ethers.provider.getNetwork();
  const chainDisplayName = getChainDisplayName(network.chainId, networkName);
  const tokenName = chainDisplayName ? `Vastitas ${chainDisplayName}` : "Vastitas";
  
  // Load existing deployment addresses
  const existingAddresses = loadDeploymentAddresses(networkName);
  const deploymentAddresses: DeploymentAddresses = {
    network: networkName,
    deployedAt: new Date().toISOString(),
    contracts: existingAddresses?.contracts || {}
  };

  // Also check for EXISTING_* env vars and add them to deploymentAddresses
  // Note: treasuryAsset uses TREASURY_ASSET_ADDRESS (not EXISTING_TREASURY_ASSET_ADDRESS)
  const contractNames = ["token", "treasury", "registry", "swapModule", "router", "distributor", 
                         "timelock", "council", "governance", "emergencyCouncil"];
  for (const contractName of contractNames) {
    const envVar = `EXISTING_${contractName.toUpperCase().replace(/([A-Z])/g, "_$1")}_ADDRESS`;
    const envAddr = process.env[envVar];
    if (envAddr && ethers.isAddress(envAddr)) {
      const key = contractName as keyof typeof deploymentAddresses.contracts;
      deploymentAddresses.contracts[key] = envAddr;
    }
  }
  
  // Handle treasuryAsset separately (uses TREASURY_ASSET_ADDRESS)
  if (process.env.TREASURY_ASSET_ADDRESS && ethers.isAddress(process.env.TREASURY_ASSET_ADDRESS)) {
    deploymentAddresses.contracts.treasuryAsset = process.env.TREASURY_ASSET_ADDRESS;
  }

  // Get council members - use additional signers if available, otherwise reuse deployer
  // This handles testnet deployments where only one private key is configured
  const councilMembers = [];
  for (let i = 0; i < 3; i++) {
    if (allSigners.length > 4 + i) {
      councilMembers.push(await allSigners[4 + i].getAddress());
    } else {
      // Fallback: use deployer address if not enough signers available
      councilMembers.push(await deployer.getAddress());
    }
  }

  console.log("=".repeat(60));
  console.log("Vastitas Deployment Script");
  console.log("=".repeat(60));
  console.log("Deploying contracts with account:", await deployer.getAddress());
  console.log(`Network: ${networkName} (Chain ID: ${network.chainId})`);
  console.log("Account balance:", (await ethers.provider.getBalance(deployer.address)).toString());
  
  if (existingAddresses) {
    console.log(`\nðŸ“ Loaded existing deployment addresses from deployments/${networkName}.json`);
  }
  
  if (process.env.SKIP_CONTRACTS) {
    console.log(`â­ï¸  SKIP_CONTRACTS: ${process.env.SKIP_CONTRACTS}`);
  }
  if (process.env.DEPLOY_CONTRACTS) {
    console.log(`ðŸŽ¯ DEPLOY_CONTRACTS: ${process.env.DEPLOY_CONTRACTS}`);
  }
  console.log("");

  const isProductionNetwork = networkName === "mainnet";
  const adminAddress = isProductionNetwork
    ? requireAddress("ADMIN_ADDRESS", process.env.ADMIN_ADDRESS)
    : resolveAddress(process.env.ADMIN_ADDRESS, await adminSigner.getAddress());
  const governanceAddress = isProductionNetwork
    ? requireAddress("GOVERNANCE_ADDRESS", process.env.GOVERNANCE_ADDRESS)
    : resolveAddress(process.env.GOVERNANCE_ADDRESS, await governanceSigner.getAddress());
  const treasurerAddress = isProductionNetwork
    ? requireAddress("TREASURER_ADDRESS", process.env.TREASURER_ADDRESS)
    : resolveAddress(process.env.TREASURER_ADDRESS, await treasurerSigner.getAddress());

  // Treasury asset: require address in production, allow mock otherwise
  const treasuryAssetAddress = process.env.TREASURY_ASSET_ADDRESS;
  let treasuryAssetAddressResolved: string;
  let treasuryAsset: any;
  if (treasuryAssetAddress) {
    if (!ethers.isAddress(treasuryAssetAddress)) {
      throw new Error(`Invalid TREASURY_ASSET_ADDRESS: ${treasuryAssetAddress}`);
    }
    treasuryAssetAddressResolved = treasuryAssetAddress;
    console.log("Treasury Asset configured:", treasuryAssetAddressResolved);
  } else {
    const existingTreasuryAsset = getExistingContractAddress("treasuryAsset", existingAddresses);
    if (existingTreasuryAsset) {
      treasuryAssetAddressResolved = existingTreasuryAsset;
      console.log("ðŸ“Œ Using existing Treasury Asset:", treasuryAssetAddressResolved);
    } else if (shouldDeployContract("treasuryAsset", existingAddresses)) {
      if (isProductionNetwork) {
        throw new Error("TREASURY_ASSET_ADDRESS must be set for mainnet");
      }
      const MockERC20Factory = await ethers.getContractFactory("MockERC20");
      treasuryAsset = await MockERC20Factory.deploy("Treasury Asset", "TREASURY");
      await treasuryAsset.waitForDeployment();
      treasuryAssetAddressResolved = await treasuryAsset.getAddress();
      deploymentAddresses.contracts.treasuryAsset = treasuryAssetAddressResolved;
      saveDeploymentAddresses(networkName, deploymentAddresses);
      console.log("âœ“ Treasury Asset deployed to:", treasuryAssetAddressResolved);
    } else {
      throw new Error("Treasury Asset address required but not found");
    }
  }

  // Deploy Vastitas Token (with voting support)
  let token: any;
  // Get initial token holder address (from env or use deployer as fallback)
  // Declare at higher scope so it's available for verification commands later
  const shouldMintInitialTokenSupply = (process.env.MINT_INITIAL_TOKEN_SUPPLY || "true").toLowerCase() === "true";
  const initialTokenHolder = shouldMintInitialTokenSupply
    ? process.env.INITIAL_TOKEN_HOLDER_ADDRESS
      ? requireAddress("INITIAL_TOKEN_HOLDER_ADDRESS", process.env.INITIAL_TOKEN_HOLDER_ADDRESS)
      : deployer.address
    : deployer.address;

  const primaryTokenNetworks = (process.env.PRIMARY_TOKEN_NETWORKS || "mainnet,sepolia")
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const isPrimaryTokenNetwork = primaryTokenNetworks.includes(networkName);
  const tokenMinterAddress = process.env.TOKEN_MINTER_ADDRESS
    ? requireAddress("TOKEN_MINTER_ADDRESS", process.env.TOKEN_MINTER_ADDRESS)
    : adminAddress;
  
  // If MINT_INITIAL_TOKEN_SUPPLY is explicitly set, respect it regardless of network
  // If not set, only mint on primary networks by default
  const mintExplicitlyEnabled = process.env.MINT_INITIAL_TOKEN_SUPPLY?.toLowerCase() === "true";
  const mintExplicitlyDisabled = process.env.MINT_INITIAL_TOKEN_SUPPLY?.toLowerCase() === "false";
  
  let initialTokenSupply: bigint;
  if (mintExplicitlyDisabled) {
    // Explicitly disabled: 0 supply
    initialTokenSupply = ethers.parseEther("0");
  } else if (mintExplicitlyEnabled) {
    // Explicitly enabled: mint regardless of network
    initialTokenSupply = ethers.parseEther("1000000000"); // 1 billion tokens
  } else {
    // Not explicitly set (default "true" used): only mint on primary networks
    initialTokenSupply = isPrimaryTokenNetwork
      ? ethers.parseEther("1000000000") // 1 billion tokens
      : ethers.parseEther("0");
  }
  
  const existingToken = getExistingContractAddress("token", existingAddresses);
  if (existingToken) {
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    token = TokenFactory.attach(existingToken);
    console.log("ðŸ“Œ Using existing Vastitas Token:", existingToken);
  } else if (shouldDeployContract("token", existingAddresses)) {
    const TokenFactory = await ethers.getContractFactory("VastitasToken");
    
    token = await TokenFactory.deploy(
      tokenName,
      "Vastitas",
      initialTokenSupply,
      initialTokenHolder,
      tokenMinterAddress
    );
    await token.waitForDeployment();
    deploymentAddresses.contracts.token = await token.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Vastitas Token deployed to:", await token.getAddress());
  } else {
    throw new Error("Vastitas Token address required but not found");
  }

  // Deploy Treasury Vault
  let treasury: any;
  const existingTreasury = getExistingContractAddress("treasury", existingAddresses);
  if (existingTreasury) {
    const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
    treasury = TreasuryFactory.attach(existingTreasury);
    console.log("ðŸ“Œ Using existing Treasury Vault:", existingTreasury);
  } else if (shouldDeployContract("treasury", existingAddresses)) {
    const TreasuryFactory = await ethers.getContractFactory("TreasuryVault");
    treasury = await TreasuryFactory.deploy(adminAddress, treasurerAddress);
    await treasury.waitForDeployment();
    deploymentAddresses.contracts.treasury = await treasury.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Treasury Vault deployed to:", await treasury.getAddress());
  } else {
    throw new Error("Treasury Vault address required but not found");
  }

  // Deploy Plugin Registry
  let registry: any;
  const existingRegistry = getExistingContractAddress("registry", existingAddresses);
  if (existingRegistry) {
    const RegistryFactory = await ethers.getContractFactory("PluginRegistry");
    registry = RegistryFactory.attach(existingRegistry);
    console.log("ðŸ“Œ Using existing Plugin Registry:", existingRegistry);
  } else if (shouldDeployContract("registry", existingAddresses)) {
    const RegistryFactory = await ethers.getContractFactory("PluginRegistry");
    registry = await RegistryFactory.deploy(adminAddress, governanceAddress);
    await registry.waitForDeployment();
    deploymentAddresses.contracts.registry = await registry.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Plugin Registry deployed to:", await registry.getAddress());
  } else {
    throw new Error("Plugin Registry address required but not found");
  }

  // Deploy Swap Module
  // Uniswap V3 SwapRouter02 addresses:
  // Mainnet: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
  // Goerli: 0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45
  // Sepolia: 0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E
  // For testnet/local, can use zero address and set later via setUniswapRouter()
  const uniswapRouterAddress = process.env.UNISWAP_V3_ROUTER || ethers.ZeroAddress;
  if (isProductionNetwork && uniswapRouterAddress === ethers.ZeroAddress) {
    throw new Error("UNISWAP_V3_ROUTER must be set for mainnet");
  }
  const uniswapQuoterAddress = process.env.UNISWAP_V3_QUOTER || ethers.ZeroAddress;
  if (isProductionNetwork && uniswapQuoterAddress === ethers.ZeroAddress) {
    throw new Error("UNISWAP_V3_QUOTER must be set for mainnet");
  }
  // Deploy Swap Module
  let swapModule: any;
  const existingSwapModule = getExistingContractAddress("swapModule", existingAddresses);
  if (existingSwapModule) {
    const SwapModuleFactory = await ethers.getContractFactory("SwapModule");
    swapModule = SwapModuleFactory.attach(existingSwapModule);
    console.log("ðŸ“Œ Using existing Swap Module:", existingSwapModule);
  } else if (shouldDeployContract("swapModule", existingAddresses)) {
    const SwapModuleFactory = await ethers.getContractFactory("SwapModule");
    swapModule = await SwapModuleFactory.deploy(
      treasuryAssetAddressResolved,
      ethers.ZeroAddress, // Router address - will be updated after router deployment
      uniswapRouterAddress, // Uniswap V3 SwapRouter address
      adminAddress
    );
    await swapModule.waitForDeployment();
    deploymentAddresses.contracts.swapModule = await swapModule.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Swap Module deployed to:", await swapModule.getAddress());
  } else {
    throw new Error("Swap Module address required but not found");
  }
  if (uniswapRouterAddress === ethers.ZeroAddress) {
    console.log("âš ï¸  Uniswap V3 Router not set - must be configured via setUniswapRouter() before swaps");
  } else {
    console.log("Uniswap V3 Router configured:", uniswapRouterAddress);
  }
  if (uniswapQuoterAddress === ethers.ZeroAddress) {
    console.log("Ã¢Å¡Â Ã¯Â¸Â  Uniswap V3 Quoter not set - must be configured via setUniswapQuoter() before swaps");
  } else {
    console.log("Uniswap V3 Quoter configured:", uniswapQuoterAddress);
  }

  if (uniswapQuoterAddress !== ethers.ZeroAddress) {
    try {
      const currentQuoter = await swapModule.uniswapQuoter();
      if (currentQuoter === ethers.ZeroAddress) {
        await swapModule.connect(adminSigner).setUniswapQuoter(uniswapQuoterAddress);
        console.log("Ã¢Å“â€œ Uniswap V3 Quoter set in SwapModule");
      }
    } catch (error: any) {
      console.warn("Ã¢Å¡Â Ã¯Â¸Â  Failed to set Uniswap V3 Quoter:", error.message);
    }
  }

  // Deploy Revenue Router
  let router: any;
  const existingRouter = getExistingContractAddress("router", existingAddresses);
  if (existingRouter) {
    const RouterFactory = await ethers.getContractFactory("RevenueRouter");
    router = RouterFactory.attach(existingRouter);
    console.log("ðŸ“Œ Using existing Revenue Router:", existingRouter);
  } else if (shouldDeployContract("router", existingAddresses)) {
    const RouterFactory = await ethers.getContractFactory("RevenueRouter");
    // DistributionModel enum: BUYBACK_ONLY = 0, STAKING_REWARDS = 1, HYBRID = 2
    const distributionModel = 0; // BUYBACK_ONLY
    router = await RouterFactory.deploy(
      await registry.getAddress(),
      await swapModule.getAddress(),
      await token.getAddress(),
      await treasury.getAddress(),
      distributionModel,
      adminAddress,
      governanceAddress
    );
    await router.waitForDeployment();
    deploymentAddresses.contracts.router = await router.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Revenue Router deployed to:", await router.getAddress());
  } else {
    throw new Error("Revenue Router address required but not found");
  }

  // Deploy Distributor (optional)
  let distributor: any;
  const existingDistributor = getExistingContractAddress("distributor", existingAddresses);
  if (existingDistributor) {
    const DistributorFactory = await ethers.getContractFactory("Distributor");
    distributor = DistributorFactory.attach(existingDistributor);
    console.log("ðŸ“Œ Using existing Distributor:", existingDistributor);
  } else if (shouldDeployContract("distributor", existingAddresses)) {
    const DistributorFactory = await ethers.getContractFactory("Distributor");
    distributor = await DistributorFactory.deploy(
      await token.getAddress(),
      treasuryAssetAddressResolved,
      7 * 24 * 60 * 60, // 7 days epoch
      adminAddress,
      await router.getAddress()
    );
    await distributor.waitForDeployment();
    deploymentAddresses.contracts.distributor = await distributor.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Distributor deployed to:", await distributor.getAddress());
  }

  if (distributor) {
    try {
      const currentDistributor = await router.distributor();
      if (currentDistributor === ethers.ZeroAddress) {
        const adminRouter = router.connect(adminSigner);
        await adminRouter.setDistributor(await distributor.getAddress());
        console.log("Ã¢Å“â€œ Distributor set in RevenueRouter");
      } else {
        console.log("Ã°Å¸â€œÅ’ Distributor already set in RevenueRouter:", currentDistributor);
      }
    } catch (error: any) {
      console.warn("Ã¢Å¡Â Ã¯Â¸Â  Failed to set distributor (may already be set):", error.message);
    }
  }

  // Deploy Governance Contracts
  console.log("\n=== Deploying Governance Contracts ===");

  // Deploy Timelock
  let timelock: any;
  const existingTimelock = getExistingContractAddress("timelock", existingAddresses);
  if (existingTimelock) {
    const TimelockFactory = await ethers.getContractFactory("Timelock");
    timelock = TimelockFactory.attach(existingTimelock);
    console.log("ðŸ“Œ Using existing Timelock:", existingTimelock);
  } else if (shouldDeployContract("timelock", existingAddresses)) {
    const proposers = [governanceAddress]; // Governance can propose
    const executors = [governanceAddress]; // Governance can execute
    const TimelockFactory = await ethers.getContractFactory("Timelock");
    timelock = await TimelockFactory.deploy(
      2 * 24 * 60 * 60, // 2 days standard delay
      proposers,
      executors,
      adminAddress // Admin as canceler
    );
    await timelock.waitForDeployment();
    deploymentAddresses.contracts.timelock = await timelock.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Timelock deployed to:", await timelock.getAddress());
  } else {
    throw new Error("Timelock address required but not found");
  }

  // Deploy Council (for representative voting)
  let council: any;
  const existingCouncil = getExistingContractAddress("council", existingAddresses);
  if (existingCouncil) {
    const CouncilFactory = await ethers.getContractFactory("Council");
    council = CouncilFactory.attach(existingCouncil);
    console.log("ðŸ“Œ Using existing Council:", existingCouncil);
  } else if (shouldDeployContract("council", existingAddresses)) {
    const CouncilFactory = await ethers.getContractFactory("Council");
    // Assuming 15 second blocks: 30 days = 172,800 blocks, 90 days = 518,400 blocks
    const blocksPerDay = 5760; // 15 second blocks
    const electionPeriod = 30 * blocksPerDay; // 30 days in blocks
    const termLength = 90 * blocksPerDay; // 90 days in blocks
    council = await CouncilFactory.deploy(
      await token.getAddress(),
      electionPeriod,
      termLength,
      ethers.ZeroAddress // Will be set after governance deployment
    );
    await council.waitForDeployment();
    deploymentAddresses.contracts.council = await council.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Council deployed to:", await council.getAddress());
  } else {
    throw new Error("Council address required but not found");
  }

  // Deploy Governance (with council, but start with direct voting disabled)
  let governanceContract: any;
  const existingGovernance = getExistingContractAddress("governance", existingAddresses);
  if (existingGovernance) {
    const GovernanceFactory = await ethers.getContractFactory("Governance");
    governanceContract = GovernanceFactory.attach(existingGovernance);
    console.log("ðŸ“Œ Using existing Governance:", existingGovernance);
  } else if (shouldDeployContract("governance", existingAddresses)) {
    const GovernanceFactory = await ethers.getContractFactory("Governance");
    console.log("Deploying Governance with parameters:");
    console.log(`  Token: ${await token.getAddress()}`);
    console.log(`  Timelock: ${await timelock.getAddress()}`);
    console.log(`  Council: ${await council.getAddress()}`);
    console.log(`  Voting delay: 1 block`);
    console.log(`  Voting period: 5760 blocks`);
    console.log(`  Proposal threshold: ${ethers.formatEther(ethers.parseEther("10000"))} tokens`);
    console.log(`  Quorum: 5 (5% - numerator/100, where denominator=100)`);
    
    try {
      governanceContract = await GovernanceFactory.deploy(
        await token.getAddress(),
        await timelock.getAddress(),
        await council.getAddress(),
        1, // 1 block voting delay
        5760, // ~1 day voting period (assuming 15s blocks)
        ethers.parseEther("10000"), // 0.1% proposal threshold (10k tokens)
        5, // 5% quorum (numerator: 5/100 = 5%. Note: OpenZeppelin uses denominator=100, not 10000)
        false // Start with direct voting (can be toggled to council voting later)
      );
      await governanceContract.waitForDeployment();
      deploymentAddresses.contracts.governance = await governanceContract.getAddress();
      saveDeploymentAddresses(networkName, deploymentAddresses);
      console.log("âœ“ Governance deployed to:", await governanceContract.getAddress());
    } catch (error: any) {
      console.error("Failed to deploy Governance contract:");
      console.error("Error:", error.message);
      if (error.data) {
        console.error("Error data:", error.data);
      }
      if (error.reason) {
        console.error("Reason:", error.reason);
      }
      throw error;
    }

    // Grant governance role to council (only if we just deployed)
    try {
      const councilContract = council.connect(adminSigner);
      await councilContract.grantRole(
        await councilContract.GOVERNANCE_ROLE(),
        await governanceContract.getAddress()
      );
      console.log("âœ“ Governance role granted to Governance contract");
    } catch (error: any) {
      console.warn("âš ï¸  Failed to grant governance role (may already be granted):", error.message);
    }
  } else {
    throw new Error("Governance address required but not found");
  }

  // Deploy Emergency Council
  let emergencyCouncil: any;
  const existingEmergencyCouncil = getExistingContractAddress("emergencyCouncil", existingAddresses);
  if (existingEmergencyCouncil) {
    const EmergencyCouncilFactory = await ethers.getContractFactory("EmergencyCouncil");
    emergencyCouncil = EmergencyCouncilFactory.attach(existingEmergencyCouncil);
    console.log("ðŸ“Œ Using existing Emergency Council:", existingEmergencyCouncil);
  } else if (shouldDeployContract("emergencyCouncil", existingAddresses)) {
    const EmergencyCouncilFactory = await ethers.getContractFactory("EmergencyCouncil");
    emergencyCouncil = await EmergencyCouncilFactory.deploy(
      await registry.getAddress(),
      await router.getAddress(),
      await swapModule.getAddress(),
      councilMembers
    );
    await emergencyCouncil.waitForDeployment();
    deploymentAddresses.contracts.emergencyCouncil = await emergencyCouncil.getAddress();
    saveDeploymentAddresses(networkName, deploymentAddresses);
    console.log("âœ“ Emergency Council deployed to:", await emergencyCouncil.getAddress());
  }

  // Setup: Set timelock in router (only if router was just deployed or not already set)
  try {
    const currentTimelock = await router.timelock();
    if (currentTimelock === ethers.ZeroAddress) {
      const adminRouter = router.connect(adminSigner);
      await adminRouter.setTimelock(await timelock.getAddress());
      console.log("âœ“ Timelock set in RevenueRouter");
    } else {
      console.log("ðŸ“Œ Timelock already set in RevenueRouter:", currentTimelock);
    }
  } catch (error: any) {
    console.warn("âš ï¸  Failed to set timelock (may already be set):", error.message);
  }

  // Update deployment addresses with all current addresses (including existing ones)
  deploymentAddresses.contracts.treasuryAsset = treasuryAssetAddressResolved;
  deploymentAddresses.contracts.token = await token.getAddress();
  deploymentAddresses.contracts.treasury = await treasury.getAddress();
  deploymentAddresses.contracts.registry = await registry.getAddress();
  deploymentAddresses.contracts.swapModule = await swapModule.getAddress();
  deploymentAddresses.contracts.router = await router.getAddress();
  if (distributor) {
    deploymentAddresses.contracts.distributor = await distributor.getAddress();
  }
  deploymentAddresses.contracts.timelock = await timelock.getAddress();
  deploymentAddresses.contracts.council = await council.getAddress();
  deploymentAddresses.contracts.governance = await governanceContract.getAddress();
  if (emergencyCouncil) {
    deploymentAddresses.contracts.emergencyCouncil = await emergencyCouncil.getAddress();
  }
  
  // Final save to both JSON and .env
  saveDeploymentAddresses(networkName, deploymentAddresses, true);

  console.log("\n" + "=".repeat(60));
  console.log("=== Deployment Summary ===");
  console.log("=".repeat(60));
  console.log("Treasury Asset:", treasuryAssetAddressResolved);
  console.log("Vastitas Token:", await token.getAddress());
  console.log("Treasury Vault:", await treasury.getAddress());
  console.log("Plugin Registry:", await registry.getAddress());
  console.log("Swap Module:", await swapModule.getAddress());
  console.log("Revenue Router:", await router.getAddress());
  if (distributor) {
    console.log("Distributor:", await distributor.getAddress());
  }
  console.log("Timelock:", await timelock.getAddress());
  console.log("Council:", await council.getAddress());
  console.log("Governance:", await governanceContract.getAddress());
  if (emergencyCouncil) {
    console.log("Emergency Council:", await emergencyCouncil.getAddress());
  }
  console.log("=".repeat(60));
  console.log("\nâœ“ All contract addresses saved to:");
  console.log(`  - deployments/${networkName}.json`);
  console.log(`  - .env`);
  
  if (networkName === "mainnet" || networkName === "sepolia") {
    console.log("\nNext Steps:");
    console.log("1. Verify contracts on Etherscan (examples):");
    console.log(`   npx hardhat verify --network ${networkName} ${await token.getAddress()} "Vastitas" "Vastitas" ${initialTokenSupply} ${initialTokenHolder} ${tokenMinterAddress}`);
    console.log(`   npx hardhat verify --network ${networkName} ${await treasury.getAddress()} ${adminAddress} ${treasurerAddress}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
