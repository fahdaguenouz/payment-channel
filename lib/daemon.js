"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const {
  Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther,
  getAddress, parseEther, verifyMessage, getBytes
} = require("ethers");
const { artifact } = require("./contracts");
const {
  jsonResponse, normalizePeer, readJson, readRequestBody, requestJson,
  signState, stateDigest, writeJson
} = require("./common");

const VERSION = "0.0.1";

class ThunderNode {
  constructor(options) {
    this.port = options.port === undefined ? 2001 : Number(options.port);
    this.host = options.host || "127.0.0.1";
    this.rpcUrl = options.rpc || "http://127.0.0.1:8545";
    this.dataDir = path.resolve(options.dataDir || `.thunder-${this.port}`);
    this.deploymentFile = path.resolve(options.deployment || "deployment.json");
    const deployment = readJson(this.deploymentFile, {});
    this.tokenAddress = options.token || deployment.tokenAddress || null;
    this.provider = new JsonRpcProvider(this.rpcUrl);
    this.stateFile = path.join(this.dataDir, "state.json");
    this.state = readJson(this.stateFile, { peer: null, walletPrivateKey: null, channel: null });
    this.server = null;
  }

  wallet() {
    if (!this.state.walletPrivateKey) throw new Error("No wallet loaded; run importwallet first");
    return new Wallet(this.state.walletPrivateKey, this.provider);
  }

  save() { writeJson(this.stateFile, this.state); }

  async start() {
    await this.provider.getBlockNumber();
    fs.mkdirSync(this.dataDir, { recursive: true });
    await new Promise((resolve, reject) => {
      this.server = http.createServer((request, response) => this.route(request, response));
      this.server.once("error", reject);
      this.server.listen(this.port, this.host, resolve);
    });
    this.port = this.server.address().port;
    return this;
  }

  async stop() {
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
  }

  async route(request, response) {
    try {
      const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
      const body = request.method === "POST" ? await readRequestBody(request) : {};
      const routes = {
        "GET /health": () => ({ ok: true }),
        "GET /infos": () => this.infos(),
        "GET /balance": () => this.balance(),
        "POST /wallet/import": () => this.importWallet(body),
        "POST /connect": () => this.connect(body),
        "POST /channel/open": () => this.openChannel(body),
        "POST /pay": () => this.pay(body),
        "POST /channel/close": () => this.closeChannel(),
        "POST /withdraw": () => this.withdraw(),
        "POST /internal/connect": () => this.acceptConnection(body),
        "GET /internal/info": () => this.internalInfo(),
        "POST /internal/channel": () => this.acceptChannel(body),
        "POST /internal/payment": () => this.acceptPayment(body),
        "POST /internal/channel-state": () => this.acceptChainState(body)
      };
      const handler = routes[`${request.method} ${url.pathname}`];
      if (!handler) return jsonResponse(response, 404, { error: "Not found" });
      jsonResponse(response, 200, await handler());
    } catch (error) {
      jsonResponse(response, 400, { error: cleanError(error) });
    }
  }

  async infos() {
    let chain = { connected: false, chainId: null, blockNumber: null };
    try {
      const [network, blockNumber] = await Promise.all([this.provider.getNetwork(), this.provider.getBlockNumber()]);
      chain = { connected: true, chainId: network.chainId.toString(), blockNumber };
    } catch {}
    return {
      version: VERSION,
      port: this.port,
      rpc: this.rpcUrl,
      blockchain: chain,
      wallet: this.state.walletPrivateKey ? this.wallet().address : null,
      connectedNode: this.state.peer,
      tokenAddress: this.tokenAddress,
      channel: this.state.channel ? publicChannel(this.state.channel) : null
    };
  }

  async importWallet({ seedphrase }) {
    if (this.state.channel && this.state.channel.status !== "CLOSED") {
      throw new Error("Cannot replace a wallet while a channel is open");
    }
    if (typeof seedphrase !== "string" || !seedphrase.trim()) throw new Error("A seed phrase is required");
    let wallet;
    try { wallet = Wallet.fromPhrase(seedphrase.trim()); }
    catch { throw new Error("Invalid seed phrase"); }
    this.state.walletPrivateKey = wallet.privateKey;
    this.save();
    return { address: wallet.address };
  }

