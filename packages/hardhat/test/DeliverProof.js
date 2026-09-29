const { expect } = require('chai');
const { ethers, network } = require('hardhat');

describe('DeliverProof: state, authority and liabilities', function () {
  let dp, buyer, supplier, other, due, review, cid, sha;
  const amount = 100_000_000n;
  const terms = ethers.id('Synthetic report; approve explicitly or refund after deadline.');
  before(async function () {
    const { CID } = await import('multiformats/cid');
    const { sha256 } = await import('multiformats/hashes/sha2');
    const digest = await sha256.digest(new TextEncoder().encode('Synthetic report\n'));
    cid = CID.createV1(0x55, digest).toString();
    sha = ethers.hexlify(digest.digest);
  });
  beforeEach(async function () {
    [buyer, supplier, other] = await ethers.getSigners();
    dp = await (await ethers.getContractFactory('DeliverProof')).deploy();
    const now = (await ethers.provider.getBlock('latest')).timestamp;
    due = now + 100;
    review = now + 200;
    await dp.createAgreement(supplier.address, amount, due, review, terms);
  });
  async function funded() {
    await dp.fund(1, { value: amount });
  }
  async function submitted() {
    await funded();
    await dp.connect(supplier).submit(1, cid, sha, 17, 1);
  }
  async function approved() {
    await submitted();
    await dp.approve(1, (await dp.getAgreement(1)).commitment);
  }
  async function timestamp(n) {
    await network.provider.send('evm_setNextBlockTimestamp', [n]);
  }
  async function liabilities() {
    expect(await ethers.provider.getBalance(await dp.getAddress())).to.equal(
      (await dp.totalLocked()) + (await dp.totalCredits()),
    );
  }

  it('keeps immutable participants and terms; does not create a funded state implicitly', async () => {
    const a = await dp.getAgreement(1);
    expect(a.buyer).to.equal(buyer.address);
    expect(a.supplier).to.equal(supplier.address);
    expect(a.termsHash).to.equal(terms);
    expect(a.state).to.equal(1);
    await liabilities();
  });
  it('rejects zero/self participants, zero value, excessive value, bad deadlines and empty terms', async () => {
    for (const args of [
      [ethers.ZeroAddress, amount, due, review, terms],
      [buyer.address, amount, due, review, terms],
      [supplier.address, 0, due, review, terms],
      [supplier.address, 1_000_000_001n, due, review, terms],
      [supplier.address, amount, 1, review, terms],
      [supplier.address, amount, due, due, terms],
      [supplier.address, amount, due, review, ethers.ZeroHash],
    ])
      await expect(dp.createAgreement(...args)).to.be.revertedWithCustomError(dp, 'InvalidTerms');
  });
  it('rejects unknown IDs and direct transfers', async () => {
    await expect(dp.getAgreement(999)).to.be.revertedWithCustomError(dp, 'UnknownAgreement');
    await expect(buyer.sendTransaction({ to: await dp.getAddress(), value: amount })).to.be.revertedWithCustomError(
      dp,
      'DirectPaymentRejected',
    );
  });
  it('only the buyer funds, with exactly the agreed tinybar amount, once', async () => {
    await expect(dp.connect(other).fund(1, { value: amount })).to.be.revertedWithCustomError(dp, 'Unauthorized');
    for (const value of [amount - 1n, amount + 1n])
      await expect(dp.fund(1, { value })).to.be.revertedWithCustomError(dp, 'WrongAmount');
    await funded();
    await liabilities();
    await expect(dp.fund(1, { value: amount })).to.be.revertedWithCustomError(dp, 'WrongState');
    expect(await dp.totalLocked()).to.equal(amount);
  });
  it('rejects funding after the delivery deadline without trapping a deposit', async () => {
    await timestamp(due + 1);
    await expect(dp.fund(1, { value: amount })).to.be.revertedWithCustomError(dp, 'DeadlinePassed');
    await liabilities();
    expect((await dp.getAgreement(1)).state).to.equal(1);
  });
  it('only the supplier can submit a final version, once', async () => {
    await funded();
    await expect(dp.submit(1, cid, sha, 17, 1)).to.be.revertedWithCustomError(dp, 'Unauthorized');
    await dp.connect(supplier).submit(1, cid, sha, 17, 1);
    await expect(dp.connect(supplier).submit(1, cid, sha, 17, 1)).to.be.revertedWithCustomError(dp, 'WrongState');
    await liabilities();
  });
  it('rejects delivery outside bounds before recording any commitment', async () => {
    await funded();
    for (const args of [
      ['https://example.com', sha, 17, 1],
      [cid, ethers.ZeroHash, 17, 1],
      [cid, sha, 0, 1],
      [cid, sha, 1_048_577, 1],
      [cid, sha, 17, 0],
      [cid, sha, 17, 4],
    ]) {
      await expect(dp.connect(supplier).submit(1, ...args)).to.be.revertedWithCustomError(dp, 'InvalidDelivery');
    }
    expect((await dp.getAgreement(1)).state).to.equal(2);
  });
  it('binds CID, hash, size, media, version, terms, agreement, contract and network', async () => {
    await submitted();
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const types = [
      'bytes32',
      'uint256',
      'address',
      'uint256',
      'bytes32',
      'bytes32',
      'bytes32',
      'uint64',
      'uint8',
      'uint32',
    ];
    const values = [await dp.DOMAIN(), 31337, await dp.getAddress(), 1, terms, ethers.id(cid), sha, 17, 1, 1];
    expect((await dp.getAgreement(1)).commitment).to.equal(ethers.keccak256(coder.encode(types, values)));
    values[1] = 296;
    expect((await dp.getAgreement(1)).commitment).not.to.equal(ethers.keccak256(coder.encode(types, values)));
  });
  it('accepts delivery exactly at the delivery deadline', async () => {
    await funded();
    await timestamp(due);
    await dp.connect(supplier).submit(1, cid, sha, 17, 1);
    expect((await dp.getAgreement(1)).state).to.equal(3);
  });
  it('rejects delivery just after the deadline', async () => {
    await funded();
    await timestamp(due + 1);
    await expect(dp.connect(supplier).submit(1, cid, sha, 17, 1)).to.be.revertedWithCustomError(dp, 'DeadlinePassed');
  });
  it('requires explicit buyer approval of the exact commitment', async () => {
    await submitted();
    const commitment = (await dp.getAgreement(1)).commitment;
    await expect(dp.connect(other).approve(1, commitment)).to.be.revertedWithCustomError(dp, 'Unauthorized');
    await expect(dp.approve(1, ethers.ZeroHash)).to.be.revertedWithCustomError(dp, 'WrongCommitment');
    expect(await dp.totalCredits()).to.equal(0);
    await dp.approve(1, commitment);
    await liabilities();
    expect(await dp.totalCredits()).to.equal(amount);
    expect((await dp.getAgreement(1)).withdrawn).to.equal(false);
  });
  it('buyer timeout refund is not available at the exact review deadline', async () => {
    await submitted();
    await timestamp(review);
    await expect(dp.refund(1)).to.be.revertedWithCustomError(dp, 'RefundNotAvailable');
  });
  it('can approve at the exact review deadline', async () => {
    await submitted();
    const commitment = (await dp.getAgreement(1)).commitment;
    await timestamp(review);
    await dp.approve(1, commitment);
    expect((await dp.getAgreement(1)).state).to.equal(4);
  });
  it('after reviewDeadline approval fails and buyer refund releases credit once', async () => {
    await submitted();
    const commitment = (await dp.getAgreement(1)).commitment;
    await timestamp(review + 1);
    await expect(dp.approve(1, commitment)).to.be.revertedWithCustomError(dp, 'DeadlinePassed');
    await dp.refund(1);
    expect(await dp.totalCredits()).to.equal(amount);
    await liabilities();
    await expect(dp.refund(1)).to.be.revertedWithCustomError(dp, 'WrongState');
    await expect(dp.approve(1, commitment)).to.be.revertedWithCustomError(dp, 'WrongState');
  });
  it('does not release money for silence; expiration needs a refund transaction', async () => {
    await funded();
    await timestamp(review + 1);
    await network.provider.send('evm_mine');
    expect((await dp.getAgreement(1)).state).to.equal(2);
    expect(await dp.totalCredits()).to.equal(0);
    await dp.refund(1);
    await liabilities();
  });
  it('supplier can voluntarily refund, unrelated wallets cannot', async () => {
    await funded();
    await expect(dp.connect(other).refund(1)).to.be.revertedWithCustomError(dp, 'Unauthorized');
    await dp.connect(supplier).refund(1);
    expect((await dp.getAgreement(1)).state).to.equal(5);
    await liabilities();
  });
  it('approved credit can only be withdrawn by the supplier, once', async () => {
    await approved();
    await expect(dp.refund(1)).to.be.revertedWithCustomError(dp, 'WrongState');
    await expect(dp.withdraw(1)).to.be.revertedWithCustomError(dp, 'Unauthorized');
    await expect(dp.connect(supplier).withdraw(1)).to.emit(dp, 'Withdrawn').withArgs(1, supplier.address, amount);
    await expect(dp.connect(supplier).withdraw(1)).to.be.revertedWithCustomError(dp, 'AlreadyWithdrawn');
    await liabilities();
    expect(await dp.totalCredits()).to.equal(0);
  });
  it('refunded credit goes only to the buyer and does not affect other agreements', async () => {
    await funded();
    await dp.createAgreement(supplier.address, amount, due, review, terms);
    await dp.fund(2, { value: amount });
    await dp.connect(supplier).refund(1);
    await expect(dp.connect(supplier).withdraw(1)).to.be.revertedWithCustomError(dp, 'Unauthorized');
    await dp.withdraw(1);
    expect((await dp.getAgreement(2)).state).to.equal(2);
    expect(await dp.totalLocked()).to.equal(amount);
    await liabilities();
  });
  it('failed transfer preserves the credit for retry and blocks reentrant withdrawal', async () => {
    const receiver = await (await ethers.getContractFactory('Receiver')).deploy(await dp.getAddress());
    await dp.createAgreement(await receiver.getAddress(), amount, due, review, terms);
    await dp.fund(2, { value: amount });
    await receiver.configure(2, true, false);
    await receiver.submit(cid, sha, 17, 1);
    await dp.approve(2, (await dp.getAgreement(2)).commitment);
    await expect(receiver.withdraw()).to.be.revertedWithCustomError(dp, 'TransferFailed');
    expect((await dp.getAgreement(2)).withdrawn).to.equal(false);
    expect(await dp.totalCredits()).to.equal(amount);
    await receiver.configure(2, false, true);
    await receiver.withdraw();
    expect(await receiver.reentered()).to.equal(false);
    expect((await dp.getAgreement(2)).withdrawn).to.equal(true);
    expect(await ethers.provider.getBalance(await receiver.getAddress())).to.equal(amount);
    await liabilities();
  });
});
