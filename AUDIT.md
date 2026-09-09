# Audit checklist

This file maps every non-bonus requirement in `subject.md` and `audit.md` to an implementation and verification point.

| Requirement | Implementation | Automated verification |
|---|---|---|
| `thunderd` help, RPC and port options | `bin/thunderd.js` | compile/help smoke check; full daemon exercised in `test/e2e.test.js` |
| `thunder-cli` help and required commands | `bin/thunder-cli.js` | every state-changing command's backing endpoint is exercised end to end |
| Load a seed-phrase wallet | `POST /wallet/import`; private key persisted mode `0600` | two distinct mnemonic wallets in the integration test |
| Connect two nodes | reciprocal peer handshake and public-address exchange | both nodes record one another in the integration test |
| Dedicated ERC-20 THD | `contracts/THDToken.sol` | deployment, mint, approval, funding and transfers in both test files |
| Required channel variables and states | public/immutable fields and `StateChannel` enum in `PaymentChannel.sol` | state assertions for `ACTIVE`, `CLOSING`, and `CLOSED` |
| `fund()` | bounded party-only ERC-20 funding; activates at capacity | 10 THD funding and activation assertion |
| `message()` | exact packed hash of nonce and balances | the same digest is signed off-chain and recovered on-chain in close/challenge tests |
| `closing()` | validates conservation and other-party signature; records block | B closes A's signed 5/5 state |
| 24-block `withdraw()` | early call rejected; atomic A/B payout after delay | pre-delay rejection, 24 mined blocks, final 95/105 balances |
| `challenge()` | newer, other-party-signed state awards full capacity to challenger | dedicated stale-close challenge test |
| Off-chain payment | nonce, conservation, sender signature, receiver countersignature | 5 THD payment and overpayment rejection in the integration test |
| Information and balance monitoring | `infos` and `balance`, including wallet/channel/total THD | exact intermediate and final values asserted end to end |
| Easy local deployment | deterministic local chain, compiler, deployer, miner scripts | all use the same pinned dependencies as `npm test` |

## Manual acceptance sequence

Follow the commands in the README's “Quick start” section. The expected checkpoints are:

1. Both `infos` calls show blockchain connectivity, a wallet, and the reciprocal connected node.
2. After `openchannel 10`, the channel is `ACTIVE`, A has 90 main + 10 channel = 100 total, and B has 100 main + 0 channel = 100 total.
3. After A runs `pay 5`, nonce is 1; A has 90 main + 5 channel = 95 total, and B has 100 main + 5 channel = 105 total.
4. B can run `closechannel`; the channel becomes `CLOSING` on both nodes.
5. An immediate `withdraw` fails with the remaining block count.
6. After `npm run mine -- 24`, B's `withdraw` succeeds, both channels show `CLOSED`, and the main-wallet balances are 95 and 105 THD.

No bonus feature is claimed. In particular, the node intentionally manages one channel and the contract challenge is not exposed as an extra CLI command.
