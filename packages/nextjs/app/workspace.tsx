'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  createWalletClient,
  custom,
  encodeFunctionData,
  isAddress,
  keccak256,
  formatUnits,
  parseUnits,
  stringToHex,
  type Address,
  type Hex,
} from 'viem';
import { deliverProofAbi } from '@deliverproof/core/abi';
import { prepareArtifact } from '@deliverproof/core/artifact';
import { verifyCar, fetchAndVerify } from '@deliverproof/core/content';
import { deliveryCommitment, rpcValueForTinybars, MAX_CAR_BYTES, type Delivery } from '@deliverproof/core/delivery';
import { verifyAgreement, type NetworkResult } from '@deliverproof/core/network';
import { deployment, clients, createdId, assertDeployment } from '../lib/chain';
import { explainPreflight, isWalletRejection } from '../lib/errors';

type Injected = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
  on?: (name: string, fn: () => void) => void;
  removeListener?: (name: string, fn: () => void) => void;
};
type Prepared = Awaited<ReturnType<typeof prepareArtifact>>;
type Action = 'create' | 'fund' | 'submit' | 'approve' | 'refund' | 'withdraw';
type Proof = { commitment: Hex; id: string; status: 'verified' | 'mismatch' | 'inconclusive'; message: string };
/** Public record of one wallet transaction attempt, kept apart from the agreement shown on screen.
 * It survives account/network changes so a transmitted hash is never lost. In-memory only: after a
 * reload, recover the hash from the wallet's activity and recheck it read-only below.
 * A known hash never changes. Only a mined transaction provably tied to this attempt settles it:
 * the same hash or a transaction with the same sender and a nonce read from that original transaction.
 * Without the original hash, a lookup is only an observation: identical calls can come from other tabs. */
type Attempt = {
  action: Action;
  agreement: string;
  account: Address;
  chainId: number;
  contract: Address;
  data: Hex;
  value: bigint;
  hash: Hex | null;
  txNonce: number | null;
  phase: 'wallet' | 'sent' | 'unknown' | 'confirmed' | 'reverted' | 'replaced';
  note: string;
};
type SeenTx = {
  hash: Hex;
  from: Address;
  to: Address | null;
  input: Hex;
  value: bigint;
  nonce: number;
  chainId?: number;
};
const unresolved = (a: Attempt | null) => !!a && (a.phase === 'wallet' || a.phase === 'sent' || a.phase === 'unknown');
const same = (x?: string | null, y?: string | null) => !!x && !!y && x.toLowerCase() === y.toLowerCase();
/** Outcome of a mined transaction already tied to the attempt. Different calldata means our action did not happen. */
function judge(
  a: Attempt,
  tx: SeenTx,
  status: 'success' | 'reverted',
  created: bigint | null = null,
): { phase: Attempt['phase']; note: string } {
  if (!same(tx.to, a.contract) || tx.input.toLowerCase() !== a.data.toLowerCase() || tx.value !== a.value)
    return {
      phase: 'replaced',
      note: `A different transaction from this account with the same nonce was mined (${tx.hash}). This ${a.action} did not happen.`,
    };
  if (status !== 'success')
    return {
      phase: 'reverted',
      note: `Transaction ${tx.hash} was included but reverted. The agreement did not change.`,
    };
  return {
    phase: 'confirmed',
    note:
      created !== null
        ? `Confirmed: agreement ${created} was created by ${tx.from} (${tx.hash}).`
        : `Confirmed receipt for ${tx.hash}. The agreement check below is separate.`,
  };
}
const phaseLabel = {
  wallet: 'Waiting for your wallet',
  sent: 'Submitted, not confirmed yet',
  unknown: 'Unknown: do not send again',
  confirmed: 'Confirmed',
  replaced: 'Replaced: this action did not happen',
  reverted: 'Reverted: nothing changed',
};
const t = deployment();
const connection = t ? clients(t) : null;
const states = [
  'Missing',
  'Awaiting deposit',
  'Funded',
  'Delivery submitted',
  'Approved · credit available',
  'Refunded · buyer credit',
];
const short = (s: string) => `${s.slice(0, 8)}…${s.slice(-6)}`;
const printable = (value: unknown) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
function download(name: string, bytes: Uint8Array | string, type: string) {
  const blob = new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes).buffer], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function walletProvider(): Injected {
  const p = (window as unknown as { ethereum?: Injected }).ethereum;
  if (!p)
    throw new Error('Open this page with an EVM wallet browser extension. Read-only verification needs no wallet.');
  return p;
}
function agreementId(s: string) {
  if (!/^[1-9]\d{0,76}$/.test(s)) throw new Error('Enter a positive agreement number.');
  return BigInt(s);
}

