#!/usr/bin/env node
"use strict";

const { JsonRpcProvider } = require("ethers");
const { parseOptions } = require("../lib/common");

async function main() {
  const options = parseOptions(process.argv.slice(2), { rpc: "http://127.0.0.1:8545" });
  const countText = options._[0] || "24";
  const count = Number(countText);
  if (!Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error("Block count must be an integer from 1 to 10000");
  const provider = new JsonRpcProvider(options.rpc, undefined, { cacheTimeout: -1 });
  for (let index = 0; index < count; index += 1) await provider.send("evm_mine", []);
  console.log(`Mined ${count} block(s); current block is ${await provider.getBlockNumber()}.`);
  provider.destroy();
}

main().catch((error) => {
  console.error(`mine: ${error.message || error}`);
  process.exit(1);
});
