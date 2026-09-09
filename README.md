# Thunder payment channel

Thunder is a complete implementation of the required two-party, single-channel project. It consists of the `thunderd` node, the `thunder-cli` client, an ERC-20-compatible THD token, and the `PaymentChannel` contract. It deliberately excludes bonus scope such as multiple simultaneous channels and a public CLI challenge command.

The supported runtime is Node.js 20 or newer on Linux, macOS, and Windows. The included local chain is Ganache; any Ethereum JSON-RPC network that supports the contracts can be selected with `--RPC`.

## Quick start: the complete audit scenario

Install and compile once:

```bash
npm install
npm run compile
```

Open four terminals in this directory. Terminal 1 starts a deterministic local Ethereum testnet:

```bash
npm run chain
```

The chain is local development infrastructure only. It gives ETH for gas to these independently importable wallets:

- Wallet A: `test test test test test test test test test test test junk`
- Wallet B: `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`

Deploy THD and give each wallet 100 THD (Terminal 2):

```bash
npm run deploy -- --recipient "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266,0x9858EfFD232B4033E47d90003D41EC34EcaEda94"
```

This writes `deployment.json`; both daemons read the token address from it. Start the nodes in Terminals 2 and 3:

```bash
npm run thunderd -- --port 2001
```

```bash
npm run thunderd -- --port 2002
```

Use Terminal 4 for the client. Import each wallet and connect A to B:

```bash
npm run thunder-cli -- --port 2001 importwallet "test test test test test test test test test test test junk"
npm run thunder-cli -- --port 2002 importwallet "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
npm run thunder-cli -- --port 2001 connect 127.0.0.1:2002
```

Open a 10 THD channel from A and pay B 5 THD:

```bash
npm run thunder-cli -- --port 2001 openchannel 10
npm run thunder-cli -- --port 2001 pay 5
npm run thunder-cli -- --port 2001 balance
npm run thunder-cli -- --port 2002 balance
```

A now has 90 THD in its wallet and 5 THD in the channel, or 95 THD total. B has 100 THD in its wallet and 5 THD in the channel, or 105 THD total.

Close from B, prove that an early withdrawal is refused, mine the required blocks, then settle:

```bash
npm run thunder-cli -- --port 2002 closechannel
npm run thunder-cli -- --port 2002 withdraw
npm run mine -- 24
npm run thunder-cli -- --port 2002 withdraw
npm run thunder-cli -- --port 2001 balance
npm run thunder-cli -- --port 2002 balance
```

The first withdrawal reports how many blocks remain. The successful withdrawal atomically distributes both balances: A's main wallet is 95 THD and B's is 105 THD. Either party can submit this settlement transaction.

To invoke the executables by their exact names, run `npm link` once and replace `npm run thunderd --`/`npm run thunder-cli --` with `thunderd`/`thunder-cli`. `npm link` is optional; the npm commands above work without global installation.

## Command reference

```text
thunderd [--RPC URL] [--port PORT] [--host ADDRESS]
         [--token ADDRESS] [--deployment FILE] [--data-dir DIRECTORY]

thunder-cli [--host ADDRESS] [--port PORT] infos
thunder-cli [--host ADDRESS] [--port PORT] importwallet "seed phrase"
thunder-cli [--host ADDRESS] [--port PORT] balance
thunder-cli [--host ADDRESS] [--port PORT] connect IP:PORT
thunder-cli [--host ADDRESS] [--port PORT] openchannel AMOUNT
thunder-cli [--host ADDRESS] [--port PORT] pay AMOUNT
thunder-cli [--host ADDRESS] [--port PORT] closechannel
thunder-cli [--host ADDRESS] [--port PORT] withdraw
```

`openchannel` takes an amount because the channel capacity must be explicit. Amounts are human-readable THD numbers with up to 18 decimal places. Use either executable's `--help` option for the built-in help.

Each daemon persists its wallet, peer, and last mutually signed state in `.thunder-<port>/state.json`. The file is written with owner-only permissions. To run against a different deployment, pass the same `--RPC` and `--token` values to both nodes. Do not delete a node's data directory while funds remain in its channel.

## How it works

The lifecycle is:

```text
EMPTY --fund(capacity)--> ACTIVE --closing(signed state)--> CLOSING
                                                              |
                                           wait 24 blocks + withdraw
                                                              |
                                                           CLOSED
```

1. `connect` performs a two-way HTTP handshake and exchanges the wallets' public addresses.
2. `openchannel` deploys `PaymentChannel`, approves its THD allowance, deposits the chosen capacity, and sends the peer the on-chain channel details. The peer independently checks the contract before accepting it.
3. Both nodes sign the initial `(nonce, balanceA, balanceB)` state. A `pay` command changes only those off-chain balances, increments the nonce, and succeeds only after the receiver validates and countersigns the update. No gas is spent per payment.
4. `closechannel` submits the newest state plus the other party's signature. The contract verifies the signer, total balance, parties, and nonce, and records the closing block.
5. For 24 blocks either party can call the required contract-level `challenge` function with a newer state signed by the other party. A successful challenge awards the complete locked amount to the challenger, as required by the subject. This protection is implemented and tested but has no bonus CLI command.
6. Once 24 blocks have passed, `withdraw` transfers the agreed balances to A and B in one atomic settlement and marks the channel `CLOSED`.

The signed digest is exactly `keccak256(abi.encodePacked(nonce, balanceA, balanceB))`, wrapped with Ethereum's standard signed-message prefix. Contract transfers follow checks-effects-interactions, settlement zeroes balances before token calls, signatures require canonical low-`s` values, and all state-changing contract functions are restricted to the two channel parties.

## Testing

Run the complete suite with:

```bash
npm test
```

The contract tests cover activation by funding, signature-authorized close, the enforced 24-block delay, atomic payout, stale-close challenge, invalid balance rejection, and party authorization. The integration test starts a real JSON-RPC chain plus two HTTP nodes and follows the audit workflow end to end, including exact wallet/channel totals and an overpayment rejection.

On a newer Node.js release, Ganache may print a notice that it is using its portable JavaScript WebSocket implementation. This is a performance notice, not a test failure; Node.js 20 LTS avoids it.

## Files and operational notes

- `contracts/THDToken.sol`: dedicated 18-decimal THD token.
- `contracts/PaymentChannel.sol`: required state machine, message, funding, closing, challenge, and withdrawal logic.
- `bin/thunderd.js`: persistent node and peer/blockchain coordination.
- `bin/thunder-cli.js`: human-facing command client.
- `scripts/compile.js`: reproducible local Solidity compilation using the pinned `solc` package; it does not download a compiler.
- `scripts/deploy.js`: token deployment and initial allocation.
- `scripts/chain.js` and `scripts/mine.js`: local audit-chain helpers.
- `test/`: contract and two-node integration tests.

Thunder binds to `127.0.0.1` by default and is intended for a local testnet. The daemon API has no transport authentication and the persisted development key is not encrypted; do not expose it to an untrusted network or use it with production funds.
