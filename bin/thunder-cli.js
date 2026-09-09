#!/usr/bin/env node
"use strict";

const { parseOptions, requestJson } = require("../lib/common");
const { VERSION } = require("../lib/daemon");

const HELP = `Thunder cli version v${VERSION}

Usage:  thunder-cli [options] <command> [arguments]

Options:
  --help                 Print this help message and exit
  --port <port>          Thunder node port (default: 2001)
  --host <address>       Thunder node host (default: 127.0.0.1)

Commands:
  infos                          Display node, blockchain, peer, wallet and channel information
  importwallet <"seed phrase">   Import a wallet from a BIP-39 seed phrase
  balance                        Show wallet, channel and total available THD
  connect <ip:port>              Connect this node to another Thunder node
  openchannel <amount>           Open and fund a channel with THD
  pay <amount>                   Pay the connected party off-chain
  closechannel                   Submit the latest mutually signed state on-chain
  withdraw                       Settle the channel after its 24-block challenge period`;

async function main() {
  const options = parseOptions(process.argv.slice(2), { port: "2001", host: "127.0.0.1" });
  if (options.help || options._.length === 0) {
    console.log(HELP);
    return;
  }
  const [command, ...args] = options._;
  const base = `http://${options.host}:${options.port}`;
  let result;
  switch (command.toLowerCase()) {
    case "infos":
      requireArgs(args, 0, command);
      result = await requestJson(`${base}/infos`);
      printInfos(result);
      return;
    case "importwallet":
      requireArgs(args, 1, command);
      result = await requestJson(`${base}/wallet/import`, { body: { seedphrase: args[0] } });
      console.log(`Wallet imported: ${result.address}`);
      return;
    case "balance":
      requireArgs(args, 0, command);
      result = await requestJson(`${base}/balance`);
      printBalance(result);
      return;
    case "connect":
      requireArgs(args, 1, command);
      result = await requestJson(`${base}/connect`, { body: { peer: args[0] } });
      console.log(`Connected to ${result.connectedNode} (${result.peerWallet})`);
      return;
    case "openchannel":
      requireArgs(args, 1, command);
      result = await requestJson(`${base}/channel/open`, { body: { amount: args[0] } });
      console.log(`Channel opened: ${result.address}`);
      printChannel(result);
      return;
    case "pay":
      requireArgs(args, 1, command);
      result = await requestJson(`${base}/pay`, { body: { amount: args[0] } });
      console.log(`Payment accepted at nonce ${result.nonce}`);
      printChannel(result);
      return;
    case "closechannel":
      requireArgs(args, 0, command);
      result = await requestJson(`${base}/channel/close`, { body: {} });
      console.log(`Channel closing at block ${result.closingBlock}; wait 24 blocks before withdrawal.`);
      return;
    case "withdraw":
      requireArgs(args, 0, command);
      result = await requestJson(`${base}/withdraw`, { body: {} });
      console.log(`Channel settled: ${result.channel.address}`);
      return;
    default:
      throw new Error(`Unknown command: ${command}\n\n${HELP}`);
  }
}

function requireArgs(args, count, command) {
  if (args.length !== count) throw new Error(`${command} expects ${count} argument(s)`);
}

function printInfos(info) {
  console.log(`Thunder v${info.version}`);
  console.log(`Port: ${info.port}`);
  console.log(`RPC: ${info.rpc}`);
  console.log(`Blockchain: ${info.blockchain.connected ? `connected (chain ${info.blockchain.chainId}, block ${info.blockchain.blockNumber})` : "disconnected"}`);
  console.log(`Wallet: ${info.wallet || "not loaded"}`);
  console.log(`Connected node: ${info.connectedNode || "none"}`);
  console.log(`THD token: ${info.tokenAddress || "not configured"}`);
  if (info.channel) printChannel(info.channel);
  else console.log("Channel: none");
}

function printBalance(balance) {
  console.log(`Address: ${balance.address}`);
  console.log(`Main wallet: ${balance.walletTHD} THD`);
  console.log(`In channel: ${balance.channelTHD} THD`);
  console.log(`Total available: ${balance.totalTHD} THD`);
  console.log(`Channel state: ${balance.channelStatus}`);
}

function printChannel(channel) {
  console.log(`Channel: ${channel.address}`);
  console.log(`State: ${channel.status}; nonce: ${channel.nonce}`);
  console.log(`Party A: ${channel.partA} (${channel.balanceATHD} THD)`);
  console.log(`Party B: ${channel.partB} (${channel.balanceBTHD} THD)`);
}

main().catch((error) => {
  console.error(`thunder-cli: ${error.message || error}`);
  process.exit(1);
});
