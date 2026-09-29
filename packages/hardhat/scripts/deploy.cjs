'use strict';
// Explicit deployment utility. Never imported by tests, startup or installation.
// Only public deployment provenance is written. A testnet key comes from process
// environment, never dotenv, argv, a file or a printed diagnostic.
const fs = require('node:fs');
const path = require('node:path');
const { JsonRpcProvider, Wallet, ContractFactory, keccak256, getCreateAddress } = require('ethers');
const { reserveAttempt, readAttempt, recordSubmission } = require('./deploy-journal.cjs');

async function main(mode = process.argv.slice(2)) {
  if (mode.length !== 1 || !['--local', '--testnet', '--recover-local', '--recover-testnet'].includes(mode[0]))
    throw new Error('mode_required');
  const local = mode[0] === '--local' || mode[0] === '--recover-local';
  const recovering = mode[0].startsWith('--recover-');
  if (!local && !recovering && process.env.DELIVERPROOF_TESTNET_AUTHORIZED !== 'yes')
    throw new Error('explicit_testnet_authorization_required');
  const destination = path.resolve(__dirname, '../../nextjs/lib/deployment.json');
  if (JSON.parse(fs.readFileSync(destination, 'utf8')) !== null) throw new Error('deployment_already_configured');
  const candidate = destination.replace(/\.json$/, '.candidate.json');
  if (fs.existsSync(candidate)) throw new Error('review_existing_candidate_first');
  const journal = destination.replace(/\.json$/, '.attempt.jsonl');
  if (!recovering && fs.existsSync(journal)) throw new Error('reconcile_existing_attempt_first');
  const artifact = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '../artifacts/contracts/DeliverProof.sol/DeliverProof.json'), 'utf8'),
  );
  if (
    artifact.contractName !== 'DeliverProof' ||
    !/^0x[0-9a-f]+$/i.test(artifact.bytecode) ||
    !/^0x[0-9a-f]+$/i.test(artifact.deployedBytecode)
  )
    throw new Error('compile_first');
  const provider = new JsonRpcProvider(local ? 'http://127.0.0.1:8545' : 'https://testnet.hashio.io/api');
  try {
    const chainId = Number((await provider.getNetwork()).chainId);
    if (chainId !== (local ? 31337 : 296)) throw new Error('wrong_network');
    let attempt, transactionHash;
    if (recovering) {
      attempt = readAttempt(journal);
      if (
        attempt.chainId !== chainId ||
        attempt.bytecodeHash !== keccak256(artifact.bytecode) ||
        attempt.runtimeCodeHash !== keccak256(artifact.deployedBytecode)
      )
        throw new Error('journal_context_mismatch');
      // If the process died after transmission but before recording the hash, an operator
      // supplies only the independently located PUBLIC hash. This path never signs/sends.
      const supplied = process.env.DELIVERPROOF_RECOVERY_TX;
      if (supplied && attempt.transactionHash && supplied.toLowerCase() !== attempt.transactionHash.toLowerCase())
        throw new Error('recovery_hash_conflict');
      transactionHash = attempt.transactionHash || supplied;
      if (!transactionHash || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new Error('recovery_hash_required');
    } else {
      let signer;
      if (local)
        signer = await provider.getSigner(0); // Cloud-only ephemeral unlocked chain; no stored key.
      else {
        const key = process.env.DELIVERPROOF_TESTNET_PRIVATE_KEY;
        if (!key || !/^0x[0-9a-f]{64}$/i.test(key)) throw new Error('testnet_key_missing');
        signer = new Wallet(key, provider);
      }
      const deployer = await signer.getAddress();
      const nonce = await signer.getNonce('pending');
      attempt = reserveAttempt(journal, {
        version: 1,
        stage: 'prepared',
        chainId,
        deployer,
        nonce,
        expectedAddress: getCreateAddress({ from: deployer, nonce }),
        bytecodeHash: keccak256(artifact.bytecode),
        runtimeCodeHash: keccak256(artifact.deployedBytecode),
      });
      const instance = await new ContractFactory(artifact.abi, artifact.bytecode, signer).deploy({ nonce });
      const tx = instance.deploymentTransaction();
      if (!tx) throw new Error('deployment_transaction_missing');
      transactionHash = tx.hash;
      process.stdout.write(
        JSON.stringify({ stage: 'submitted-not-confirmed', chainId, deploymentTx: transactionHash }) + '\n',
      );
      recordSubmission(journal, transactionHash);
    }
    const receipt = await provider.waitForTransaction(transactionHash, 1, 120000);
    if (!receipt || receipt.status !== 1 || !receipt.contractAddress || receipt.to !== null)
      throw new Error('deployment_not_confirmed');
    const tx = await provider.getTransaction(transactionHash);
    if (
      !tx ||
      tx.hash.toLowerCase() !== transactionHash.toLowerCase() ||
      tx.to !== null ||
      tx.chainId !== BigInt(chainId) ||
      tx.from.toLowerCase() !== attempt.deployer.toLowerCase() ||
      tx.nonce !== attempt.nonce ||
      tx.value !== 0n ||
      keccak256(tx.data) !== attempt.bytecodeHash
    )
      throw new Error('deployment_transaction_mismatch');
    const address = getCreateAddress({ from: attempt.deployer, nonce: attempt.nonce });
    if (address.toLowerCase() !== attempt.expectedAddress.toLowerCase()) throw new Error('journal_address_mismatch');
    const block = await provider.getBlock(receipt.blockNumber);
    const code = await provider.getCode(address, receipt.blockNumber);
    if (
      receipt.hash.toLowerCase() !== transactionHash.toLowerCase() ||
      !block ||
      block.hash !== receipt.blockHash ||
      receipt.contractAddress.toLowerCase() !== address.toLowerCase() ||
      receipt.from.toLowerCase() !== attempt.deployer.toLowerCase()
    )
      throw new Error('deployment_receipt_mismatch');
    if (keccak256(code) !== keccak256(artifact.deployedBytecode)) throw new Error('runtime_code_mismatch');
    const manifest = {
      chainId,
      address,
      deployer: attempt.deployer,
      deploymentTx: transactionHash,
      deploymentBlock: String(receipt.blockNumber),
      runtimeCodeHash: keccak256(artifact.deployedBytecode),
    };
    // Create a separate candidate first. The operator reviews it before installation.
    fs.writeFileSync(candidate, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    process.stdout.write(
      'Confirmed receipt and matching compiled runtime. Public candidate manifest written; review before installing or enabling the UI.\n',
    );
  } finally {
    provider.destroy();
  }
}
if (require.main === module)
  main().catch(() => {
    // Never dump library exceptions: RPC/signing errors can contain request material.
    process.stderr.write(
      'Deployment did not complete all checks. Preserve the public attempt journal and inspect its account/nonce and transaction hash. Do not delete it or retry deployment to resolve an unknown result. Recovery mode only reads and validates an existing transaction; it never signs or sends. Check the operator guide.\n',
    );
    process.exitCode = 1;
  });
module.exports = { main };