  async internalInfo() {
    return { wallet: this.state.walletPrivateKey ? this.wallet().address : null, channel: this.state.channel && publicChannel(this.state.channel) };
  }

  async connect({ peer }) {
    if (!this.state.walletPrivateKey) throw new Error("Load a wallet before connecting");
    const normalized = normalizePeer(peer);
    const ownUrl = `http://${this.host === "0.0.0.0" ? "127.0.0.1" : this.host}:${this.port}`;
    const result = await requestJson(`${normalized}/internal/connect`, { body: { peer: ownUrl } });
    if (!result.wallet) throw new Error("The peer has no wallet loaded");
    if (getAddress(result.wallet) === this.wallet().address) throw new Error("Cannot connect a wallet to itself");
    this.state.peer = normalized;
    this.save();
    return { connectedNode: normalized, peerWallet: result.wallet };
  }

  async acceptConnection({ peer }) {
    if (!this.state.walletPrivateKey) throw new Error("Load a wallet before accepting connections");
    this.state.peer = normalizePeer(peer);
    this.save();
    return { wallet: this.wallet().address };
  }

  requireReady() {
    if (!this.tokenAddress) throw new Error("No THD token configured; deploy it or pass --token");
    if (!this.state.peer) throw new Error("No peer connected");
    return this.wallet();
  }

  async openChannel({ amount }) {
    const wallet = this.requireReady();
    if (this.state.channel && !["CLOSED"].includes(this.state.channel.status)) throw new Error("A channel already exists");
    const value = parsePositiveAmount(amount);
    const peer = await requestJson(`${this.state.peer}/internal/info`);
    if (!peer.wallet) throw new Error("Peer has no wallet loaded");
    const tokenArtifact = artifact("THDToken");
    const channelArtifact = artifact("PaymentChannel");
    const token = new Contract(this.tokenAddress, tokenArtifact.abi, wallet);
    if (await token.balanceOf(wallet.address) < value) throw new Error("Insufficient THD balance");
    const factory = new ContractFactory(channelArtifact.abi, channelArtifact.bytecode, wallet);
    const contract = await factory.deploy(this.tokenAddress, value, wallet.address, peer.wallet);
    await contract.waitForDeployment();
    const channelAddress = await contract.getAddress();
    await (await token.approve(channelAddress, value)).wait();
    await (await contract.fund(value)).wait();
    const offchain = { nonce: "0", balanceA: value.toString(), balanceB: "0" };
    const signatureA = await signState(wallet, offchain);
    const channel = {
      address: channelAddress,
      tokenAddress: getAddress(this.tokenAddress),
      partA: wallet.address,
      partB: getAddress(peer.wallet),
      amount: value.toString(),
      status: "ACTIVE",
      ...offchain,
      signatureA,
      signatureB: null
    };
    const accepted = await requestJson(`${this.state.peer}/internal/channel`, { body: channel });
    channel.signatureB = accepted.signature;
    this.state.channel = channel;
    this.save();
    return publicChannel(channel);
  }

  async acceptChannel(channel) {
    const wallet = this.wallet();
    if (this.state.channel && this.state.channel.status !== "CLOSED") throw new Error("A channel already exists");
    const checked = normalizeChannel(channel);
    if (checked.partB !== wallet.address) throw new Error("Channel is not addressed to this wallet");
    if (checked.tokenAddress !== getAddress(this.tokenAddress)) throw new Error("Unexpected THD token");
    const contract = new Contract(checked.address, artifact("PaymentChannel").abi, this.provider);
    const [partA, partB, amount, state] = await Promise.all([
      contract.partA(), contract.partB(), contract.amount(), contract.state()
    ]);
    if (getAddress(partA) !== checked.partA || getAddress(partB) !== checked.partB || amount.toString() !== checked.amount || Number(state) !== 1) {
      throw new Error("Channel does not match its on-chain contract");
    }
    verifyPartySignature(checked.partA, checked, checked.signatureA);
    checked.signatureB = await signState(wallet, checked);
    this.state.channel = checked;
    this.save();
    return { signature: checked.signatureB };
  }

