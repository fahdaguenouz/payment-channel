#!/usr/bin/env node
"use strict";

const ganache = require("ganache");
const { Wallet, parseEther } = require("ethers");

const MNEMONIC_A = "test test test test test test test test test test test junk";
const MNEMONIC_B = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const walletA = Wallet.fromPhrase(MNEMONIC_A);
const walletB = Wallet.fromPhrase(MNEMONIC_B);
const balance = `0x${parseEther("1000").toString(16)}`;

const server = ganache.server({
  chain: { chainId: 31337 },
  logging: { quiet: true },
  wallet: {
    accounts: [
      { secretKey: walletA.privateKey, balance },
      { secretKey: walletB.privateKey, balance }
    ]
  }
});

server.listen(8545, "127.0.0.1", (error) => {
  if (error) {
    console.error(`chain: ${error.message || error}`);
    process.exit(1);
  }
  console.log("Local Ethereum testnet listening on http://127.0.0.1:8545 (chain ID 31337)");
  console.log(`Wallet A: ${walletA.address}`);
  console.log(`Wallet B: ${walletB.address}`);
  console.log("The two development-only seed phrases are documented in README.md.");
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
