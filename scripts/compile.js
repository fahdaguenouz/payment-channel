#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const solc = require("solc");

const root = path.resolve(__dirname, "..");
const sources = {};
for (const file of ["THDToken.sol", "PaymentChannel.sol"]) {
  sources[file] = { content: fs.readFileSync(path.join(root, "contracts", file), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } }
  }
};

const output = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (output.errors || []).filter((entry) => entry.severity === "error");
if (errors.length) {
  for (const error of errors) console.error(error.formattedMessage);
  process.exit(1);
}

const artifacts = path.join(root, "artifacts");
fs.mkdirSync(artifacts, { recursive: true });
for (const [source, contracts] of Object.entries(output.contracts)) {
  for (const [name, contract] of Object.entries(contracts)) {
    if (!contract.evm.bytecode.object) continue;
    fs.writeFileSync(path.join(artifacts, `${name}.json`), JSON.stringify({
      contractName: name,
      sourceName: source,
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`
    }, null, 2));
  }
}
console.log("Compiled THDToken and PaymentChannel.");