export default function Workspace() {
  const [id, setId] = useState('1'),
    [account, setAccount] = useState<Address | null>(null),
    [busy, setBusy] = useState('');
  const [message, setMessage] = useState('Select an agreement to inspect its independent evidence.');
  const [result, setResult] = useState<NetworkResult | null>(null),
    [proof, setProof] = useState<Proof | null>(null);
  const [verifiedBytes, setVerifiedBytes] = useState<Uint8Array | null>(null);
  const [referenceTerms, setReferenceTerms] = useState('');
  const [prepared, setPrepared] = useState<Prepared | null>(null),
    [media, setMedia] = useState<1 | 2 | 3>(1),
    [policy, setPolicy] = useState(false);
  const [supplier, setSupplier] = useState(''),
    [amount, setAmount] = useState('0.1'),
    [terms, setTerms] = useState(
      'Deliver one public synthetic report. Buyer reviews the bytes and explicitly approves before the review deadline.',
    );
  const [deliveryMinutes, setDeliveryMinutes] = useState('60'),
    [reviewMinutes, setReviewMinutes] = useState('120');
  const epoch = useRef(0),
    mounted = useRef(true),
    taskLock = useRef(false);
  const attemptRef = useRef<Attempt | null>(null);
  const [attempt, setAttemptState] = useState<Attempt | null>(null),
    [recoverHash, setRecoverHash] = useState('');
  const setAttempt = (value: Attempt | null) => {
    attemptRef.current = value;
    setAttemptState(value);
  };
  const locked = unresolved(attempt);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // epoch is an app-owned counter, not a DOM ref: bump its live value on unmount.
      epoch.current += 1;
    };
  }, []);
  useEffect(() => {
    const p = (window as unknown as { ethereum?: Injected }).ethereum;
    const changed = () => {
      epoch.current++;
      setAccount(null);
      setResult(null);
      setProof(null);
      setVerifiedBytes(null);
      setMessage('Wallet context changed. Reconnect and verify again.');
    };
    p?.on?.('accountsChanged', changed);
    p?.on?.('chainChanged', changed);
    return () => {
      p?.removeListener?.('accountsChanged', changed);
      p?.removeListener?.('chainChanged', changed);
    };
  }, []);
  const current = (ticket: number) => mounted.current && epoch.current === ticket;
  const verified = result?.status === 'verified' ? result : null;
  const a = verified?.agreement;
  const ours = (who?: string) => !!account && who?.toLowerCase() === account.toLowerCase();
  const contextChange = (value: string) => {
    epoch.current++;
    setId(value);
    setResult(null);
    setProof(null);
    setPrepared(null);
    setVerifiedBytes(null);
    setReferenceTerms('');
  };
  async function task(label: string, work: (ticket: number) => Promise<void>) {
    if (taskLock.current) return;
    taskLock.current = true;
    const ticket = epoch.current;
    setBusy(label);
    try {
      await work(ticket);
    } catch (e) {
      if (current(ticket))
        setMessage(e instanceof Error ? e.message : 'The action could not complete. Verify again before retrying.');
    } finally {
      taskLock.current = false;
      if (mounted.current) setBusy('');
    }
  }
  async function inspect(ticket: number, target = id) {
    if (!t || !connection)
      throw new Error(
        'No verified deployment configured. This installation is read-only and cannot send transactions.',
      );
    const r = await verifyAgreement(t, agreementId(target), connection.reader);
    if (current(ticket)) {
      setResult(r);
      setProof(null);
      setVerifiedBytes(null);
      setMessage(
        r.status === 'verified'
          ? 'Chain evidence matches this agreement. Verify file bytes separately before approving.'
          : `Chain check ${r.status}: ${r.code}. No payment conclusion is drawn.`,
      );
    }
    return r;
  }
  async function connect() {
    await task('Connecting wallet', async ticket => {
      if (!t) throw new Error('A verified deployment must be configured first.');
      const p = walletProvider();
      const accounts = await p.request({ method: 'eth_requestAccounts' });
      const chain = await p.request({ method: 'eth_chainId' });
      if (Number(chain) !== t.chainId)
        throw new Error(
          `Switch your wallet to ${t.chainId === 296 ? 'Hedera testnet (296)' : 'local chain 31337'} and reconnect. No automatic network changes.`,
        );
      if (!Array.isArray(accounts) || !isAddress(accounts[0])) throw new Error('No wallet account returned.');
      if (current(ticket)) {
        setAccount(accounts[0]);
        setMessage('Wallet connected. Each transaction still needs your explicit wallet confirmation.');
      }
    });
  }
  function candidate(): Delivery {
    if (!prepared || !a || !t) throw new Error('Load an agreement and select a public synthetic file first.');
    return {
      chainId: t.chainId,
      contract: t.address,
      agreementId: agreementId(id),
      termsHash: a.termsHash,
      cid: prepared.cid,
      fileSha256: prepared.fileSha256,
      fileSize: prepared.fileSize,
      mediaType: media,
      version: 1,
    };
  }
  async function verifyFile(source: 'gateway' | 'car', file?: File) {
    await task('Verifying file bytes', async ticket => {
      const d = verified?.delivery ?? candidate();
      const commitment = verified?.delivery ? a!.commitment : deliveryCommitment(d);
      if (file && file.size > MAX_CAR_BYTES) throw new Error('The CAR exceeds 4 MiB.');
      const p =
        source === 'car' && file
          ? await verifyCar(new Uint8Array(await file.arrayBuffer()), d, commitment)
          : await fetchAndVerify(d, commitment);
      if (current(ticket)) {
        setVerifiedBytes(p.status === 'verified' ? p.bytes : null);
        setProof({ id, commitment, status: p.status, message: p.code });
        setMessage(
          p.status === 'verified'
            ? 'File bytes match. This does not establish quality, authorship or payment.'
            : `File check ${p.status}: ${p.code}.`,
        );
      }
    });
  }
  async function write(action: Action) {
    await task(`Preparing ${action}`, async ticket => {
      if (unresolved(attemptRef.current))
        throw new Error('A previous transaction is still unresolved. Recheck it below before sending another.');
      if (!t || !connection || !account) throw new Error('Configure a verified deployment and connect a wallet first.');
      if (!policy) throw new Error('Read and acknowledge the testnet agreement policy.');
      const { chain, client, reader } = connection;
      const p = walletProvider();
      await assertDeployment(t, reader);
      const accounts = await p.request({ method: 'eth_accounts' }),
        chainId = await p.request({ method: 'eth_chainId' });
      if (
        Number(chainId) !== t.chainId ||
        !Array.isArray(accounts) ||
        String(accounts[0]).toLowerCase() !== account.toLowerCase()
      )
        throw new Error('Wallet context changed. Reconnect before sending.');
      let data: Hex,
        value = 0n;
      const n = action === 'create' ? 0n : agreementId(id);
      const fresh = action === 'create' ? null : await verifyAgreement(t, n, reader);
      if (fresh && fresh.status !== 'verified')
        throw new Error(`Fresh chain verification did not complete: ${fresh.code}.`);
      const agreement = fresh?.status === 'verified' ? fresh.agreement : null;
      const tip = await reader.block('latest');
      const now = tip.timestamp;
      if (
        agreement &&
        ['fund', 'submit', 'approve'].includes(action) &&
        keccak256(stringToHex(referenceTerms)) !== agreement.termsHash
      )
        throw new Error('Paste the exact shared agreement terms and check their commitment before participating.');
      switch (action) {
        case 'create': {
          if (!isAddress(supplier) || supplier.toLowerCase() === account.toLowerCase())
            throw new Error('Use a different, valid supplier wallet address.');
          if (!/^\d+(\.\d{1,8})?$/.test(amount)) throw new Error('Amount must use at most 8 decimal places.');
          const tiny = parseUnits(amount, 8);
          rpcValueForTinybars(t.chainId, tiny);
          const dm = Number(deliveryMinutes),
            rm = Number(reviewMinutes);
          if (!Number.isSafeInteger(dm) || !Number.isSafeInteger(rm) || dm < 5 || rm <= dm || rm > 10080)
            throw new Error('Delivery must be at least 5 minutes away; review must be later and within 7 days.');
          if (terms.trim().length < 10 || terms.length > 4000)
            throw new Error('Use 10 to 4,000 characters of public synthetic terms.');
          data = encodeFunctionData({
            abi: deliverProofAbi,
            functionName: 'createAgreement',
            args: [supplier, tiny, now + BigInt(dm * 60), now + BigInt(rm * 60), keccak256(stringToHex(terms))],
          });
          break;
        }
        case 'fund': {
          if (!agreement || agreement.state !== 1 || agreement.deliveryDeadline - now < 60n)
            throw new Error('Funding needs a draft agreement with at least 60 seconds remaining.');
          value = rpcValueForTinybars(t.chainId, agreement.amountTinybar);
          data = encodeFunctionData({ abi: deliverProofAbi, functionName: 'fund', args: [n] });
          break;
        }
        case 'submit': {
          if (!agreement || agreement.state !== 2 || agreement.deliveryDeadline <= now)
            throw new Error('This agreement is not accepting delivery.');
          const d = candidate();
          const c = deliveryCommitment(d);
          if (!proof || proof.status !== 'verified' || proof.id !== id || proof.commitment !== c)
            throw new Error('Verify this exact delivery before recording it.');
          if (d.termsHash !== agreement.termsHash) throw new Error('Agreement changed. Verify again.');
          data = encodeFunctionData({
            abi: deliverProofAbi,
            functionName: 'submit',
            args: [n, d.cid, d.fileSha256, d.fileSize, d.mediaType],
          });
          break;
        }
        case 'approve': {
          if (!agreement || agreement.state !== 3 || agreement.reviewDeadline < now)
            throw new Error('This agreement cannot be approved now.');
          if (!proof || proof.status !== 'verified' || proof.id !== id || proof.commitment !== agreement.commitment)
            throw new Error('Verify the exact submitted file before approving.');
          data = encodeFunctionData({ abi: deliverProofAbi, functionName: 'approve', args: [n, agreement.commitment] });
          break;
        }
        case 'refund':
          data = encodeFunctionData({ abi: deliverProofAbi, functionName: 'refund', args: [n] });
          break;
        case 'withdraw':
          data = encodeFunctionData({ abi: deliverProofAbi, functionName: 'withdraw', args: [n] });
          break;
      }
      try {
        await client.call({ account, to: t.address, data, value });
      } catch (e) {
        throw new Error(explainPreflight(e));
      }
      if (!current(ticket)) throw new Error('Page context changed before wallet confirmation.');
      const wallet = createWalletClient({ chain, transport: custom(p) });
      // Record the intent before opening the wallet. An unknown result blocks another send.
      // A pending nonce is not reserved for this page and cannot identify a later transaction.
      const base: Attempt = {
        action,
        agreement: action === 'create' ? 'new' : id,
        account,
        chainId: t.chainId,
        contract: t.address,
        data,
        value,
        hash: null,
        txNonce: null,
        phase: 'wallet',
        note: 'Review the network, destination and amount in your wallet. Do not sign if they differ.',
      };
      setAttempt(base);
      setMessage('Review the network, destination and amount in your wallet. Do not sign if they differ.');
      let tx: Hex;
      try {
        tx = await wallet.sendTransaction({ chain, account, to: t.address, data, value });
      } catch (e) {
        if (isWalletRejection(e)) {
          setAttempt(null);
          throw new Error('You rejected the request in your wallet. Nothing was sent.');
        }
        setAttempt({
          ...base,
          phase: 'unknown',
          note: 'The wallet returned no transaction hash, so it may or may not have been sent. A hash from wallet activity can be checked below, but cannot identify this unresolved request. Do not send again.',
        });
        throw new Error(
          'Sending did not complete and the result is unknown. Check your wallet activity before trying again.',
        );
      }
      // Keep the hash even if the account, network or agreement changed meanwhile. From now on it never changes.
      const sentTx = await client.getTransaction({ hash: tx }).catch(() => null);
      const sent: Attempt = {
        ...base,
        hash: tx,
        txNonce: sentTx && same(sentTx.from, account) ? sentTx.nonce : null,
        phase: 'sent',
        note: 'Submitted. Waiting for confirmation.',
      };
      setAttempt(sent);
      if (current(ticket)) setMessage(`Transaction submitted: ${tx}. It is not yet confirmed.`);
      let r: Awaited<ReturnType<typeof client.waitForTransactionReceipt>>;
      let replacement: SeenTx | null = null;
      try {
        r = await client.waitForTransactionReceipt({
          hash: tx,
          timeout: 60000,
          retryCount: 0,
          onReplaced: rep => {
            replacement = rep.transaction as SeenTx;
          },
        });
      } catch {
        setAttempt({
          ...sent,
          phase: 'unknown',
          note: 'No confirmation within 60 seconds. It may still confirm. Recheck this hash before sending anything else.',
        });
        throw new Error(
          `No confirmation within 60 seconds for ${tx}. It may still confirm: recheck it below and do not send again.`,
        );
      }
      // The terminal receipt must belong to this attempt: the original, or the wallet's replacement for the same nonce.
      const mined: SeenTx | null =
        replacement ?? (await client.getTransaction({ hash: r.transactionHash }).catch(() => null));
      if (!mined) {
        const note = `A receipt exists for ${r.transactionHash}, but its transaction could not be read. Recheck before sending anything else.`;
        setAttempt({ ...sent, phase: 'unknown', note });
        throw new Error(note);
      }
      const verdict = judge(
        sent,
        mined,
        r.status,
        action === 'create' && r.status === 'success' ? createdId(r.logs, t.address) : null,
      );
      setAttempt({ ...sent, phase: verdict.phase, note: verdict.note });
      if (verdict.phase !== 'confirmed') throw new Error(verdict.note);
      tx = mined.hash;
      if (!current(ticket)) return;
      const target = action === 'create' ? createdId(r.logs, t.address)?.toString() : id;
      if (!target) throw new Error('Successful transaction lacks the expected Created event. Do not infer creation.');
      if (action === 'create') {
        setId(target);
        setPrepared(null);
        setReferenceTerms(terms);
      }
      const checked = await inspect(ticket, target);
      if (current(ticket))
        setMessage(
          checked.status === 'verified' && checked.milestones.some(x => x.hash.toLowerCase() === tx.toLowerCase())
            ? `Confirmed and independently checked: ${action}. Approval creates credit; only Withdrawn establishes withdrawal.`
            : `Transaction has a successful receipt, but complete agreement verification is unavailable. Hash: ${tx}`,
        );
    });
  }
  /** Read-only helpers: never sign or send. */
  async function readTx(hash: Hex): Promise<SeenTx | null> {
    if (!connection) return null;
    try {
      return (await connection.client.getTransaction({ hash })) as SeenTx;
    } catch (e) {
      if (e instanceof Error && e.name === 'TransactionNotFoundError') return null;
      throw new Error('Could not read the transaction. Nothing changed; try again.');
    }
  }
  async function readReceipt(hash: Hex) {
    if (!connection) return null;
    try {
      return await connection.client.getTransactionReceipt({ hash });
    } catch (e) {
      if (e instanceof Error && e.name === 'TransactionReceiptNotFoundError') return null;
      throw new Error('Could not read the receipt. Nothing changed; try again.');
    }
  }
  function settle(
    a: Attempt,
    tx: SeenTx,
    r: { status: 'success' | 'reverted'; logs: readonly { address: Address; topics: readonly Hex[]; data: Hex }[] },
    ticket: number,
  ) {
    const created = t && a.action === 'create' && r.status === 'success' ? createdId(r.logs, t.address) : null;
    const v = judge(a, tx, r.status, created);
    setAttempt({ ...a, hash: a.hash ?? tx.hash, phase: v.phase, note: v.note });
    if (current(ticket)) setMessage(v.note);
  }
  /** The attempt's own hash, which never changes. No receipt keeps it unresolved. */
  async function recheckAttempt() {
    await task('Rechecking transaction', async ticket => {
      const a = attemptRef.current;
      if (!t || !connection || !a || !a.hash || !unresolved(a)) return;
      const r = await readReceipt(a.hash);
      if (r) {
        const tx = await readTx(a.hash);
        if (!tx) throw new Error('The receipt exists but the transaction could not be read. It stays unresolved.');
        return settle(a, tx, r, ticket);
      }
      let note = `No receipt for ${a.hash} yet. It stays unresolved; recheck later.`;
      if (a.txNonce !== null) {
        const minedCount = await connection.client
          .getTransactionCount({ address: a.account, blockTag: 'latest' })
          .catch(() => null);
        if (minedCount !== null && minedCount > a.txNonce)
          note = `Another transaction from this account with nonce ${a.txNonce} was mined, so ${a.hash} will not confirm. Paste the hash your wallet shows for that nonce below to settle this attempt.`;
      }
      setAttempt({ ...a, phase: 'unknown', note });
      if (current(ticket)) setMessage(note);
    });
  }
  /** Any hash can be looked up. It settles the unresolved attempt only when provably tied to it. */
  async function lookup() {
    await task('Checking transaction', async ticket => {
      if (!t || !connection) throw new Error('No verified deployment configured.');
      const hash = recoverHash.trim() as Hex;
      if (!/^0x[0-9a-fA-F]{64}$/.test(hash))
        throw new Error('Paste a transaction hash from your wallet activity (0x followed by 64 hex characters).');
      const tx = await readTx(hash);
      if (!tx) {
        if (current(ticket)) setMessage(`This RPC does not know ${hash}. Nothing changed.`);
        return;
      }
      const r = await readReceipt(hash);
      const a = attemptRef.current;
      const created = r?.status === 'success' ? createdId(r.logs, t.address) : null;
      const seen = !r
        ? `${hash} is not mined yet.`
        : r.status !== 'success'
          ? `${hash} was included but reverted.`
          : created !== null
            ? `${hash} created agreement ${created} (sender ${tx.from}).`
            : `${hash} was confirmed in block ${r.blockNumber} (sender ${tx.from}).`;
      if (!a || !unresolved(a)) {
        if (current(ticket)) setMessage(`${seen} Read-only lookup; nothing changed.`);
        return;
      }
      if (a.hash && same(hash, a.hash)) return void (await recheckAttemptInline(a, ticket));
      const sender = same(tx.from, a.account) && (tx.chainId === undefined || tx.chainId === a.chainId);
      // Only a nonce read from the original, wallet-returned hash identifies its replacement.
      // Matching sender, calldata, value and time is insufficient when the original hash is missing.
      const linked = !!a.hash && sender && a.txNonce !== null && tx.nonce === a.txNonce;
      if (!linked || !r) {
        const why = !linked
          ? 'its identity is not tied to the original wallet request; matching call details alone are insufficient'
          : 'it is not mined yet';
        if (current(ticket))
          setMessage(`${seen} It does not settle the unresolved attempt: ${why}. The attempt stays unresolved.`);
        return;
      }
      settle(a, tx, r, ticket);
      setRecoverHash('');
    });
  }
  async function recheckAttemptInline(a: Attempt, ticket: number) {
    const r = await readReceipt(a.hash!);
    if (!r) {
      if (current(ticket)) setMessage(`No receipt for ${a.hash} yet. It stays unresolved.`);
      return;
    }
    const tx = await readTx(a.hash!);
    if (!tx) throw new Error('The receipt exists but the transaction could not be read. It stays unresolved.');
    settle(a, tx, r, ticket);
  }
  const readOnly = !t;
  return (
    <>
      <header className="top">
        <Link className="brand" href="/" aria-label="DeliverProof home">
          <span className="mark">D</span>DeliverProof
        </Link>
        <span className="pill">{t?.chainId === 31337 ? 'LOCAL EVM' : 'TESTNET ONLY'}</span>
        <button className="secondary" onClick={connect} disabled={!!busy || readOnly}>
          {account ? short(account) : 'Connect wallet'}
        </button>
      </header>
      <main>
        <section className="intro">
          <div>
            <p className="eyebrow">A SMALL AGREEMENT. AN EXPLICIT APPROVAL.</p>
            <h1>
              Verify the delivery.
              <br />
              Then release the credit.
            </h1>
            <p>Check the file and the chain independently. Approval and withdrawal are separate steps.</p>
          </div>
          <aside className="scope">
            <strong>No automatic release</strong>
            <p>
              Silence never pays the supplier. After the review deadline, the buyer can reclaim the deposit, even if a
              file was delivered.
            </p>
            <small>No arbitration. No guarantee of quality. Test HBAR only.</small>
          </aside>
        </section>
        {readOnly && (
          <div className="notice warning">
            <strong>Deployment not configured.</strong> This source package has no public contract yet. Wallet actions
            remain disabled until an operator verifies and installs a deployment manifest.
          </div>
        )}
        <div className="notice" role="status" aria-live="polite">
          {busy && <span className="loading" aria-label="Working" />}
          {message}
        </div>
        {attempt && (
          <section className="panel attempt" aria-label="Transaction attempt">
            <p className="eyebrow">TRANSACTION ATTEMPT</p>
            <dl>
              <dt>Status</dt>
              <dd>{phaseLabel[attempt.phase]}</dd>
              <dt>Action</dt>
              <dd>
                {attempt.action}
                {attempt.agreement === 'new' ? ' · new agreement' : ` · agreement ${attempt.agreement}`}
              </dd>
              <dt>Account</dt>
              <dd>{attempt.account}</dd>
              <dt>Network</dt>
              <dd>{attempt.chainId}</dd>
              <dt>Hash</dt>
              <dd>{attempt.hash ?? 'not returned by the wallet'}</dd>
            </dl>
            <p className="muted">{attempt.note}</p>
            <div className="actions">
              {attempt.hash && unresolved(attempt) && (
                <button className="secondary" disabled={!!busy} onClick={() => recheckAttempt()}>
                  Recheck this hash (read-only)
                </button>
              )}
              {!unresolved(attempt) && (
                <button className="secondary" disabled={!!busy} onClick={() => setAttempt(null)}>
                  Dismiss
                </button>
              )}
            </div>
          </section>
        )}
        {t && (
          <details className="panel">
            <summary>Recheck a transaction by hash</summary>
            <p className="muted">
              Read-only. Use the hash from your wallet activity, for example after a reload or a lost response. Nothing
              is signed or sent. It settles an unresolved attempt only when the transaction is provably that attempt.
            </p>
            <label>
              Transaction hash
              <input
                value={recoverHash}
                onChange={e => setRecoverHash(e.target.value)}
                placeholder="0x…"
                disabled={!!busy}
              />
            </label>
            <button className="secondary" disabled={!!busy || !recoverHash.trim()} onClick={() => lookup()}>
              Check hash
            </button>
          </details>
        )}
        <section className="toolbar">
          <label>
            Agreement number
            <input value={id} onChange={e => contextChange(e.target.value)} inputMode="numeric" disabled={!!busy} />
          </label>
          <button
            disabled={!!busy || readOnly}
            onClick={() => task('Reading independent evidence', ticket => inspect(ticket).then(() => {}))}
          >
            Verify agreement
          </button>
          <span className="muted">Reading needs no wallet.</span>
        </section>
        <div className="grid">
          <section className="panel">
            <p className="eyebrow">01 / AGREEMENT</p>
            <h2>{a ? (a.withdrawn ? 'Withdrawal confirmed' : states[a.state]) : 'Inspect an agreement'}</h2>
            {a ? (
              <>
                <dl>
                  <dt>Buyer</dt>
                  <dd>{a.buyer}</dd>
                  <dt>Supplier</dt>
                  <dd>{a.supplier}</dd>
                  <dt>Deposit</dt>
                  <dd>
                    {formatUnits(a.amountTinybar, 8)}{' '}
                    {t?.chainId === 31337 ? 'HBAR-equivalent (local accounting only)' : 'test HBAR'}
                  </dd>
                  <dt>Delivery by</dt>
                  <dd>{new Date(Number(a.deliveryDeadline) * 1000).toLocaleString()}</dd>
                  <dt>Review by</dt>
                  <dd>{new Date(Number(a.reviewDeadline) * 1000).toLocaleString()}</dd>
                  <dt>Terms commitment</dt>
                  <dd>{a.termsHash}</dd>
                </dl>
                <p className="muted">
                  Snapshot block {verified!.snapshot.number.toString()} · chain time{' '}
                  {new Date(Number(verified!.snapshot.timestamp) * 1000).toLocaleString()}. Buyer refund opens strictly
                  after the review deadline; supplier refund is voluntary. Use Verify again to refresh; no background
                  polling.
                </p>
              </>
            ) : (
              <p className="muted">
                A complete proof matches this installation’s contract, immutable terms, transaction receipts and event
                history.
              </p>
            )}
            {a && (
              <label>
                Shared agreement terms
                <textarea
                  rows={3}
                  value={referenceTerms}
                  onChange={e => setReferenceTerms(e.target.value)}
                  maxLength={4000}
                  disabled={!!busy}
                />
                <span className="muted">
                  {keccak256(stringToHex(referenceTerms)) === a.termsHash
                    ? 'Terms match the on-chain commitment.'
                    : 'Paste the exact shared text before depositing, delivering or approving.'}
                </span>
              </label>
            )}
            <label className="check">
              <input type="checkbox" checked={policy} onChange={e => setPolicy(e.target.checked)} />I understand this is
              a testnet prototype using public synthetic data. The buyer can refund after the review deadline without
              approval; suppliers accept this risk.
            </label>
            <div className="actions">
              <button
                disabled={locked || !!busy || !account || !policy || a?.state !== 1 || !ours(a?.buyer)}
                onClick={() => write('fund')}
              >
                Deposit exact amount
              </button>
              <button
                disabled={
                  locked ||
                  !!busy ||
                  !account ||
                  !policy ||
                  a?.state !== 3 ||
                  !ours(a?.buyer) ||
                  proof?.status !== 'verified'
                }
                onClick={() => write('approve')}
              >
                Approve verified delivery
              </button>
              <button
                className="secondary"
                disabled={
                  locked ||
                  !!busy ||
                  !account ||
                  !policy ||
                  !a ||
                  ![2, 3].includes(a.state) ||
                  !(ours(a.supplier) || (ours(a.buyer) && verified!.snapshot.timestamp > a.reviewDeadline))
                }
                onClick={() => write('refund')}
              >
                Request refund
              </button>
              <button
                disabled={
                  locked ||
                  !!busy ||
                  !account ||
                  !policy ||
                  !a ||
                  ![4, 5].includes(a.state) ||
                  a.withdrawn ||
                  !ours(a.state === 4 ? a.supplier : a.buyer)
                }
                onClick={() => write('withdraw')}
              >
                Withdraw available credit
              </button>
            </div>
          </section>
          <section className="panel">
            <p className="eyebrow">02 / DELIVERY</p>
            <h2>The bytes are the evidence.</h2>
            <p>
              Text, JSON or PDF · maximum 1 MiB. File preparation stays in this browser. IPFS publishing is a separate,
              explicit step.
            </p>
            {verified?.delivery ? (
              <dl>
                <dt>Recorded CID</dt>
                <dd>{verified.delivery.cid}</dd>
                <dt>SHA-256</dt>
                <dd>{verified.delivery.fileSha256}</dd>
                <dt>File size</dt>
                <dd>{verified.delivery.fileSize.toString()} bytes</dd>
              </dl>
            ) : (
              <>
                <label>
                  Public synthetic file
                  <input
                    type="file"
                    accept=".txt,.json,.pdf"
                    disabled={!!busy || a?.state !== 2}
                    onChange={e => {
                      const file = e.target.files?.[0];
                      setProof(null);
                      setPrepared(null);
                      setVerifiedBytes(null);
                      if (file)
                        void task('Preparing local file', async ticket => {
                          if (file.size > 1048576) throw new Error('File exceeds 1 MiB.');
                          const p = await prepareArtifact(new Uint8Array(await file.arrayBuffer()));
                          if (current(ticket)) {
                            setPrepared(p);
                            setMessage(
                              'CAR prepared locally. Download it, pin using an authorized IPFS tool, then verify retrieval.',
                            );
                          }
                        });
                    }}
                  />
                </label>
                <label>
                  Declared media type
                  <select
                    value={media}
                    disabled={!!busy}
                    onChange={e => {
                      setMedia(Number(e.target.value) as 1 | 2 | 3);
                      setProof(null);
                      setVerifiedBytes(null);
                    }}
                  >
                    <option value={1}>Plain text</option>
                    <option value={2}>JSON</option>
                    <option value={3}>PDF</option>
                  </select>
                </label>
                {prepared && (
                  <>
                    <p className="mono">{prepared.cid}</p>
                    <button
                      className="secondary"
                      onClick={() => download('deliverproof-public.car', prepared.car, 'application/vnd.ipld.car')}
                    >
                      Download CAR for pinning
                    </button>
                  </>
                )}
              </>
            )}
            <div className="actions">
              <button
                className="secondary"
                disabled={!!busy || (!prepared && !verified?.delivery)}
                onClick={() => verifyFile('gateway')}
              >
                Retrieve and verify IPFS
              </button>
              <label className="file-button">
                Verify a downloaded CAR
                <input
                  type="file"
                  accept=".car"
                  disabled={!!busy || !verified?.delivery}
                  onChange={e => {
                    const file = e.target.files?.[0];
                    if (file) void verifyFile('car', file);
                  }}
                />
              </label>
            </div>
            {proof && (
              <div className={`proof ${proof.status}`}>
                <strong>
                  {proof.status === 'verified'
                    ? 'File integrity verified'
                    : proof.status === 'mismatch'
                      ? 'Evidence does not match'
                      : 'Verification inconclusive'}
                </strong>
                <span>{proof.message}</span>
              </div>
            )}
            {verifiedBytes && proof?.status === 'verified' && (
              <button
                className="secondary"
                onClick={() => download('verified-delivery.bin', verifiedBytes, 'application/octet-stream')}
              >
                Download verified bytes for review
              </button>
            )}
            <button
              disabled={
                locked ||
                !!busy ||
                !policy ||
                a?.state !== 2 ||
                !ours(a?.supplier) ||
                !prepared ||
                proof?.status !== 'verified'
              }
              onClick={() => write('submit')}
            >
              Record this delivery
            </button>
            <p className="muted">
              A matching file proves integrity, not quality or ownership. Unavailable content never turns into a
              successful check.
            </p>
          </section>
        </div>
        {verified && (
          <section className="panel evidence">
            <div>
              <p className="eyebrow">03 / INDEPENDENT CHAIN READ</p>
              <h2>What is actually confirmed</h2>
            </div>
            <ol className="timeline">
              {verified.milestones.map((m, i) => (
                <li key={`${m.hash}-${m.event}-${i}`}>
                  <span className="dot" />
                  <strong>{m.event}</strong>
                  <span className="mono">{short(m.hash)}</span>
                  <small>Block {m.block.toString()}</small>
                </li>
              ))}
            </ol>
            <button
              className="secondary"
              onClick={() =>
                download(
                  `agreement-${id}-evidence.json`,
                  printable({
                    version: 1,
                    kind: 'observed-evidence-not-a-trust-anchor',
                    agreementId: id,
                    snapshot: verified.snapshot,
                    agreement: verified.agreement,
                    milestones: verified.milestones,
                    content: proof ? { status: proof.status, commitment: proof.commitment, code: proof.message } : null,
                  }),
                  'application/json',
                )
              }
            >
              Export observed evidence
            </button>
            <p className="muted">
              The export records observations. It cannot configure the trusted contract or prove future availability.
              Network history can change; recheck before acting.
            </p>
          </section>
        )}
        <details className="panel">
          <summary>Create a new test agreement</summary>
          <div className="create-grid">
            <label>
              Supplier wallet
              <input value={supplier} onChange={e => setSupplier(e.target.value)} placeholder="0x…" disabled={!!busy} />
            </label>
            <label>
              Test HBAR (maximum 10)
              <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" disabled={!!busy} />
            </label>
            <label>
              Delivery window (minutes)
              <input
                type="number"
                min="5"
                value={deliveryMinutes}
                onChange={e => setDeliveryMinutes(e.target.value)}
                disabled={!!busy}
              />
            </label>
            <label>
              Review window from now (minutes)
              <input
                type="number"
                value={reviewMinutes}
                onChange={e => setReviewMinutes(e.target.value)}
                disabled={!!busy}
              />
            </label>
            <label className="wide">
              Public synthetic terms
              <textarea
                rows={3}
                value={terms}
                onChange={e => setTerms(e.target.value)}
                maxLength={4000}
                disabled={!!busy}
              />
            </label>
          </div>
          <button className="secondary" onClick={() => download('public-agreement-terms.txt', terms, 'text/plain')}>
            Save terms to share with supplier
          </button>
          <p>
            The exact UTF-8 terms are hashed, including whitespace. Share the text with the supplier and keep your copy.
            No personal data or confidential deliverables.
          </p>
          <button disabled={locked || !!busy || readOnly || !account || !policy} onClick={() => write('create')}>
            Review creation in wallet
          </button>
        </details>
        <footer>
          DeliverProof · Original Scaffold-HBAR template · Testnet prototype · No fee, administrator or automatic
          release.
        </footer>
      </main>
    </>
  );
}