  async pay({ amount }) {
    const wallet = this.requireReady();
    const channel = this.requireActiveChannel();
    const value = parsePositiveAmount(amount);
    const isA = wallet.address === channel.partA;
    const ownBalance = BigInt(isA ? channel.balanceA : channel.balanceB);
    if (value > ownBalance) throw new Error("Payment exceeds channel balance");
    const next = {
      ...channel,
      nonce: (BigInt(channel.nonce) + 1n).toString(),
      balanceA: (BigInt(channel.balanceA) + (isA ? -value : value)).toString(),
      balanceB: (BigInt(channel.balanceB) + (isA ? value : -value)).toString()
    };
    const ownSignature = await signState(wallet, next);
    if (isA) next.signatureA = ownSignature;
    else next.signatureB = ownSignature;
    const accepted = await requestJson(`${this.state.peer}/internal/payment`, { body: { channel: publicAndSignatures(next), sender: wallet.address, signature: ownSignature } });
    if (isA) next.signatureB = accepted.signature;
    else next.signatureA = accepted.signature;
    verifyPartySignature(isA ? next.partB : next.partA, next, accepted.signature);
    this.state.channel = next;
    this.save();
    return publicChannel(next);
  }

  async acceptPayment({ channel: proposed, sender, signature }) {
    const wallet = this.wallet();
    const current = this.requireActiveChannel();
    const next = normalizeChannel(proposed);
    if (next.address !== current.address || getAddress(sender) === wallet.address) throw new Error("Unexpected payment sender");
    if (BigInt(next.nonce) !== BigInt(current.nonce) + 1n) throw new Error("Payment nonce must increase by one");
    if (BigInt(next.balanceA) + BigInt(next.balanceB) !== BigInt(current.amount)) throw new Error("Channel balances do not add up");
    const senderIsA = getAddress(sender) === current.partA;
    if (!senderIsA && getAddress(sender) !== current.partB) throw new Error("Sender is not a channel party");
    const spent = BigInt(senderIsA ? current.balanceA : current.balanceB) - BigInt(senderIsA ? next.balanceA : next.balanceB);
    const received = BigInt(senderIsA ? next.balanceB : next.balanceA) - BigInt(senderIsA ? current.balanceB : current.balanceA);
    if (spent <= 0n || spent !== received) throw new Error("Invalid balance transition");
    verifyPartySignature(getAddress(sender), next, signature);
    const countersignature = await signState(wallet, next);
    if (wallet.address === next.partA) next.signatureA = countersignature;
    else next.signatureB = countersignature;
    this.state.channel = next;
    this.save();
    return { signature: countersignature };
  }

  async closeChannel() {
    const wallet = this.wallet();
    const channel = this.requireActiveChannel();
    const isA = wallet.address === channel.partA;
    const otherSignature = isA ? channel.signatureB : channel.signatureA;
    if (!otherSignature) throw new Error("Latest state is not signed by the other party");
    const contract = new Contract(channel.address, artifact("PaymentChannel").abi, wallet);
    const receipt = await (await contract.closing(channel.nonce, channel.balanceA, channel.balanceB, otherSignature)).wait();
    channel.status = "CLOSING";
    channel.closingBlock = receipt.blockNumber;
    this.save();
    await this.notifyPeerState(channel);
    return publicChannel(channel);
  }

  async withdraw() {
    const wallet = this.wallet();
    const channel = this.state.channel;
    if (!channel) throw new Error("No channel exists");
    const contract = new Contract(channel.address, artifact("PaymentChannel").abi, wallet);
    const closingBlock = Number(await contract.closingBlock());
    const currentBlock = await this.provider.getBlockNumber();
    if (currentBlock < closingBlock + 24) throw new Error(`Challenge period active: mine ${closingBlock + 24 - currentBlock} more block(s)`);
    await (await contract.withdraw()).wait();
    channel.status = "CLOSED";
    this.save();
    await this.notifyPeerState(channel);
    return { channel: publicChannel(channel), withdrawn: true };
  }

