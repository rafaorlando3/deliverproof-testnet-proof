# Protocol v1 — M1 cloud results received; public/testnet validation pending

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

## Evidence required before public readiness

Cloud compile/type/test results and reviewed lockfile; clean install; exact
Solidity/TypeScript commitment parity; two real testnet participants; deposit,
submit, approve, credit, withdraw and timeout/refund receipts; Hedera unit check;
IPFS pin/retrieval; frontend review and read-only expected-deployment verification.
