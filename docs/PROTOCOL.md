# Protocol v1

Status: local contract, core and chain tests pass; public testnet and IPFS validation are pending (see [STATUS](STATUS.md)).

## State and time

Missing → Draft → Funded → Submitted → Approved, or Funded/Submitted → Refunded.
Approved and Refunded each produce one credit, paid only by withdraw.
No terms update, replacement delivery or destructive reset after creation.

The buyer creates the agreement; the supplier cannot alter its terms. The buyer
funds by deliveryDeadline inclusive. The supplier submits by the same inclusive
boundary. Funding at that exact boundary leaves no usable delivery margin; the
UI must show this and recheck chain time immediately before funding. It must not
promise that an enabled button guarantees inclusion before the deadline.
Approval is by reviewDeadline inclusive. Buyer timeout refund is only
strictly later. Supplier refund is voluntary from Funded or Submitted. No third
party can resolve disagreement. A supplier accepts the commercial risk of no
approval before timeout; this policy must be visible before either party acts.

Drafts are unfunded and may expire without holding funds. Current M1 does not
implement draft cancellation because no funds exist there. Unknown IDs revert.

## Accounting

`amountTinybar` uses 8-decimal HBAR integer units in Hedera Solidity.
For Hedera JSON-RPC `tx.value`, multiply by 10^10 exactly. Never use floating point.
Ordinary Hardhat does not reproduce this behavior; its `msg.value` is a raw unit.

Deposit increments totalLocked. Resolution atomically moves it to totalCredits.
Withdrawal decrements totalCredits before the external call, with reentrancy
protection. A reverted transfer rolls all changes back so credit remains retryable.
Per-agreement withdrawal status prevents confusion with another payment.
Balance >= totalLocked + totalCredits (equal unless forcibly donated).
No admin drain; forced donations do not create credits.

## Delivery commitment

`keccak256(abi.encode(domain, chainId, contractAddress, agreementId, termsHash,
keccak256(UTF8(cid)), fileSHA256, uint64(fileSize), uint8(mediaType), uint32(1)))`.
Domain = keccak256(UTF8("DeliverProof.delivery.v1")).
CIDv1 canonical base32; multihash sha2-256; raw or UnixFS dag-pb file only.
One final version, at most 1 MiB, media 1 text/plain, 2 JSON, 3 PDF. MIME is an
assertion by the supplier, not a security certificate. Never render HTML from
untrusted delivery bytes. Display text safely or offer a download with a warning.
The on-chain contract binds metadata but cannot inspect the file or parse a DAG.
The verifier validates the CID; the contract only restricts length/alphabet.

## CAR and trust boundaries

Read at most 4 MiB and 512 block records, including repeated CIDs. Decode records
progressively and count every record before hashing it; the map of unique CIDs
does not bound repeated-record processing. Verify every sha2-256 block before
making it available to the UnixFS exporter. Only then reconstruct and compare
file SHA/size. Missing blocks/unsupported encoding/transport failure are
inconclusive; explicit mismatches have separate codes. A malicious gateway is
not evidence that the supplier acted maliciously. Gateway URL is allowlisted,
redirects rejected, credentials omitted; browser output must not execute payloads.
No pinning service or availability promise exists yet.

The M1 transaction helper checks typed receipt structure, observed status and
transaction hash. It deliberately does not attest payment, expected chain,
contract, event, deployment code or canonical history. Full network verification
is a later gate; UI cannot infer payment from the helper alone.

## HCS evidence trail (supplemental)

The contract history checked by `verifyAgreement` stays the only canonical record.
An optional Hedera Consensus Service topic can carry one message per verified
contract event. The operator supplies the topic ID and its single submit key
(ED25519 or ECDSA secp256k1) next to the trusted deployment; neither comes from a
message, URL, wallet or upload. The submit key must be the raw single key the mirror
node returns: ED25519 as 32 bytes (64 hex characters) or ECDSA secp256k1 as the
33-byte compressed point (66 hex characters starting with 02 or 03). DER, `0x`,
uncompressed or odd-length encodings make the result `inconclusive` before any read.

Message: canonical JSON with fixed key order and no whitespace, at most 1024 bytes,
never chunked: `v` 1, `domain` "DeliverProof.hcs.v1", `chainId`, lowercase
`contract`, decimal `agreementId`, `event`, lowercase `tx`, `logIndex`, decimal
`block`. The event identity is transaction hash plus log index, because Approved or
Refunded and CreditAvailable share one transaction. Any other encoding is ignored.

The check runs only after the contract history is verified. Results:
- `consistent`: every verified event has a message; retries count as duplicates
  and the earliest sequence number stays the reference.
- `incomplete`: some verified events have no message yet. Publishing can lag.
- `mismatch`: a message for this agreement names an event, block or transaction
  the contract history does not have, or the topic submit key differs from the
  trusted key.
- `inconclusive`: unprotected, deleted or unexpected topic, unsupported key list,
  malformed or oversized mirror data, more than 400 messages, or no mirror answer.
  Also `hcs_after_snapshot`: the contract is read up to its snapshot block and the
  topic afterwards, so a legitimate event mined after the snapshot, and its message,
  can appear in between. A message the history does not have, for a block after the
  snapshot, is neither a match nor a divergence: read the contract again, then the
  topic, and repeat the check. A message the history does not have inside the blocks
  already read stays a `mismatch`, even when a later message is also present.

No HCS result approves, pays, refunds or changes the contract verdict. Mirror reads
use the allowlisted testnet mirror, fixed paths, no credentials, no redirects, a
10 s timeout, 512 KiB per response and at most 4 pages of 100 messages. Trust
boundary: an independently queried mirror node, not a state proof.

### Publishing the trail

`createHcsTopic` creates the topic with the operator key as its only submit key and
no admin key, so nobody can delete the topic or replace its submit key later; memo
`DeliverProof.hcs.v1`. The operator records the returned topic ID and public key as
the trusted topic. `publishHcsTrail` runs the same check first and writes only when
the result is `incomplete`: the canonical messages still missing, in contract order,
one single-chunk submission each, at most 16 per run. It never writes on `mismatch`
or `inconclusive`, when the signing key differs from the trusted submit key, or for
bytes that are not the exact canonical encoding. After writing it rereads the mirror
(6 times, 3 s apart, by default) and reports `confirmed` only when the whole trail is
visible. A failed submission stops the run and reports what already reached
consensus; the next run rereads the topic and continues. A rerun while the mirror is
still behind can leave a duplicate, which the check counts and tolerates. Run one
publisher per topic.

This library does not persist transaction-attempt journals or include an operational
runner. A protected runner must preserve attempts across interruptions and reconcile
unknown results before another transmission. Live testnet use is still unverified.

`sdkTopicWriter` (Hiero JavaScript SDK, testnet only) pays and signs with one operator
account whose key is also the submit key. The caller reads the key from the process
environment; it stays inside the writer and never appears in a result, error or log; failures carry
only a code from a fixed list and, when the network returned one, a Hedera status name from a
closed list (`HEDERA_TOPIC_STATUSES`, checked against the SDK in the tests). An unlisted name is
dropped. Errors, receipts and keys coming from a writer or executor are read once inside a guard
and rebuilt from those fields; the original objects are never rethrown or returned.

## Evidence required before public readiness

Compile/type/test results and reviewed lockfile; clean install; exact
Solidity/TypeScript commitment parity; two real testnet participants; deposit,
submit, approve, credit, withdraw and timeout/refund receipts; Hedera unit check;
IPFS pin/retrieval; frontend review and read-only expected-deployment verification.
