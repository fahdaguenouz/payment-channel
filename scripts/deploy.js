#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { ContractFactory, JsonRpcProvider, Wallet, parseEther } = require("ethers");
const { artifact } = require("../lib/contracts");
const { parseOptions, writeJson } = require("../lib/common");

const DEFAULT_MNEMONIC = "test test test test test test test test test test test junk";

async function main() {
  const options = parseOptions(process.argv.slice(2), {
    rpc: "http://127.0.0.1:8545",
    mnemonic: DEFAULT_MNEMONIC,
    amount: "100",
    out: "deployment.json"
  });
  if (options.help) {
    console.log(`Usage: node scripts/deploy.js [options]

Deploy THD and mint tokens to an address.

Options:
  --RPC <URL>             JSON-RPC endpoint (default: http://127.0.0.1:8545)
  --mnemonic <phrase>     Deployer mnemonic (Ganache test mnemonic by default)
  --recipient <address>   Address credited with THD (deployer by default)
  --amount <THD>          Tokens to mint (default: 100)
  --out <file>            Deployment record (default: deployment.json)`);
    return;
  }
  const provider = new JsonRpcProvider(options.rpc, undefined, { cacheTimeout: -1 });
  const wallet = Wallet.fromPhrase(options.mnemonic).connect(provider);
  const recipients = String(options.recipient || wallet.address).split(",").map((value) => value.trim()).filter(Boolean);
  const factory = new ContractFactory(artifact("THDToken").abi, artifact("THDToken").bytecode, wallet);
  const token = await factory.deploy();
  await token.waitForDeployment();
  for (const recipient of recipients) {
    await (await token.mint(recipient, parseEther(options.amount))).wait();
  }
  const network = await provider.getNetwork();
  const deployment = {
    tokenAddress: await token.getAddress(),
    recipients,
    amountTHD: options.amount,
    deployer: wallet.address,
    chainId: network.chainId.toString(),
    rpc: options.rpc
  };
  writeJson(path.resolve(options.out), deployment, 0o644);
  console.log(`THD deployed: ${deployment.tokenAddress}`);
  for (const recipient of deployment.recipients) console.log(`Credited ${deployment.amountTHD} THD to ${recipient}`);
  console.log(`Saved ${path.resolve(options.out)}`);
}

main().catch((error) => {
  console.error(`deploy: ${error.shortMessage || error.message || error}`);
  process.exit(1);
});
