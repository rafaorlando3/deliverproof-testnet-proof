# Installation and operator guide

Public source template, not a live Hedera demo. Installation, build and frontend
startup do not transmit public transactions or pin files. Contract and chain
tests deploy fixtures to an isolated local EVM; those fixture deployments are
not a public Hedera deployment.

## Reproducible installation gate

The recommended recorded runtime is **Node 22.22.2 with npm@10.9.7**.
Keep the reviewed lockfile. The accepted correction b55b656 removes a test-only direct
TypeScript import that failed on Node 20.18.3. Its recorded report uses tested source
15c65ba and CLI 0.4.0 generated projects, with all commands passing on:

| Node | Actual package manager | Dependency-engine warnings |
| --- | --- | --- |
| 20.18.3 | npm@10.8.2 | Two unsupported-engine entries (10 log lines) |
| 22.22.2 | npm@10.9.7 | None observed |
| 24.21.0 | npm@11.19.0 | None observed |

The 20.18.3 entries concern vite@7.3.6 and eslint-visitor-keys@5.0.1, which require
at least 20.19.0 on the Node 20 line. This is observed compatibility under ordinary
installation, not engine-strict support. Other installation deprecation notices
and one frontend lint warning remain; “exit 0” does not mean warning-free.
The manifest declares `>=20.18.3 <21 || >=22.18.0 <23 || >=24.0.0 <25`.
Do not claim that every later version was validated, for Node or for npm.

Source b55b656 differs from tested 15c65ba only in STATUS.md; the guide edits
that followed that battery affected documentation only. HCS was added later and
validated on Node 22.22.2; the old Node 20/24 results do not cover HCS. See [STATUS](STATUS.md) for acceptance boundaries. Record the SHA, actual runtime and installation mode for a release
candidate. Do not regenerate the lock merely to hide an installation failure.
The reported Node-compatibility battery used ordinary `npm ci --no-audit --no-fund`;
its results must not be described as an `--ignore-scripts` run.

The independent release checks are:

```sh
npm ci --no-audit --no-fund
npm run check
npm run core:test
npm run hardhat:test
npm run next:lint
npm run next:check
npm run next:build
npm run next:check
npm run chain:test
npm run format:check
```

Run each independently and preserve its exit status. Documentation-only edits
need static link/command/evidence review, not automatic repetition of all suites. The aggregate `npm run test`
uses fail-fast behavior; it is not sufficient evidence if core fails. Run the
frontend type check again after Next has generated its route declarations.
`next build` must produce a complete build, not merely a started process.

After a complete build, `npm run next:start` serves only the loopback
interface on port 3000. Development uses `npm run next:dev`. There are no remote
fonts, backend secrets or database. The stock deployment JSON is `null` and
the UI must remain useful as a disabled, clearly labelled source preview.

## Local EVM rehearsal

The contract uses raw tinybar-equivalent accounting units on chain 31337.
These local values are **not** real Hedera currency behavior. Wallet gas and
native balance displays use 18 decimals on that EVM; do not infer HBAR payouts.
The frontend shows agreement amounts divided by 10^8 as HBAR-equivalents.

Compile with `npm run hardhat:compile`, start
the loopback node with `npm run hardhat:node`, and explicitly call
`npm run hardhat:deploy:local`. Keep deterministic development account keys out
of captured logs; Hardhat prints them at startup, so suppress that startup output.
Use unlocked loopback accounts for the rehearsal, never a personal wallet.

The deployment utility writes only a **candidate** public manifest after checking
the canonical successful receipt and the compiled runtime hash. It refuses a
pre-existing candidate/configured deployment and a prior attempt journal instead
of silently deploying again. Before its first possible transmission it exclusively
creates and flushes `deployment.attempt.jsonl`: only chain, sender, reserved nonce,
expected CREATE address and compiled-code hashes. The public transaction hash is
appended when available. No key or signed transaction is stored.
Review `packages/nextjs/lib/deployment.candidate.json`, verify the source/artifact,
then copy its public contents to `packages/nextjs/lib/deployment.json` in the
rehearsal checkout. Rebuild/restart the UI after installing the manifest.
Never present a local address as a public testnet deployment.

## Testnet deployment

This package configures no account, faucet, key, funded transaction or IPFS
service. Deploying and pinning are explicit actions you take with your own test
account and pinning service. Stop if a service requests payment or a card.
Never use mainnet.