  async acceptChainState({ address, status, closingBlock }) {
    if (!this.state.channel || getAddress(address) !== this.state.channel.address) throw new Error("Unknown channel");
    if (!["CLOSING", "CLOSED"].includes(status)) throw new Error("Invalid channel status");
    const contract = new Contract(address, artifact("PaymentChannel").abi, this.provider);
    const onchain = Number(await contract.state());
    if ((status === "CLOSING" && onchain !== 2) || (status === "CLOSED" && onchain !== 3)) throw new Error("Status is not confirmed on-chain");
    this.state.channel.status = status;
    if (closingBlock) this.state.channel.closingBlock = closingBlock;
    this.save();
    return { accepted: true };
  }

  async notifyPeerState(channel) {
    if (!this.state.peer) return;
    try {
      await requestJson(`${this.state.peer}/internal/channel-state`, {
        body: { address: channel.address, status: channel.status, closingBlock: channel.closingBlock }
      });
    } catch {}
  }

  requireActiveChannel() {
    if (!this.state.channel) throw new Error("No channel exists");
    if (this.state.channel.status !== "ACTIVE") throw new Error("Channel is not active");
    return this.state.channel;
  }

  async balance() {
    const wallet = this.wallet();
    if (!this.tokenAddress) throw new Error("No THD token configured");
    const token = new Contract(this.tokenAddress, artifact("THDToken").abi, this.provider);
    const main = await token.balanceOf(wallet.address);
    let channelAmount = 0n;
    let status = "NONE";
    if (this.state.channel) {
      const channel = this.state.channel;
      status = channel.status;
      if (status !== "CLOSED") channelAmount = BigInt(wallet.address === channel.partA ? channel.balanceA : channel.balanceB);
    }
    return {
      address: wallet.address,
      walletTHD: formatEther(main),
      channelTHD: formatEther(channelAmount),
      totalTHD: formatEther(main + channelAmount),
      channelStatus: status
    };
  }
}

function parsePositiveAmount(value) {
  if (value === undefined || value === null || value === "") throw new Error("Amount is required");
  let parsed;
  try { parsed = parseEther(String(value)); }
  catch { throw new Error("Amount must be a valid THD number with at most 18 decimals"); }
  if (parsed <= 0n) throw new Error("Amount must be greater than zero");
  return parsed;
}

function normalizeChannel(value) {
  const channel = { ...value };
  channel.address = getAddress(channel.address);
  channel.tokenAddress = getAddress(channel.tokenAddress);
  channel.partA = getAddress(channel.partA);
  channel.partB = getAddress(channel.partB);
  for (const key of ["amount", "nonce", "balanceA", "balanceB"]) channel[key] = BigInt(channel[key]).toString();
  if (BigInt(channel.balanceA) + BigInt(channel.balanceB) !== BigInt(channel.amount)) throw new Error("Channel balances do not add up");
  return channel;
}

function verifyPartySignature(expected, state, signature) {
  const recovered = verifyMessage(getBytes(stateDigest(state.nonce, state.balanceA, state.balanceB)), signature);
  if (getAddress(recovered) !== getAddress(expected)) throw new Error("Invalid channel-state signature");
}

function publicChannel(channel) {
  return {
    address: channel.address,
    tokenAddress: channel.tokenAddress,
    partA: channel.partA,
    partB: channel.partB,
    amountTHD: formatEther(BigInt(channel.amount)),
    status: channel.status,
    nonce: channel.nonce,
    balanceATHD: formatEther(BigInt(channel.balanceA)),
    balanceBTHD: formatEther(BigInt(channel.balanceB)),
    closingBlock: channel.closingBlock || null
  };
}

function publicAndSignatures(channel) {
  return { ...channel };
}

function cleanError(error) {
  if (error.shortMessage) return error.shortMessage;
  return String(error.message || error).replace(/^Error:\s*/, "");
}

module.exports = { ThunderNode, VERSION, cleanError };
