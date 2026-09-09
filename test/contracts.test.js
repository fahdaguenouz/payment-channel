"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ganache = require("ganache");
const {
  ContractFactory, JsonRpcProvider, Wallet, parseEther
} = require("ethers");
const { artifact } = require("../lib/contracts");
const { signState } = require("../lib/common");
const { freePort } = require("./helpers");

const MNEMONIC = "test test test test test test test test test test test junk";
let server;
let provider;
let owner;

test.before(async () => {
  server = ganache.server({ logging: { quiet: true }, wallet: { mnemonic: MNEMONIC } });
  const port = await freePort();
  await server.listen(port, "127.0.0.1");
  provider = new JsonRpcProvider(`http://127.0.0.1:${port}`, undefined, { cacheTimeout: -1 });
  owner = Wallet.fromPhrase(MNEMONIC).connect(provider);
});

test.after(async () => {
  if (provider) provider.destroy();
  if (server) await server.close();
});

async function fixture() {
  const other = Wallet.createRandom().connect(provider);
  await (await owner.sendTransaction({ to: other.address, value: parseEther("1") })).wait();
  const tokenFactory = new ContractFactory(artifact("THDToken").abi, artifact("THDToken").bytecode, owner);
  const token = await tokenFactory.deploy();
  await token.waitForDeployment();
  await (await token.mint(owner.address, parseEther("100"))).wait();
  const channelFactory = new ContractFactory(artifact("PaymentChannel").abi, artifact("PaymentChannel").bytecode, owner);
  const channel = await channelFactory.deploy(await token.getAddress(), parseEther("10"), owner.address, other.address);
  await channel.waitForDeployment();
  await (await token.approve(await channel.getAddress(), parseEther("10"))).wait();
  await (await channel.fund(parseEther("10"))).wait();
  return { token, channel, other };
}

test("funding activates a channel and cooperative close settles both parties", async () => {
  const { token, channel, other } = await fixture();
  assert.equal(Number(await channel.state()), 1);
  assert.equal(await channel.balanceA(), parseEther("10"));
  const state = { nonce: 1n, balanceA: parseEther("5"), balanceB: parseEther("5") };
  const signatureA = await signState(owner, state);
  await (await channel.connect(other).closing(state.nonce, state.balanceA, state.balanceB, signatureA)).wait();
  assert.equal(Number(await channel.state()), 2);
  await assert.rejects(channel.connect(other).withdraw(), (error) => error.code === "CALL_EXCEPTION");
  for (let i = 0; i < 24; i += 1) await provider.send("evm_mine", []);
  await (await channel.connect(other).withdraw()).wait();
  assert.equal(Number(await channel.state()), 3);
  assert.equal(await token.balanceOf(owner.address), parseEther("95"));
  assert.equal(await token.balanceOf(other.address), parseEther("5"));
  assert.equal(await token.balanceOf(await channel.getAddress()), 0n);
});

test("a newer counter-signed state challenges a stale close and awards the channel", async () => {
  const { token, channel, other } = await fixture();
  const stale = { nonce: 0n, balanceA: parseEther("10"), balanceB: 0n };
  await (await channel.connect(other).closing(stale.nonce, stale.balanceA, stale.balanceB, await signState(owner, stale))).wait();
  const newer = { nonce: 1n, balanceA: parseEther("9"), balanceB: parseEther("1") };
  await (await channel.challenge(newer.nonce, newer.balanceA, newer.balanceB, await signState(other, newer))).wait();
  assert.equal(Number(await channel.state()), 3);
  assert.equal(await token.balanceOf(owner.address), parseEther("100"));
  assert.equal(await token.balanceOf(await channel.getAddress()), 0n);
});

test("invalid close data and non-parties are rejected", async () => {
  const { channel, other } = await fixture();
  const invalid = { nonce: 1n, balanceA: parseEther("9"), balanceB: parseEther("2") };
  await assert.rejects(
    channel.connect(other).closing(invalid.nonce, invalid.balanceA, invalid.balanceB, await signState(owner, invalid)),
    (error) => error.code === "CALL_EXCEPTION"
  );
  const outsider = Wallet.createRandom().connect(provider);
  await (await owner.sendTransaction({ to: outsider.address, value: parseEther("1") })).wait();
  await assert.rejects(channel.connect(outsider).fund(1n), (error) => error.code === "CALL_EXCEPTION");
});