The explicit script `npm run hardhat:deploy:testnet` accepts only chain **296**
at the fixed public `https://testnet.hashio.io/api` endpoint. It requires
`DELIVERPROOF_TESTNET_AUTHORIZED=yes` and `DELIVERPROOF_TESTNET_PRIVATE_KEY` in
the runner's protected process environment. Do not place the key in command
arguments, shell history, dotenv, a repository, chat, screenshots or logs.
The script never reads dotenv and intentionally suppresses raw library errors.
No key is passed to or embedded in the frontend. Clear the runner environment
afterward. Review the resulting public candidate manifest before installing it.

A submitted hash is not a completed deployment. An interrupted/failed wait must
be investigated using its durable public attempt journal, account/nonce and hash.
A second deploy invocation is refused even if the first wait failed or the process
died before the public hash was returned. Do not delete the journal to bypass this
block. Use the read-only recovery mode below; it never signs or broadcasts. Acceptance
requires actual testnet proof of exact funding, approval-credit, withdrawal and
refund, including tinybar (Solidity) versus 18-decimal RPC value. A local EVM
pass cannot close this gate. Gateway/RPC availability and historical block reads
must be checked on the real selected provider; the verifier fails inconclusively
when history is incomplete or unavailable.

## Recovery after a lost deployment response

Preserve the public journal in the same checkout along with its compiled artifact.
These commands perform only RPC reads and write a candidate after validation:

```sh
# From packages/hardhat, for the isolated local rehearsal:
node scripts/deploy.cjs --recover-local
# For an earlier testnet deployment, using its public journal:
node scripts/deploy.cjs --recover-testnet
```

Recovery needs no private key and does not instantiate a signer. If the journal
already contains a transaction hash, that exact hash is used. If transmission
may have happened but no hash was returned/recorded, independently locate the
transaction by the recorded sender and nonce, and supply its **public** hash via
`DELIVERPROOF_RECOVERY_TX`. A supplied hash cannot replace one already recorded.
Missing/torn journal, unknown transaction or inconsistent evidence remains blocked.
A prepared journal is not proof that a transaction was submitted or that nothing
was submitted. Absence at one RPC is not permission to deploy again.

Acceptance compares chain, sender, nonce, creation target, zero attached value,
creation-code hash, predicted address, canonical successful receipt and deployed
runtime against the original intent and local compiled artifact. It never accepts
an arbitrary successful transaction merely because the runtime looks similar.
The candidate still needs operator review before enabling the UI.

This is a **single-checkout** guard, not a distributed deployment coordinator. Keep
the journal outside disposable build cleanup and preserve it before transferring
runners; never start another deployment from a fresh checkout while the previous
attempt is unresolved. Don't run deployment concurrently with another transaction
from the same account. In disposable local tests only, reset the entire isolated
chain/checkout between unrelated fixtures. Real testnet recovery, address-format
behavior and persistent-runner storage are still acceptance gates, not proven here.

## Workflow and file availability

1. Buyer creates immutable terms, a different supplier, exact amount up to 10
   test HBAR, and two future deadlines. Save/share the exact UTF-8 terms text.
2. Either participant can read agreement evidence without a wallet. Paste the
   shared terms and check the hash. Buyer explicitly deposits the exact amount.
3. Supplier selects **one public synthetic file** (1 byte to 1 MiB) and its declared
   media type. Preparation creates a raw CIDv1 CAR locally. It uploads nothing.
4. Download that CAR. Pin it with an IPFS service that supports CAR import. Generic file
   upload to a pinning provider may re-encode it as UnixFS and change the CID;
   use CAR import preserving the root. Then retrieve and verify the exact CID.
5. Supplier records the delivery only after its retrieved bytes verify. Buyer
   independently verifies network history and file bytes, downloads the verified
   bytes for content review, then explicitly approves the recorded commitment.
6. Approval creates supplier credit. Withdrawal is another signed transaction.
   Only its canonical successful receipt and matching event establish withdrawal.
7. Supplier may voluntarily refund; buyer may refund strictly after the review
   deadline. A refund creates buyer credit, which also needs withdrawal.

Both sides acknowledge: silence does not release funds, and the buyer can reclaim
the deposit after the review deadline **even if a file was submitted**. There is
no arbitration or automatic assessment of work quality. Deadlines use chain time;
UI funding requires 60 seconds of margin, without guaranteeing inclusion.

