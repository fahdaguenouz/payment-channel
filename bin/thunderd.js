#!/usr/bin/env node
"use strict";

const { parseOptions } = require("../lib/common");
const { ThunderNode, VERSION, cleanError } = require("../lib/daemon");

const HELP = `Thunder version v${VERSION}

Usage:  thunderd [options]                     Start Thunder

Options:
  --help                 Print this help message and exit
  --RPC <URL>            Ethereum JSON-RPC endpoint (default: http://127.0.0.1:8545)
  --port <port>          Node API port (default: 2001)
  --host <address>       Node API bind address (default: 127.0.0.1)
  --token <address>      THD token address (otherwise read from deployment.json)
  --deployment <file>    Deployment JSON file (default: ./deployment.json)
  --data-dir <directory> Persistent node data (default: ./.thunder-<port>)`;

async function main() {
  const options = parseOptions(process.argv.slice(2), { port: "2001", rpc: "http://127.0.0.1:8545" });
  if (options.help) {
    console.log(HELP);
    return;
  }
  if (!Number.isInteger(Number(options.port)) || Number(options.port) < 1 || Number(options.port) > 65535) {
    throw new Error("--port must be between 1 and 65535");
  }
  const node = new ThunderNode({
    port: options.port,
    host: options.host,
    rpc: options.rpc,
    token: options.token,
    deployment: options.deployment,
    dataDir: options["data-dir"]
  });
  await node.start();
  console.log(`Thunder v${VERSION} listening on http://${node.host}:${node.port}`);
  console.log(`Ethereum RPC: ${node.rpcUrl}`);
  console.log(`Data directory: ${node.dataDir}`);
  const shutdown = async () => {
    await node.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(`thunderd: ${cleanError(error)}`);
  process.exit(1);
});
