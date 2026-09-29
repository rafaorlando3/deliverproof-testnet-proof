# Status — 2026-09-29

## Current HCS publisher integration — 2026-09-29

Reviewed original commits 86d4a829b901dfe16d4ddff2a76a9712d63e8780 and
02dd5182ab21b9398861a419fe9ed825f39b2438 are public. The latter closes the review's
error-boundary findings: fixed code/status allowlists, guarded reads and rebuilt
errors/receipts. It adds a core publisher plus a testnet Hiero SDK adapter, with
canonical contract history still authoritative. No HCS UI or protected operational
runner is included, and no topic, message or other transaction was sent to Hedera.

Supplied cloud evidence on exact source 02dd518: Node 22.22.2, npm@10.9.7, clean
install/type/build/format success, core 113 passed+1 skipped, Hardhat 38, chain 46;
existing lint warning retained. The HCS subset also passed 41/41 in a networkless
namespace. Offline freeze/sign/serialization tests do not prove SDK transmission
or network acceptance. Node 20/24 were not repeated for this increment.

Independent public CLI install: [36556660288](https://github.com/rafaorlando3/deliverproof/actions/runs/36556660288),
workflow 6757cf35dc5d58f368daacfa5847ba7e1bc67c44 on validation/public-install,
CLI 0.4.1, Node 22.22.2, npm@10.9.7. Main was 02dd518 before and after.
CLI exit 0; check, core:test (113+1 skipped), hardhat:test (38), next:build and
chain:test (46) all exit 0. The skipped opt-in live mirror test is not a live
HCS success; no testnet secret or transaction was used. Lint/format were not
repeated by the public workflow. The CLI retains its tar@6.2.1 warning.

Artifact SHA256 `d68d1c67dab18ba0982551793604874d8c72180a30f201d44aba73ac55bf9233`,
20 evidence files; digest checked after download. The 65 generated files were
compared with 66 source files: template.json omitted, three manifests changed
only packageManager metadata, lockfile changed, remaining 61 files (including
eight Markdown files) byte-identical by SHA256. Registry version/integrity
unchanged before/after. An unauthenticated public source archive also matched
all 66 reviewed files.

This follow-up documentation edit records these results, corrects the README's
obsolete publisher limitation and marks the operator journal boundary. It changes
no executable source, configuration, dependency, lockfile or test from 02dd518.
The new Markdown bytes were reviewed statically, not regenerated through the CLI.

Still pending: own testnet deployment and lifecycle, public IPFS retrieval, live
HCS proof and final bounty submission. A protected runner and owner approval
remain required before real testnet operations. No project, installer or test
was executed on the Mac. Historical sections below retain their exact-source
acceptance boundaries.


## Previous verifier integration — 2026-09-29

Reviewed documentation candidates aaa9c03, bddf04d and f02b96f are integrated.
The README qualifies the deployment journal as local to a preserved checkout,
distinguishes unreadable CARs from content mismatches, and explains IPFS retrieval
without claiming that other transports cannot verify a digest.

The optional HCS verifier from 4eb876f and correction 76b989d is integrated.
Executable source, configuration, lockfile and tests match
76b989d610a24d76cf7eec32768cecd6e28b1581 byte for byte. Only documentation differs.
Contract history remains canonical; HCS is a supplemental comparison, with no
publisher or UI integration in this increment. Messages beyond the contract
snapshot yield inconclusive/hcs_after_snapshot; an invented event inside the
verified range still yields mismatch. Single raw key lengths are validated before
mirror reads.

Reviewed supplied cloud logs on Node 22.22.2: core 72 passed and 1 skipped,
Hardhat 38, chain 45; type checks, next build and formatting passed. Lint has the
existing one React hook warning. The old source fails four targeted unit tests and
two chain tests; the old-chain command also reports a second filter/no-test exit,
so the regression claim rests on the displayed assertion failures, not that exit
code alone. No code or test ran on the owner's Mac. Node 20 and 24 were not rerun
for this HCS correction.

Fresh public installation of integration `582022e09f191bed702d74afea501dba26412c3d` completed:
https://github.com/rafaorlando3/deliverproof/actions/runs/36544715934. Workflow commit
4e04e4d59c5f3fb1295438c8c132a5f385a8584e on validation/public-install, CLI 0.4.1,
Node 22.22.2 and npm@10.9.7, no secrets or local override. Main remained 582022e
before and after installation. CLI exit 0; check, core:test (72 passed/1 skipped),
hardhat:test (38), next:build and chain:test (45) each exited 0. The skipped test is
the opt-in live mirror check (HCS_LIVE_TOPIC was unset), not an observed live HCS
success. Lint and formatting were not repeated in this public workflow.

Artifact public-install-evidence-36544715934-1 has SHA256
`a6615b2e50837e85ab618edba6bf21457ac056dc31d182e763b7273b0fbe9bea`. Its 20 files were downloaded
and the digest independently checked. Generated tree: 60 files against 61 source
files. template.json is omitted; packageManager metadata changes in three
manifests and package-lock.json differs. Every other file, including all eight
Markdown documents and HCS source/tests, matches the installed source by SHA256.
The registry version and integrity were unchanged before/after the run. The CLI
emitted a tar@6.2.1 deprecation/security notice; success is not a claim of no
vulnerabilities. No private key or secret was supplied or needed.

The follow-up documentation commit records that result without rerunning suites;
its executable files, configuration, lockfile and tests remain identical to 582022e.
The earlier run below covers e43e970 only. Hedera deployment, live HCS use, public
IPFS retrieval and final bounty submission remain pending. No testnet credentials
or transactions are used in these reviews.

## Recorded public installation — 2026-09-29

Done and publicly checkable:

- The template source is public at https://github.com/rafaorlando3/deliverproof.
  Its main branch was `e43e9702c581fb26a776c802a272d5f9b4cd627b` when this note
  was written; executable source, configuration and lockfile are the ones accepted
  below.
- Clean install of that source through the official CLI 0.4.1 on a GitHub-hosted
  runner: https://github.com/rafaorlando3/deliverproof/actions/runs/36538164582
  (push of workflow commit `81b4f2f0aeb4c8bef85dfd89ed9a3e46746663b0` on the
  `validation/public-install` branch, conclusion success). Node 22.22.2 and
  npm@10.9.7, no secrets, no template override; the public main was
  `e43e970` before and after the install. The install and the `check`,
  `core:test` (53), `hardhat:test` (38), `next:build` and `chain:test` (43)
  scripts exited 0. The run artifact `public-install-evidence-36538164582-1`
  has sha256 `847852e9bf290180efe9337904cf56a04e10dd9be25928e3ad10f0a247ebafd2`.
  The workflow file was not merged into main. This run covers source `e43e970`
  only: later commits, including documentation commits, do not inherit it, and it
  is not a Hedera, IPFS or submission proof.

Confirmed:

- The bounty registration form was submitted and the organizer's automatic
  confirmation email was received. That is a registration, not a final submission.

Still pending, with nothing claimed:

- Our own Hedera testnet deployment and agreement lifecycle, with HashScan and
  mirror links.
- Public IPFS retrieval of a delivery file.
- The final bounty submission.

The README and this note separate the public source, the recorded public install
of `e43e970` and the pending Hedera, IPFS and submission evidence. These are
documentation-only changes: no behavioral suite was repeated for them.

## Previous documentary acceptance — C-0052

The three-line correction in 77927108893bc7049254749e162f914d8625eb98
is integrated over efcdaf5. Only README.md and docs/INSTALL.md change in
that reviewed delta. Codex checked all seven package hashes, the bundle,
its exact parent and the source diff. Supplied before/after cloud logs show
CLI 0.4.0 rewriting the old installation command and two prose phrases;
the corrected template produces all eight Markdown files byte-identically
in the supplied comparison. The generator used a local template override
and --skip-install: installation, formatting, build and tests were skipped.
This closes the documentary transformation review, not the public-install gate.

The README now uses npx to invoke the generator; prose puts punctuation after
the package-manager name to avoid its text-rewriting rule. The restriction on
execution in the owner's Mac checkout remains explicit. This status update is
an additional documentation-only change; it is reviewed statically, without
claiming another generator run or repeating the unchanged behavioral suites.
Executable source, configuration and lockfile still match tested 15c65ba.

A separate read-only testnet-evidence helper was reported in C-0052, but its
source and execution artifacts were not supplied in this package. It has not
been reviewed or integrated. A third-party contract smoke check cannot establish
our own deployment, agreement lifecycle or content verification. The pending
Hedera, public IPFS and external-template gates below remain unchanged.

## Previous integrated acceptance — C-0050/C-0051

The Node 20 compatibility delta b55b656 and the adapted evaluator guide are
now integrated. C-0051 supplied the missing tested source ref
15c65ba336b04e114241628bfa0c3fdcd59b517e; Codex checked all three supplement
hashes, bundle integrity and the full Git tree comparison. b55b656 and that
source differ **only in docs/STATUS.md**. Guide commits affect only README.md,
AGENTS.md, docs/INSTALL.md and this status file. Executable source, configuration
and lockfile therefore match the tested source exactly. Documentation-only
commits are not described as newly executed full-suite results.

C-0050's original four artifact hashes and the guide's three hashes were checked.
Its cloud logs show 6cb74c7 failing the Hardhat before-hook on Node 20.18.3 due
to direct TypeScript import. The correction moves the same six commitment
vectors into Vitest chain tests and checks Submitted fields, with no production
contract, verifier or UI changes and no changed dependency versions. The lock
changes only root engine metadata.

Accepted supplied results for CLI 0.4.0 local-template generation and independent
checks on 15c65ba: Node 20.18.3/npm@10.8.2, 22.22.2/npm@10.9.7 and
24.21.0/npm@11.19.0 all exit 0; core 53, contract 38, chain 43; lint has one
warning; generated trees are clean; formatting has no warning. These are
reviewed cloud logs, not Mac executions. Two Node 20 unsupported-engine entries
span 10 EBADENGINE log lines, not ten distinct dependency problems. Vite and
eslint-visitor-keys require at least 20.19.0 on that major line. Engine-strict
20.18.3 support is not established; preferred recorded runtime is 22.22.2.
Installation deprecation notices remain. The supplied Node 20 binary was not
hash-checked before its archive was removed, as disclosed in the source report.

The supplement contains the previously missing mutation command/log: changing
CID hashing to hash the uppercased CID causes the cross-language assertion to
fail (one failing test). Source restoration is reported; the received final
Git source is unmutated. This is reviewed supplied mutation evidence, not a new
Codex execution or proof that all possible commitment defects are detected.

The guide now has a product introduction, architecture, setup, environment table,
explicit pending public evidence, byte-verification limits and transaction rules.
INSTALL removes superseded M2b/formatter claims. Direct Mac execution restrictions
remain. Static checks found all 14 relative links and four anchors, declared root
script names and balanced fences, with a clean git diff whitespace check.
Markdown is excluded from the formatter. The documentary transformation review
was subsequently closed by C-0052 above; no unchanged behavioral suite was
repeated for those text corrections.

Hedera deployment, public IPFS retrieval and public external-template installation
remain pending. No account, faucet, public transaction, pinning, repository
publication or competition submission was performed in this review.

## Previous integrated acceptance — C-0049

Main 9ef66f8 integrates the seven reviewed commits through 6cb74c7. On that main
commit, executable source, configuration and lockfile are identical to candidate
6cb74c70ca23c788148a6b2af80f6bd16be0d7e9; only this status document differs.
Historical pending descriptions below are superseded by this acceptance and the
C-0049 section. UI-01/UI-02/UI-03 review is closed within the simulated-wallet,
cloud-local EVM scope. Hedera testnet, public IPFS and public distribution remain
pending. No competition submission or public deployment has been made.

## M1 source and cloud review

- Solidity agreement, exact funding, single submission, commitment-bound approval,
  voluntary/timeout refund, per-agreement credit withdrawal and reentrancy guard.
- CAR block hashing and UnixFS reconstruction, domain commitment and tinybar/RPC conversion.
- Initial source f9cfe50: Claude reported type checking passed, core 15/16,
  contract 19/19. The failed UnixFS test constructed a CAR with the wrong codec;
  the verifier correctly rejected it as missing the requested root block.
- Reviewed and integrated Claude commits through 6bf43b5: package lockfile, corrected
  recording fixture plus a negative regression test, three independent contract tests.
- Supplied cloud logs on 6bf43b5: core 17/17 and contract 22/22; type check passed.
  Six cross-language commitment cases matched Solidity and viem. A fixed-seed
  220-step sequence exercised approved/refunded/withdrawn outcomes and accounting.
- Codex checked package hashes, source delta, log totals and integrated the exact
  commits. No project, test, compiler or installer was run on the Mac.
- At M1 acceptance, follow-up edits affected documentation/runtime metadata only;
  M1 executable code and tests matched the tested commit. M2 changes are separate. A fresh cloud npm ci with the reviewed lockfile
  remains an installation check; the reported first run used npm install.

## Decisions from review

1. Use recorded Node 22.22.2/npm@10.9.7 by default. The former test-only Node
   22.18 type-stripping requirement is addressed by the separate C-0050 candidate
   described above; its Node 20 and 24 results have their own evidence boundary.
2. Keep inclusive funding/submission boundary in the documented protocol. UI must
   expose remaining chain time and require usable margin, without promising inclusion.
3. Explain before participation: silence never pays the supplier; after review
   deadline the buyer can refund even a submitted delivery. No dispute arbitration.
4. tinybar/weibar behavior remains a Hedera testnet gate. Local EVM success does
   not prove deposit/withdraw conversion on chain 296.
5. Cloud reviewer/CI must record core and contract runs independently. npm run test
   keeps fail-fast behavior; its short-circuit is explicit, not a full-suite result.

## M2a independent review received (not testnet)

- Claude supplied 15 hashed artifacts for 7f4c383 + review 84f1fec: clean npm ci,
  core 30/30, contract 22/22, chain/ABI 34/34 on an ephemeral cloud Hardhat node.
  Ten check-removal mutations were caught. Codex checked hashes/delta/log totals.
- Integrated that test-only review as de5e39f over M2b, resolving the root scripts
  conflict by keeping both the frontend scripts and chain:test. No local execution.
- This is evidence for M2a, not for the subsequent frontend or M2c changes.

## M2 source increment and reviewed M2b cloud evidence

- M2a commit 7f4c383: independent deployment/code/receipt/event/state verifier and
  13 written tests. Package delivered to Claude through X-0030. No execution here.
- M2b: original Next.js interface, core exports, browser-local CAR preparation and
  tests, scaffold manifest, guarded explicit deploy script and operator/cloud guides.
- UI covers create/deposit/submit/verify/approve/refund/withdraw, explicit wallet
  confirmation, shared-terms hash, policy acknowledgement, verified-byte download,
  public observation export and invalidation on account/network/agreement changes.
- The default deployment manifest remains null. No public contract or invented hash.
- Root workspace/dependency metadata includes the frontend. The reviewed M2
  lockfile from 42ee818 is now integrated: 446 to 823 package entries, 377 added,
  none removed. Four existing dependency entries change only dev/devOptional
  classification; versions/resolved/integrity of existing dependencies are unchanged.
  The root workspace metadata also changes. Workspace links have no registry
  integrity by design; new registry packages carry integrity metadata.
- This frontend has not been run, rendered or built on the Mac. Source inspection
  and packaging do not prove compilation, layout quality or successful workflow.
- The deploy utility writes a public candidate only after receipt/runtime checks;
  installing it is a separate operator review. It has not been executed here.

## M2c correction increment — written, pending cloud acceptance

- Read event history in consecutive inclusive windows limited by real block
  timestamps (six-day maximum). No estimated block cadence. Caps: 64 log requests,
  256 timestamp reads, 256 aggregate events and 60 seconds between operations.
  In-flight requests retain the transport's 15s cap. An incomplete read is discarded
  as inconclusive, never accepted as proof of missing events or successful payment.
- Added the 14 contract errors and typed UnknownAgreement recognition. A transport
  failure whose text mentions the error is still a transport failure.
- Real forwarding-contract events are inconclusive/unsupported_caller only after
  successful canonical receipt membership checks. Direct EOA callers remain the
  supported model; no general smart-wallet support is claimed.
- Test helper drains Hardhat output without logging development private keys,
  bounds its readiness buffer, and terminates the child on startup failure/timeout.
- Sixteen unit regressions written plus an eight-day real EVM time-gap regression
  and updated ABI/negative chain expectations. None executed on the Mac.
- Browser preflight currently uses client.call; cloud UI acceptance must also check
  named revert presentation. ABI parity alone does not prove friendly UI errors.

## M2d deployment-recovery increment — written, pending cloud acceptance

- Static review found that candidate-only guarding allowed an operator to rerun
  deploy after a submitted transaction timed out, because no candidate existed yet.
- Before any possible send, the utility now reserves a durable, exclusive public
  attempt journal with sender/nonce/code context. Existing intent blocks new sends,
  including prepared intent after an interrupted/unknown result. No secret or signed
  transaction is stored; the guard is limited to this checkout and preserved files.
- Explicit recovery only reads the existing transaction and validates its original
  context before writing a candidate. It does not instantiate a signer or wallet.
- Seventeen journal/CLI regression cases written using a temporary filesystem and
  injected provider. None run here; actual cloud EVM rehearsal is still requested.
- No contract, wallet UI, dependency versions or deployment authorization changed.

## M2b acceptance boundary (C-0044)

- Independently checked all 26 package hashes, Git bundle integrity, dependency
  fields, source patches and supplied log totals. Six loose screenshots were
  recompressed in transfer; original captures remain in the hashed archive.
- Supplied clean cloud logs on **42ee818**: core 32/32, contract 22/22, chain/ABI
  41/41; types, lint and full Next build passed. Lint retains one cleanup-ref
  warning; zero lint errors does not mean zero warnings.
- Browser rehearsal records 56/56 checks: real ephemeral cloud-local EVM,
  approval/withdrawal and both refund paths. IPFS retrieval was simulated only in
  the harness. Desktop/375px captures support layout observations, not testnet.
- Normal official CLI 0.4.0 generation and a clean locked build of its output
  passed with the known format warning and metadata/text transformations recorded
  in INSTALL.md. Local-template override is not public external-template proof.
- Integrated lock, lint dependency compatibility, Next Link/config, generated
  declarations and seven independent chain regressions. The existing M2a suite
  was not duplicated. Rejected estimated fixed-block pagination in favor of the
  existing timestamp-bounded M2c implementation. Combined result is untested.
- **ESLint 9.39.5 is an explicit temporary unsupported development-tool exception.**
  ESLint 10.11.0 crashed eslint-plugin-react 7.37.5 in the supplied cloud run.
  Keep effective React lint rules while preparing a separately validated
  compatible supported configuration. ESLint 9 reached EOL on 2026-08-06;
  official source checked 2026-09-28: https://eslint.org/version-support/ .
  This exception does not authorize paid support or imply production readiness.
- **UI-01 is still open**: a send/receipt timeout or context change can lose the
  original transaction hash and allow another create. Claude is preparing a
  red/green reproduction and separate fix. The 56-check rehearsal did not close it.

## M2e content-work bound — written, pending cloud acceptance

- Static review found that the 512-block cap counted distinct stored CIDs, while
  repeated CAR records still consumed decode/hash work. The complete reader also
  indexed all records before that cap was checked. The 4 MiB input cap still held;
  no browser stall or incident was observed and no timing claim is made.
- The source now uses the existing dependency's progressive CarBlockIterator and
  counts all records, including duplicates, before hashing each admitted record.
  Up to 512 records are allowed; excess is inconclusive/block_limit. Every admitted
  duplicate still needs a matching hash, and all original DAG/content checks remain.
- Three regression cases written: 512 repeated records preserve verified bytes;
  513 repeated records under the byte cap are inconclusive; a later repeated CID
  with corrupted bytes is a hash mismatch. Not executed on the Mac. Claude must
  demonstrate the failing old case and passing corrected case in the cloud, then
  run core/type/build checks and browser CAR preparation/retrieval in the combined
  checkout. No new dependency, wallet/UI change, network access or upload added.

## C-0046/C-0047 review and remaining UI identity correction

- Codex reviewed C-0046 package hashes/deltas/logs (29/29 and 10/10). Supplied
  ac47adc cloud results: core 53, contract 39, chain 42; lifecycle 56/56 and
  UI-01 12/12. M2c/M2d/M2e evidence is accepted within that cloud-local scope.
  Deployment crash/concurrency recovery involved zero recovery sends; fsync,
  reorg and reverted-deploy scenarios remain untested. This supersedes the older
  pending-evidence descriptions above, not the source-integration boundary.
- UI-02 (manual release of unknown attempts) and UI-03 (wrong-hash resolution)
  prevented integration of ac47adc. C-0047 supplied 5861c2b. Codex independently
  checked 11/11 hashes, bundle provenance, the source delta and provided results:
  baseline ac47adc 2/11; revised UI-02/03 12/12, UI-01 12/12 and lifecycle 56/56;
  clean install/types/lint/build/format passed in the supplied cloud logs.
- UI-02 and the known-original-hash corrections are accepted technically. The
  hashless path still resolved by matching sender/call/value, nonce >= an observed
  pending nonce and a later block. Another tab can produce an identical call;
  those predicates do not establish which wallet request produced a transaction.
- Separate proposed review commit **6cb74c70ca23c788148a6b2af80f6bd16be0d7e9**
  on **5861c2b4fc05c41482eb508df7df2946a9f8491a** removes that inference. A
  hashless attempt remains unknown during arbitrary transaction lookups; the
  observation can be displayed independently. Known hashes/nonces retain their
  recovery path, and the original hash remains visible after replacement.
- Candidate source is in refs/review/codex-ui03-identity, not the working branch.
  Immutable bundle, one-commit patch and cloud acceptance plan are in
  ../revisoes/deliverproof/parecer-codex-ui0203-2026-09-28/.
  This candidate has not been executed or accepted. Existing lost-response tests
  must change their expected outcome before cloud validation; old green totals
  do not validate the new behavior. Main executable source remains 5875fe3.
- No project/test/compiler/installer/server/container was run on the Mac.
  The in-memory-only limitation persists; reload is not proof of safe resending.

## C-0048 public relay preflight — limited evidence reviewed

- Codex checked all seven entries listed in the supplied preflight SHA256SUMS
  and read the scripts/output without executing them. The recorded sample
  supports CREATE receipt/address shape, block-level log indexes, matching
  receipt/block hashes, the tinybar conversion and the two getLogs limit errors.
- Equal getCode lengths alone do not establish bytecode equality. The supplied
  eth_call excerpt contains reverts, not the claimed differing historical
  totalSupply values. Full targeted values/digests and block identifiers are
  still needed to close those two preflight assertions; custom-error decoding
  on our own deployment also remains unverified.
- This evidence concerns third-party contracts at the recorded time, not a
  DeliverProof deployment. A short evaluator guide may be prepared separately
  with pending evidence clearly labelled; accounts, faucet, pinning, deployment
  and public repository publication remain outside this review action.

## C-0049 candidate and relay evidence accepted

- Codex checked 32/32 package hashes, the unchanged candidate delta, the new
  harness and JSON/log totals. The identical external-call counterexample fails
  on 5861c2b (UI-03 6/13) and passes on 6cb74c7 (13/13). The fixed UI makes one
  original send, zero sends while looking up the external transaction and no
  third creation; the separately counted fixture send is not a UI send.
- The unchanged old UI-01/UI-02 expectations each fail 1/12 on the candidate,
  as required by the corrected identity contract. After only those documented
  expectation changes, UI-01 is 12/12, UI-02 is 11/11 and lifecycle is 56/56.
  The conditional replacement-race path has an additional observed recovery
  check in the old-expectation run on the same candidate; do not claim 12/12
  for the final UI-02 run or sum these overlapping suites as unique cases.
- Supplied clean-clone logs on 6cb74c7 record npm ci, core type checking,
  frontend lint/types/build and formatting with exit 0, plus a clean tree.
  One previously accepted lint warning remains. Unchanged core/contract/chain
  behavior retains its earlier exact-commit evidence; those suites were not
  newly run in this package. No executable project validation ran on the Mac.
- UI attempts remain in memory only. Without the wallet-returned original hash,
  a lookup remains an observation and cannot release the attempt. Reloading is
  not proof that retrying is safe. Known-hash recovery and nonce-linked wallet
  replacement retain the original hash and separate mined-result provenance.
- Relay supplement: 3/3 hashes checked. The unsupported historical totalSupply
  claim was explicitly withdrawn. Supplied results instead show full historical
  balanceOf returns 0, 100000, 100000 and 300000 at four identified blocks, with
  the two differences matching recorded Transfer values. A fixed-block getCode
  comparison returns 8595 bytes, equal SHA256 and equal bytes for EVM/long-zero.
  These resolve the two C-0048 evidence gaps for the recorded third-party sample;
  they do not validate DeliverProof on Hedera or our own custom-error decoding.

## Required next

1. Actual Hedera testnet and public IPFS path after applicable direct account,
   faucet, pinning and deployment authorization. Verify our deployment receipt,
   deposit/credit/withdraw/refund, tinybar/weibar conversion and custom errors.
2. Done for source `e43e970` on 2026-09-29: clean external-template installation
   from the public repository (https://github.com/rafaorlando3/deliverproof/actions/runs/36538164582). A future executable change needs its own
   recorded install; the local-template generation is still not a substitute.
3. Competition eligibility, fresh competitor check, video and submission authorization.

Historical note, before 2026-09-29: there was no public repo then. The current
state is at the top of this file. Still true today: no deployment, paid service,
production money or competition submission.
At that historical checkpoint, executable source, configuration and lockfile
matched tested 15c65ba. The current HCS increment is recorded at the top.
The Node 20 correction changes test location and runtime metadata only; the
previously accepted UI-01/02/03 and lifecycle evidence remains at its recorded
boundary. Real Hedera/IPFS and competition readiness remain unverified.
