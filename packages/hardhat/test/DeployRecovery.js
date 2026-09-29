// Cloud-only. No personal key, faucet, external RPC or actual transaction.
// Tests the CLI control flow with an injected provider, plus durable files on a temporary filesystem.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { keccak256, getCreateAddress } = require('ethers');
const journal = require('../scripts/deploy-journal.cjs');
const script = fs.readFileSync(path.resolve(__dirname, '../scripts/deploy.cjs'), 'utf8');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const deployer = '0x' + '11'.repeat(20);
const expectedAddress = getCreateAddress({ from: deployer, nonce: 7 });
const artifact = { contractName: 'DeliverProof', abi: [], bytecode: '0x60006000', deployedBytecode: '0x6000' };
const intent = () => ({
  version: 1,
  stage: 'prepared',
  chainId: 31337,
  deployer,
  nonce: 7,
  expectedAddress,
  bytecodeHash: keccak256(artifact.bytecode),
  runtimeCodeHash: keccak256(artifact.deployedBytecode),
});
let temp;
describe('deployment utility (isolated temporary files)', function () {
  beforeEach(() => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'deliverproof-deploy-'));
  });
  afterEach(() => {
    fs.rmSync(temp, { recursive: true, force: true });
  });

  describe('deployment attempt journal', () => {
    it('persists only public allowlisted intent and preserves it before a hash exists', () => {
      const file = path.join(temp, 'attempt');
      journal.reserveAttempt(file, { ...intent(), extra: 'must not be stored' });
      assert.deepEqual(journal.readAttempt(file), { ...intent(), transactionHash: null });
      assert(!fs.readFileSync(file, 'utf8').includes('must not be stored'));
    });
    it('exclusive reservation refuses a second attempt without changing the first', () => {
      const file = path.join(temp, 'attempt');
      journal.reserveAttempt(file, intent());
      const before = fs.readFileSync(file);
      assert.throws(() => journal.reserveAttempt(file, { ...intent(), nonce: 8 }), { code: 'EEXIST' });
      assert.deepEqual(fs.readFileSync(file), before);
    });
    it('records a public hash once, preserving the original nonce and code hashes', () => {
      const file = path.join(temp, 'attempt');
      journal.reserveAttempt(file, intent());
      journal.recordSubmission(file, hash(1));
      assert.deepEqual(journal.readAttempt(file), { ...intent(), transactionHash: hash(1) });
      assert.throws(() => journal.recordSubmission(file, hash(2)), /submission_already_recorded/);
      assert.equal(journal.readAttempt(file).transactionHash, hash(1));
    });
    it('torn submission cannot silently become a retryable prepared intent', () => {
      const file = path.join(temp, 'attempt');
      journal.reserveAttempt(file, intent());
      fs.appendFileSync(file, '{"stage":"submitted",');
      assert.throws(() => journal.readAttempt(file), /invalid_deployment_journal/);
      assert.throws(() => journal.reserveAttempt(file, intent()), { code: 'EEXIST' });
    });
    it('an empty journal still blocks new deployment', () => {
      const file = path.join(temp, 'attempt');
      fs.writeFileSync(file, '');
      assert.throws(() => journal.readAttempt(file));
      assert.throws(() => journal.reserveAttempt(file, intent()), { code: 'EEXIST' });
    });
    it('rejects mainnet and invalid nonces before creating intent', () => {
      const file = path.join(temp, 'attempt');
      for (const delta of [{ chainId: 295 }, { nonce: -1 }, { nonce: 1.5 }, { nonce: Number.MAX_SAFE_INTEGER + 1 }]) {
        assert.throws(() => journal.reserveAttempt(file, { ...intent(), ...delta }));
        assert(!fs.existsSync(file));
      }
    });
  });

  function harness() {
    const scripts = path.join(temp, 'packages/hardhat/scripts');
    const lib = path.join(temp, 'packages/nextjs/lib');
    const compiled = path.join(temp, 'packages/hardhat/artifacts/contracts/DeliverProof.sol');
    for (const dir of [scripts, lib, compiled]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(lib, 'deployment.json'), 'null');
    fs.writeFileSync(path.join(compiled, 'DeliverProof.json'), JSON.stringify(artifact));
    const state = {
      sends: 0,
      signers: 0,
      receipt: null,
      loseResponse: false,
      output: '',
      env: {},
      tx: {
        hash: hash(1),
        to: null,
        from: deployer,
        nonce: 7,
        value: 0n,
        data: artifact.bytecode,
        chainId: 31337n,
      },
    };
    const receipt = {
      hash: hash(1),
      status: 1,
      contractAddress: expectedAddress,
      to: null,
      blockNumber: 10,
      blockHash: hash(10),
      from: deployer,
    };
    class Provider {
      async getNetwork() {
        return { chainId: 31337n };
      }
      async getSigner() {
        state.signers++;
        return { getAddress: async () => deployer, getNonce: async () => 7 };
      }
      async waitForTransaction() {
        return state.receipt;
      }
      async getTransaction() {
        return state.tx;
      }
      async getBlock() {
        return { hash: hash(10) };
      }
      async getCode() {
        return artifact.deployedBytecode;
      }
      destroy() {}
    }
    class Factory {
      async deploy(options) {
        assert.equal(options.nonce, 7);
        // Durable intent must already exist before the first possible side effect.
        assert.equal(journal.readAttempt(path.join(lib, 'deployment.attempt.jsonl')).nonce, 7);
        state.sends++;
        if (state.loseResponse) throw new Error('response lost after submission');
        return { deploymentTransaction: () => ({ hash: hash(1) }) };
      }
    }
    const exported = { exports: {} };
    function localRequire(name) {
      if (name === 'ethers')
        return {
          JsonRpcProvider: Provider,
          ContractFactory: Factory,
          keccak256,
          getCreateAddress,
          Wallet: class {
            constructor() {
              throw new Error('unexpected wallet');
            }
          },
        };
      if (name === './deploy-journal.cjs') return journal;
      if (name === 'node:fs') return fs;
      if (name === 'node:path') return path;
      throw new Error('unexpected module');
    }
    vm.runInNewContext(script, {
      require: localRequire,
      module: exported,
      __dirname: scripts,
      process: {
        env: state.env,
        stdout: {
          write: text => {
            state.output += text;
          },
        },
      },
    });
    return {
      state,
      receipt,
      main: exported.exports.main,
      journalFile: path.join(lib, 'deployment.attempt.jsonl'),
      candidate: path.join(lib, 'deployment.candidate.json'),
    };
  }

  describe('deployment CLI recovery without a second send', () => {
    it('timeout preserves a submitted attempt; another invocation cannot send again; recovery needs no signer', async () => {
      const h = harness();
      await assert.rejects(h.main(['--local']), /deployment_not_confirmed/);
      assert.equal(h.state.sends, 1);
      assert.equal(journal.readAttempt(h.journalFile).transactionHash, hash(1));
      await assert.rejects(h.main(['--local']), /reconcile_existing_attempt_first/);
      assert.equal(h.state.sends, 1);
      h.state.receipt = h.receipt;
      await h.main(['--recover-local']);
      assert.equal(h.state.sends, 1);
      assert.equal(h.state.signers, 1);
      assert.equal(JSON.parse(fs.readFileSync(h.candidate)).deploymentTx, hash(1));
    });
    it('lost response leaves prepared intent; a separately located public hash recovers with no resubmission', async () => {
      const h = harness();
      h.state.loseResponse = true;
      await assert.rejects(h.main(['--local']), /response lost/);
      assert.equal(journal.readAttempt(h.journalFile).transactionHash, null);
      await assert.rejects(h.main(['--local']), /reconcile_existing_attempt_first/);
      await assert.rejects(h.main(['--recover-local']), /recovery_hash_required/);
      h.state.env.DELIVERPROOF_RECOVERY_TX = hash(1);
      h.state.receipt = h.receipt;
      await h.main(['--recover-local']);
      assert.equal(h.state.sends, 1);
      assert.equal(h.state.signers, 1);
      assert(fs.existsSync(h.candidate));
    });
    it('an unrelated transaction cannot populate a candidate even with a successful receipt', async () => {
      const h = harness();
      journal.reserveAttempt(h.journalFile, intent());
      h.state.env.DELIVERPROOF_RECOVERY_TX = hash(1);
      h.state.receipt = h.receipt;
      h.state.tx.nonce = 8;
      await assert.rejects(h.main(['--recover-local']), /deployment_transaction_mismatch/);
      assert(!fs.existsSync(h.candidate));
      assert.equal(h.state.sends, 0);
      assert.equal(h.state.signers, 0);
    });
    it('a conflicting public hash does not replace the recorded transaction', async () => {
      const h = harness();
      journal.reserveAttempt(h.journalFile, intent());
      journal.recordSubmission(h.journalFile, hash(1));
      h.state.env.DELIVERPROOF_RECOVERY_TX = hash(2);
      await assert.rejects(h.main(['--recover-local']), /recovery_hash_conflict/);
      assert(!fs.existsSync(h.candidate));
      assert.equal(h.state.sends, 0);
    });
    it('wrong chain context remains blocked, without a wallet', async () => {
      const h = harness();
      journal.reserveAttempt(h.journalFile, { ...intent(), chainId: 296 });
      h.state.env.DELIVERPROOF_RECOVERY_TX = hash(1);
      h.state.receipt = { ...h.receipt, status: 0 };
      await assert.rejects(h.main(['--recover-local']), /journal_context_mismatch/);
      assert(!fs.existsSync(h.candidate));
      assert.equal(h.state.sends, 0);
      assert.equal(h.state.signers, 0);
    });
    it('a failed transaction never creates a candidate and never triggers a retry', async () => {
      const h = harness();
      journal.reserveAttempt(h.journalFile, intent());
      journal.recordSubmission(h.journalFile, hash(1));
      h.state.receipt = { ...h.receipt, status: 0 };
      await assert.rejects(h.main(['--recover-local']), /deployment_not_confirmed/);
      assert(!fs.existsSync(h.candidate));
      assert.equal(h.state.sends, 0);
      assert.equal(h.state.signers, 0);
    });
    for (const [field, value] of [
      ['data', '0x6001'],
      ['from', '0x' + '22'.repeat(20)],
      ['value', 1n],
      ['chainId', 296n],
    ]) {
      it(`recovery rejects transaction ${field} inconsistent with the intent`, async () => {
        const h = harness();
        journal.reserveAttempt(h.journalFile, intent());
        journal.recordSubmission(h.journalFile, hash(1));
        h.state.receipt = h.receipt;
        h.state.tx[field] = value;
        await assert.rejects(h.main(['--recover-local']), /deployment_transaction_mismatch/);
        assert(!fs.existsSync(h.candidate));
        assert.equal(h.state.sends, 0);
      });
    }
    it('an existing candidate prevents both new deployment and recovery overwrites', async () => {
      const h = harness();
      h.state.receipt = h.receipt;
      await h.main(['--local']);
      const before = fs.readFileSync(h.candidate);
      await assert.rejects(h.main(['--local']), /review_existing_candidate_first/);
      await assert.rejects(h.main(['--recover-local']), /review_existing_candidate_first/);
      assert.deepEqual(fs.readFileSync(h.candidate), before);
      assert.equal(h.state.sends, 1);
    });
  });
});