An offline CAR can verify recorded content when a gateway is unavailable. That
does not prove public IPFS availability. Never label a failed/partial fetch as
invalid work or success. Exported evidence JSON is a record of observations;
it cannot change the trusted deployment and is not proof of future availability.

## External Scaffold-HBAR template gate

`template.json` declares Next.js, Hardhat, the `npm` package manager and the custom core workspace.
The official CLI's local template override (`CREATE_SCAFFOLD_HBAR_TEMPLATE_DIR`)
can exercise copy/normalization before a public repository exists.
Record CLI version/commit and exact command, inspect generated package scripts,
then repeat the clean locked build in the generated directory. Do not assume
direct checkout success proves the scaffold transformation worked.

The public install uses `npx create-scaffold-hbar@latest --template
rafaorlando3/deliverproof` with frontend Next.js, Hardhat, npm, **testnet**, and no
automatic skills installation. A clean install of source `e43e970` with CLI 0.4.1
on a GitHub-hosted runner, without the local override, is recorded in
https://github.com/rafaorlando3/deliverproof/actions/runs/36538164582. It covers that source only.

The newer HCS integration `582022e09f191bed702d74afea501dba26412c3d` was independently
installed with public CLI 0.4.1 in [run 36544715934](https://github.com/rafaorlando3/deliverproof/actions/runs/36544715934),
with the same runtime and no override. The five documented workflow commands
passed: check, core:test (72 passed/1 skipped), hardhat:test (38), next:build and
chain:test (45). All eight Markdown documents matched the source. The CLI omitted
template.json, changed packageManager to npm@10.0.0 in three manifests and changed
package-lock.json; the actual runtime remained npm@10.9.7. The other 56 source
files matched by SHA256. This is installation evidence, not a testnet or IPFS proof.


The HCS publisher and sanitization delta `02dd5182ab21b9398861a419fe9ed825f39b2438` were then
installed through the same public CLI in [run 36556660288](https://github.com/rafaorlando3/deliverproof/actions/runs/36556660288).
Node 22.22.2 and npm@10.9.7; no secrets, override, IPFS upload or public transaction.
Install, check, core:test (113 passed/1 live-mirror test skipped), hardhat:test (38),
next:build and chain:test (46) passed. The template main stayed at 02dd518 before
and after installation. Artifact SHA256 `d68d1c67dab18ba0982551793604874d8c72180a30f201d44aba73ac55bf9233`
was checked after download. The generated tree has 65 files versus 66 in the
template: template.json omitted, three manifest metadata changes and a different
lockfile. All other 61 files, including the eight Markdown documents present in
02dd518, match by SHA256. The documentation recording this result was added later
and was not regenerated through the CLI. Lint/format were not repeated in the
public workflow. A CLI tar@6.2.1 deprecation/security warning remains.

HCS is opt-in library code: constructing an adapter is not a live proof, and this
template provides no protected operational HCS runner or UI integration. Keep
transaction-attempt journals outside the library across runner interruptions; an
unknown result requires reconciliation, not an automatic retry.


### Observed CLI 0.4.0 differences

The official CLI 0.4.0 has been exercised using its local-template override in the
cloud, first on M2b and later in the Node-compatibility candidate battery. It
installs with `npm install --legacy-peer-deps`; that is distinct from the separate
clean `npm ci` checks after generation. Inspect generated scripts and compare the
lockfile before attributing a result to the source checkout.

The CLI normalizes `packageManager` to npm@10.0.0 in the generated manifest. That
metadata is not evidence that npm@10.0.0 ran. The actual three tested combinations
are listed above; the source pin remains npm@10.9.7. Do not claim upstream
normalization was patched by this template.

The CLI also rewrites package-manager words in Markdown. Version tokens such as
npm@10.9.7 and explicit `npm run test` commands reduce accidental substitution.
Review the generated instructions after a documentation change, not just the
source Markdown. A candidate generated by the local override is still not proof
that the eventual public external-template install works.

The earlier missing-format warning was resolved by the separately reviewed real
Prettier script and lock delta. The latest supplied candidate-generation logs
show no format warning. `format:check` excludes Markdown, lockfiles, evidence and
selected generated files according to `.prettierignore`; it is not a documentation
review. Never format immutable review packages or evidence artifacts in place.
