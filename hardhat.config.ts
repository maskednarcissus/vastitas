import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
const path = require("path");

require("@nomicfoundation/hardhat-toolbox");
// Load .env from the parent packages-dao directory (where the shared .env file is)
// and then load the local dao-contracts/.env to allow per-package overrides.
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });
require("dotenv").config({ path: path.resolve(__dirname, ".env") });

/** @type import('hardhat/config').HardhatUserConfig */
const accounts =
  process.env.ethereum_private_key || process.env.PRIVATE_KEY
    ? [process.env.ethereum_private_key || process.env.PRIVATE_KEY]
    : [];

const networks: Record<string, any> = {
  hardhat: {
    chainId: 1337,
  },
};

function addNetwork(name: string, url: string | undefined, chainId: number) {
  if (!url || !url.trim()) return;
  networks[name] = {
    url,
    accounts,
    chainId,
  };
}

addNetwork("sepolia", process.env.SEPOLIA_RPC_URL || process.env.ALCHEMY_SEPOLIA_URL, 11155111);
addNetwork("mainnet", process.env.MAINNET_RPC_URL || process.env.ALCHEMY_MAINNET_URL, 1);
addNetwork("polygon", process.env.POLYGON_RPC_URL, 137);
addNetwork("arbitrum", process.env.ARBITRUM_RPC_URL, 42161);
addNetwork("base", process.env.BASE_RPC_URL, 8453);
addNetwork("bsc", process.env.BSC_RPC_URL, 56);
addNetwork("bscTestnet", process.env.BSC_TESTNET_RPC_URL, 97);
addNetwork("mumbai", process.env.MUMBAI_RPC_URL, 80001);
addNetwork("arbitrumSepolia", process.env.ARBITRUM_SEPOLIA_RPC_URL, 421614);
addNetwork("baseSepolia", process.env.BASE_SEPOLIA_RPC_URL, 84532);

module.exports = {
  solidity: {
    version: "0.8.25",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks,
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY || "",
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      polygon: process.env.POLYGONSCAN_API_KEY || "",
      arbitrumOne: process.env.ARBISCAN_API_KEY || "",
      base: process.env.BASESCAN_API_KEY || "",
      bsc: process.env.BSCSCAN_API_KEY || "",
      bscTestnet: process.env.BSCSCAN_API_KEY || "",
      polygonMumbai: process.env.POLYGONSCAN_API_KEY || "",
      arbitrumSepolia: process.env.ARBISCAN_API_KEY || "",
      baseSepolia: process.env.BASESCAN_API_KEY || "",
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
  mocha: {
    timeout: 300000, // 5 minutes - increased for tests that mine many blocks
    reporter: "spec",
  },
};
