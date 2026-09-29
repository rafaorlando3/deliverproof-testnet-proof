import { describe, it, expect } from 'vitest';
import { encodeAbiParameters, encodeEventTopics, getAbiItem, keccak256, type Hex, type Address } from 'viem';
import { deliverProofAbi } from '../src/abi.js';
import { ChainReadError } from '../src/read-errors.js';
import {
  verifyAgreement,
  type TrustedDeployment,
  type ChainReader,
  type ChainLog,
  type ChainReceipt,
  type Agreement,
} from '../src/network.js';

const h = (n: number) => ('0x' + n.toString(16).padStart(64, '0')) as Hex;
const address = (n: number) => ('0x' + n.toString(16).padStart(40, '0')) as Address;
const code = '0x60006000' as Hex;
function fixture() {
  const t: TrustedDeployment = {
    chainId: 31337,
    address: address(10),
    deployer: address(20),
    deploymentBlock: 1n,
    deploymentTx: h(1),
    runtimeCodeHash: keccak256(code),
  };
  const a: Agreement = {
    buyer: address(30),
    supplier: address(40),
    amountTinybar: 200n,
    deliveryDeadline: 1000n,
    reviewDeadline: 2000n,
    termsHash: h(9),
    state: 2,
    commitment: h(0),
    cid: '',
    fileSha256: h(0),
    fileSize: 0n,
    mediaType: 0,
    withdrawn: false,
  };
  function log(name: 'Created' | 'Funded', args: Record<string, unknown>, n: number): ChainLog {
    const abi = getAbiItem({ abi: deliverProofAbi, name }) as any;
    return {
      address: t.address,
      topics: encodeEventTopics({ abi: [abi], eventName: name, args }) as Hex[],
      data: encodeAbiParameters(
        abi.inputs.filter((x: any) => !x.indexed),
        abi.inputs.filter((x: any) => !x.indexed).map((x: any) => args[x.name]),
      ),
      transactionHash: h(n),
      blockNumber: BigInt(n),
      blockHash: h(n + 100),
      logIndex: 0,
      removed: false,
    };
  }
  const logs = [
    log(
      'Created',
      {
        id: 1n,
        buyer: a.buyer,
        supplier: a.supplier,
        amountTinybar: a.amountTinybar,
        deliveryDeadline: a.deliveryDeadline,
        reviewDeadline: a.reviewDeadline,
        termsHash: a.termsHash,
      },
      2,
    ),
    log('Funded', { id: 1n, amountTinybar: a.amountTinybar }, 3),
  ];
  const receipts = new Map<Hex, ChainReceipt>();
  receipts.set(h(1), {
    transactionHash: h(1),
    blockHash: h(101),
    blockNumber: 1n,
    status: 'success',
    from: t.deployer,
    to: null,
    contractAddress: t.address,
    logs: [],
  });
  for (const l of logs)
    receipts.set(l.transactionHash, {
      transactionHash: l.transactionHash,
      blockHash: l.blockHash,
      blockNumber: l.blockNumber,
      status: 'success',
      from: a.buyer,
      to: t.address,
      contractAddress: null,
      logs: [structuredClone(l)],
    });
  const reader: ChainReader = {
    chainId: async () => 31337,
    block: async n => ({
      number: n === 'latest' ? 4n : n,
      hash: h(Number(n === 'latest' ? 4n : n) + 100),
      timestamp: 500n,
    }),
    code: async () => code,
    receipt: async tx => receipts.get(tx) ?? null,
    transaction: async tx => ({ hash: tx, from: a.buyer, to: t.address, value: 200n }),
    agreement: async () => a,
    logs: async () => logs,
  };
  return { t, a, reader, logs, receipts };
}
describe('network proof with independent expected deployment', () => {
  it('verifies funded state but never claims withdrawal or file integrity', async () => {
    const f = fixture();
    const r = await verifyAgreement(f.t, 1n, f.reader);
    expect(r.status).toBe('verified');
    if (r.status === 'verified') {
      expect(r.delivery).toBeNull();
      expect(r.milestones.map(x => x.event)).toEqual(['Created', 'Funded']);
    }
  });
  it('wrong RPC network is inconclusive', async () => {
    const f = fixture();
    f.reader.chainId = async () => 295;
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'wrong_rpc_network' });
  });
  it('code at a substituted deployment does not pass', async () => {
    const f = fixture();
    f.reader.code = async () => '0x6001';
    expect(await verifyAgreement(f.t, 1n, f.reader)).toMatchObject({
      status: 'mismatch',
      code: 'runtime_code_mismatch',
    });
  });
  it('a valid transaction for another deployed contract is rejected', async () => {
    const f = fixture();
    f.receipts.get(h(1))!.contractAddress = address(99);
    expect(await verifyAgreement(f.t, 1n, f.reader)).toMatchObject({ code: 'deployment_mismatch' });
  });
  it('no receipt stays inconclusive', async () => {
    const f = fixture();
    f.receipts.delete(h(3));
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'not_found' });
  });
  it('wrong actor cannot stand in for the buyer', async () => {
    const f = fixture();
    f.receipts.get(h(3))!.from = address(99);
    expect(await verifyAgreement(f.t, 1n, f.reader)).toMatchObject({ code: 'funded_mismatch' });
  });
  it('deposit RPC value must equal the independently expected amount', async () => {
    const f = fixture();
    f.reader.transaction = async tx => ({ hash: tx, from: f.a.buyer, to: f.t.address, value: 201n });
    expect(await verifyAgreement(f.t, 1n, f.reader)).toMatchObject({ code: 'deposit_value_mismatch' });
  });
  it('log returned for another agreement cannot be used', async () => {
    const f = fixture();
    expect(await verifyAgreement(f.t, 2n, f.reader)).toMatchObject({ code: 'wrong_event_agreement' });
  });
  it('receipt and getLogs must describe the same event', async () => {
    const f = fixture();
    f.receipts.get(h(3))!.logs = [];
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'receipt_log_missing' });
  });
  it('missing history is not a successful funded proof', async () => {
    const f = fixture();
    f.logs.pop();
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({
      status: 'inconclusive',
      code: 'incomplete_event_history',
    });
  });
  it('removed or duplicate events are inconclusive', async () => {
    const f = fixture();
    f.logs[1]!.removed = true;
    expect(await verifyAgreement(f.t, 1n, f.reader)).toMatchObject({ status: 'inconclusive', code: 'history_changed' });
    f.logs[1]!.removed = false;
    f.logs.push(f.logs[1]!);
    expect(await verifyAgreement(f.t, 1n, f.reader)).toMatchObject({
      status: 'inconclusive',
      code: 'duplicate_rpc_log',
    });
  });
  it('canonical hash changes are inconclusive, not proof of invalid supplier work', async () => {
    const f = fixture();
    const block = f.reader.block;
    f.reader.block = async n => ({ ...(await block(n)), hash: n === 3n ? h(888) : (await block(n)).hash });
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'history_changed' });
  });
  it('malformed RPC or a timeout is never verified', async () => {
    const f = fixture();
    f.reader.agreement = async () => null as any;
    expect((await verifyAgreement(f.t, 1n, f.reader)).status).toBe('inconclusive');
    f.reader.chainId = async () => {
      throw new Error('timeout');
    };
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'rpc_unavailable' });
  });
  it('incomplete history budget remains inconclusive, not a partial success', async () => {
    const f = fixture();
    f.reader.logs = async () => {
      throw new ChainReadError('history_query_budget');
    };
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'history_query_budget' });
  });
  it('a real receipt reached by a forwarding target is outside the supported model', async () => {
    const f = fixture();
    f.receipts.get(h(2))!.to = address(99);
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'unsupported_caller' });
    f.receipts.get(h(2))!.logs = [];
    expect(await verifyAgreement(f.t, 1n, f.reader)).toEqual({ status: 'inconclusive', code: 'receipt_log_missing' });
  });
});
