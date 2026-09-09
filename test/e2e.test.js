"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const ganache = require("ganache");
const { ContractFactory, JsonRpcProvider, Wallet, parseEther } = require("ethers");
const { artifact } = require("../lib/contracts");
const { ThunderNode } = require("../lib/daemon");
const { freePort } = require("./helpers");

const CHAIN_MNEMONIC = "test test test test test test test test test test test junk";

test("complete audited two-node payment lifecycle", async (context) => {
  const server = ganache.server({ logging: { quiet: true }, wallet: { mnemonic: CHAIN_MNEMONIC } });
  const chainPort = await freePort();
  await server.listen(chainPort, "127.0.0.1");
  const rpc = `http://127.0.0.1:${chainPort}`;
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  const deployer = Wallet.fromPhrase(CHAIN_MNEMONIC).connect(provider);
  const walletA = Wallet.createRandom().connect(provider);
  const walletB = Wallet.createRandom().connect(provider);
  for (const wallet of [walletA, walletB]) await (await deployer.sendTransaction({ to: wallet.address, value: parseEther("2") })).wait();
  const factory = new ContractFactory(artifact("THDToken").abi, artifact("THDToken").bytecode, deployer);
  const token = await factory.deploy();
  await token.waitForDeployment();
  for (const wallet of [walletA, walletB]) await (await token.mint(wallet.address, parseEther("100"))).wait();

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "thunder-e2e-"));
  const common = { host: "127.0.0.1", port: 0, rpc, token: await token.getAddress() };
  const nodeA = new ThunderNode({ ...common, dataDir: path.join(temporary, "a") });
  const nodeB = new ThunderNode({ ...common, dataDir: path.join(temporary, "b") });
  await nodeA.start();
  await nodeB.start();
  context.after(async () => {
    await Promise.all([nodeA.stop(), nodeB.stop()]);
    provider.destroy();
    await server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
  });

  await nodeA.importWallet({ seedphrase: walletA.mnemonic.phrase });
  await nodeB.importWallet({ seedphrase: walletB.mnemonic.phrase });
  await nodeA.connect({ peer: `127.0.0.1:${nodeB.port}` });
  assert.equal((await nodeA.infos()).connectedNode, `http://127.0.0.1:${nodeB.port}`);
  assert.equal((await nodeB.infos()).connectedNode, `http://127.0.0.1:${nodeA.port}`);

  const opened = await nodeA.openChannel({ amount: "10" });
  assert.equal(opened.status, "ACTIVE");
  assert.equal((await nodeA.balance()).walletTHD, "90.0");
  assert.equal((await nodeA.balance()).totalTHD, "100.0");
  await assert.rejects(nodeA.pay({ amount: "11" }), /exceeds channel balance/);

  const paid = await nodeA.pay({ amount: "5" });
  assert.equal(paid.nonce, "1");
  assert.equal((await nodeA.balance()).channelTHD, "5.0");
  assert.equal((await nodeA.balance()).totalTHD, "95.0");
  assert.equal((await nodeB.balance()).channelTHD, "5.0");
  assert.equal((await nodeB.balance()).totalTHD, "105.0");

  const closing = await nodeB.closeChannel();
  assert.equal(closing.status, "CLOSING");
  await assert.rejects(nodeB.withdraw(), /Challenge period active/);
  for (let i = 0; i < 24; i += 1) await provider.send("evm_mine", []);
  await nodeB.withdraw();
  assert.equal((await nodeA.infos()).channel.status, "CLOSED");
  assert.equal((await nodeB.infos()).channel.status, "CLOSED");
  assert.equal((await nodeA.balance()).walletTHD, "95.0");
  assert.equal((await nodeB.balance()).walletTHD, "105.0");
});
