# DeliverProof

**Pay for a digital delivery only after the buyer has verified the exact bytes and explicitly approved them.** A Scaffold-HBAR template for Hedera testnet.

DeliverProof is an escrow for one buyer, one supplier and one file. The supplier publishes the file on IPFS and records a commitment on chain: the CID, SHA-256, size and media type. The buyer fetches the file from a public IPFS gateway, checks it in the browser against that commitment and then approves. Approval creates credit for the supplier. Withdrawal is a separate transaction. **Silence never releases money:** after the review deadline, the buyer can reclaim the deposit.

Anyone can check an agreement without a wallet. The verifier replays the contract's history from its public deployment, checks every event and receipt, and reads the stored state at one block. When the data it needs is missing it answers `inconclusive`. It never guesses a success.

> **Status: public source template, not yet a live Hedera demo.**
> A clean install of source `02dd518` through the official CLI on a GitHub-hosted
> runner is recorded ([run 36556660288](https://github.com/rafaorlando3/deliverproof/actions/runs/36556660288)).
> The Hedera testnet deployment and public IPFS retrieval are still pending; the
> [evidence table](#public-evidence) is filled only with verified public links.
> The shipped deployment manifest is `null`, so a fresh app shows a clearly labelled,
> disabled source preview until a reviewed manifest is installed.
> The [validation log](docs/STATUS.md) separates accepted evidence from candidates.

## What you get

- **An escrow that pays only for approved bytes.** Exact deposit, explicit approval of the recorded commitment, credit-then-withdraw, and a buyer refund after the review deadline. No admin, no upgrades, no fees.
- **Browser-side IPFS verification.** The CAR archive is fetched from a public trustless gateway; every block is hashed, the file is rebuilt and compared by SHA-256 and size, with limits on size, blocks and time. Missing blocks, unreadable archives and unavailable gateways are `inconclusive`; root or content mismatches are reported separately and do not establish supplier intent.
- **A wallet-free verifier** (`verifyAgreement`) that answers `verified`, `mismatch` or `inconclusive` with a reason code.
- **Hedera details handled once** ([below](#hedera-details-handled-for-you)): tinybar versus 18-decimal RPC values, the 7-day log-range limit, historical reads at a fixed block, and EVM addresses.
- **A deployment journal for unresolved attempts.** A preserved checkout blocks a new deployment while an earlier attempt is unresolved; read-only recovery helps reconcile a lost response. It does not coordinate separate runners.

## Why IPFS is load-bearing

DeliverProof pays for bytes, so the bytes have to be retrievable by anyone and checkable without trusting the supplier's server. Content addressing provides exactly that. The contract stores the CID and the SHA-256; the buyer's browser fetches the CAR from a public trustless gateway, verifies each block against its hash and rebuilds the file before the approve button means anything. In this template, IPFS provides content-addressed retrieval without selecting a supplier-controlled download URL. Removing it would require another retrieval mechanism and changes to the CID/CAR verification flow; a digest alone does not make the file publicly retrievable.

The app never uploads anything. It builds the CAR in the browser; the supplier pins it with any IPFS service that supports **CAR import and keeps the root CID** (a plain file upload may re-encode the file and change the CID). The protected testnet proof workflows in [deliverproof-testnet-proof](https://github.com/rafaorlando3/deliverproof-testnet-proof) are configured to pin through Filebase's IPFS RPC `dag/import` and confirm the root.

Hedera side: `DeliverProof.sol` is written for the Hedera EVM on testnet (chain 296); the app and the verifier reach it through the Hedera JSON-RPC relay (`testnet.hashio.io`).

## Quick start

Requirements:

- Node.js **22.22.2 with npm@10.9.7** is the recorded default. Declared ranges are 20.18.3–20.x, 22.18.0–22.x and 24.0.0–24.x; recorded results on 20.18.3 and 24.21.0 are in [STATUS](docs/STATUS.md). Node 20.18.3 prints `EBADENGINE` warnings from Vite and eslint-visitor-keys, which ask for 20.19.0 on that line.
- git with `user.name` and `user.email` set (the Scaffold-HBAR CLI checks this).

```sh
npx create-scaffold-hbar@latest --template rafaorlando3/deliverproof
```

Select Next.js, Hardhat, testnet and the package manager npm. Then:

```sh
cd ⟨project-folder⟩
npm run check
npm run core:test
npm run hardhat:test
npm run next:build
npm run next:start
```

Open http://127.0.0.1:3000 (`npm run next:dev` for development). With the stock `null` manifest you see the disabled source preview. With a reviewed deployment manifest installed, enter an agreement number and press **Verify agreement**: the page shows the state, participants, deposit, snapshot block and checked event history without connecting a wallet. There is no public contract address or sample agreement number yet.

The install above is recorded for source `02dd5182ab21b9398861a419fe9ed825f39b2438`: CLI 0.4.1 on a GitHub-hosted runner with Node 22.22.2 and npm@10.9.7, no secrets and no template override ([run 36556660288](https://github.com/rafaorlando3/deliverproof/actions/runs/36556660288)). The install and the `check`, `core:test` (113 passed, 1 live-mirror test skipped), `hardhat:test` (38), `next:build` and `chain:test` (46) scripts exited 0. All eight Markdown files matched the source exactly. The CLI removed `template.json` and changed the lockfile and package-manager metadata in three manifests; see [INSTALL](docs/INSTALL.md#external-scaffold-hbar-template-gate). Later commits do not inherit this execution result.

### Run the app against a local chain

No testnet account is needed. On chain 31337 the amounts are local accounting units, not Hedera currency behavior.

1. `npm run hardhat:compile`
2. `npm run hardhat:node` in a second terminal. It prints development keys at startup; do not save or share that output.
3. `npm run hardhat:deploy:local`
4. Review `packages/nextjs/lib/deployment.candidate.json`, then copy it to `packages/nextjs/lib/deployment.json`.
5. `npm run next:build` and `npm run next:start`, and use development accounts of the local node, never a personal wallet.

Details and limits: [local EVM rehearsal](docs/INSTALL.md#local-evm-rehearsal).

## How it works

```mermaid
sequenceDiagram
  participant B as Buyer
  participant S as Supplier
  participant C as DeliverProof.sol (Hedera testnet)
  participant I as IPFS
  B->>C: create(terms hash, supplier, amount, deadlines)
  B->>C: deposit exact amount (test HBAR)
  S->>S: build a CAR in the browser (nothing is uploaded)
  S->>I: pin the CAR (CAR import keeps the root CID)
  S->>C: record delivery (CID, SHA-256, size, media type)
  B->>I: fetch the CAR through a trustless gateway
  B->>B: verify every block, rebuild the file, compare SHA-256 and size
  B->>C: approve this exact commitment
  S->>C: withdraw credit (separate transaction)
  Note over B,C: after the review deadline without approval, the buyer can refund
```

States: `Draft → Funded → Submitted → Approved`, or `Funded/Submitted → Refunded`. Approved and Refunded each create one credit. Only `withdraw` pays it.

| Package | What it contains |
| --- | --- |
| `packages/hardhat` | `DeliverProof.sol` (no admin, no upgrades, no fees, reentrancy guard), contract tests, and a deployment script with an exclusive attempt journal and read-only recovery; uncertain attempts block another send |
| `packages/core` | Delivery commitment, CAR/UnixFS verification with limits, and the network verifier (`verifyAgreement`), which returns `verified`, `mismatch` or `inconclusive` with a reason code |
| `packages/nextjs` | The app: create, deposit, prepare the CAR, verify, record, approve or refund, withdraw, evidence export |

The full protocol, including the commitment encoding and limits, is in [docs/PROTOCOL.md](docs/PROTOCOL.md). The step-by-step workflow for both participants is in [docs/INSTALL.md](docs/INSTALL.md#workflow-and-file-availability).

## Hedera details handled for you

- **Units.** Solidity on Hedera sees tinybar (8 decimals). JSON-RPC `value` uses 18 decimals, so it is tinybar × 10^10. The app and the deploy script convert explicitly and never use floating point.
- **Log limits.** `eth_getLogs` refuses ranges over 7 days (`-32004`). The verifier reads history in 6-day windows. A result that is too large (`-32011`, mirror node pagination) counts as a failed read, which is reported as `inconclusive` and never as a partial history.
- **Addresses.** A contract created by an Ethereum transaction has an EVM address (not long-zero) in the receipt and in its logs. The verifier checks that address against the reviewed deployment.
- **History.** State is read at one fixed block with historical `eth_call`, and receipts are checked against the block hash from `eth_getBlockByNumber`.
- **Optional HCS cross-check.** The core can compare a protected topic with verified contract events, including transaction hash and log index. A message mined after the contract snapshot requires a fresh read. This supplemental check never changes the contract verdict; the core also includes an opt-in publisher and a testnet SDK adapter. UI integration and a protected operational runner are not included yet; no live HCS transaction has been demonstrated. See [the HCS protocol](docs/PROTOCOL.md#hcs-evidence-trail-supplemental).

These behaviors are covered by local tests; public relay samples from `testnet.hashio.io` concern third-party contracts. The checks that still need our own chain-296 deployment are listed in [STATUS](docs/STATUS.md).

## Using the app with a wallet (testnet)

This route needs a deployment on Hedera testnet (yours, or a reviewed public one) and two test accounts.

1. Add Hedera testnet to an EVM wallet: RPC `https://testnet.hashio.io/api`, chain ID 296.
2. Get test HBAR for two test accounts (buyer and supplier) at the Hedera portal faucet.
3. Follow the workflow in [docs/INSTALL.md](docs/INSTALL.md#workflow-and-file-availability). Use public synthetic files only, up to 1 MiB.

Every transaction asks your wallet for confirmation. An unknown result locks
further sends in the current page session. Only evidence tied to the original
transaction can resolve it. If no original hash was returned, pasting a hash is
an independent observation and does not release the attempt. The lock is in
memory: reloading or opening another tab does not prove retrying is safe.
The app never automatically resends a transaction.

## Deploy your own copy

Deploying sends a real testnet transaction from your test account. The script's
**testnet mode** accepts only chain 296 at the fixed hashio endpoint; its local
mode uses chain 31337. Neither reads `.env` files.

| Variable | Value | When |
| --- | --- | --- |
| `DELIVERPROOF_TESTNET_AUTHORIZED` | `yes` | explicit opt-in, required to deploy to testnet |
| `DELIVERPROOF_TESTNET_PRIVATE_KEY` | test account key | set only in the protected environment of the process; never in a file, a command argument or a log |
| `DELIVERPROOF_RECOVERY_TX` | public transaction hash | only for `--recover-testnet`, when a deploy response was lost |

```sh
npm run hardhat:deploy:testnet
# review packages/nextjs/lib/deployment.candidate.json, then copy it to deployment.json
npm run next:build
```

If a deploy is interrupted, preserve its attempt journal and compiled artifact;
do not deploy again from this or a fresh checkout. Run
`node scripts/deploy.cjs --recover-testnet` from `packages/hardhat`. It only reads
the chain and never signs. Review the [recovery limits](docs/INSTALL.md#recovery-after-a-lost-deployment-response)
before accepting a candidate.

## Public evidence

The first two rows are completed. The others are filled only with verified public
links from our own testnet run. A submitted hash alone does not count.

| Required evidence | Current state |
| --- | --- |
| Public source repository | Done: https://github.com/rafaorlando3/deliverproof |
| Fresh external CLI installation on a clean runner | Done for source `02dd518`: [run 36556660288](https://github.com/rafaorlando3/deliverproof/actions/runs/36556660288), evidence artifact sha256 `d68d1c67dab18ba0982551793604874d8c72180a30f201d44aba73ac55bf9233` |
| Contract address, runtime hash and canonical deployment receipt | Pending |
| First agreement creation and exact deposit (tinybar × 10^10 in RPC) | Pending |
| Delivery commitment, preserved-root CID and public CAR retrieval | Pending |
| Buyer approval and separate supplier withdrawal receipts | Pending |
| Second agreement refund and separate buyer withdrawal receipts | Pending |
| Verifier observation/export and screenshot for the same agreements | Pending |

## Tests

| Suite | Command | Checks |
| --- | --- | --- |
| Core (vitest) | `npm run core:test` | 113 passed, 1 skipped on 02dd518: commitments, CAR limits and tampering, verifier codes, log windows, supplemental HCS checks and publisher error/receipt handling |
| Contract (Hardhat) | `npm run hardhat:test` | 38 passed on 02dd518: deadlines, exact deposit, credits and withdrawal, reentrancy, liability invariant, deploy journal and recovery |
| Chain (vitest + local node) | `npm run chain:test` | 46 passed on 02dd518: Solidity/TypeScript commitment vectors, reorgs, missing logs, wrong contract, unit scaling, read failures and HCS snapshot races |

The counts above come from reviewed cloud logs on Node 22.22.2 for 02dd518.
The executable source, configuration, lockfile and tests in this integration match
that candidate byte for byte; the integration also updates documentation. Node 20
and 24 were not rerun for HCS. The public CLI installation of 02dd518 independently produced the same test
counts on Node 22.22.2; it did not repeat lint or the formatter. The subsequent
documentation update changes no executable file, test, configuration or lockfile;
its new Markdown bytes were not regenerated through the CLI. See [STATUS](docs/STATUS.md) for the evidence boundaries.
`npm run next:lint` (zero warnings allowed), `npm run next:check` before and after `npm run next:build`,
and `npm run format:check` complete the checks. The former cleanup-ref lint warning is fixed in source.
The public workflow adds lint and a production boot check on 127.0.0.1 for this commit; its result is recorded outside this tree.
Formatting excludes Markdown and evidence artifacts.

## Limits

- Testnet only. There is no mainnet configuration. Each agreement holds at most 10 test HBAR.
- Byte verification establishes correspondence to the recorded commitment. It does not establish authorship, quality, recipient acceptance or when the recipient obtained the file.
- A CID does not guarantee continuing availability. Preserve the CAR and keep it pinned; successful offline verification is not public IPFS availability.
- There is no arbitration. Silence never pays the supplier; the buyer can refund after the review deadline even if a file was submitted.
- Direct EOA participants only; general smart-wallet/forwarding-contract support is not claimed.
- The deployment journal protects one preserved checkout. Storage durability and real-network recovery still need their documented acceptance checks.
- ESLint 9.39.5 is a recorded temporary unsupported development-tool exception; see STATUS for the separately validated replacement requirement.

## AI-assisted development

See [AGENTS.md](AGENTS.md) for the invariants and checks an AI coding assistant must follow in this project.

## License

MIT. Original work. The official Scaffold-HBAR layout and manifest format were followed for compatibility. Sources: [docs/SOURCES.md](docs/SOURCES.md).
