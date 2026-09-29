'use strict';
const fs = require('node:fs');
const path = require('node:path');

const hash = x => typeof x === 'string' && /^0x[0-9a-f]{64}$/i.test(x);
const address = x => typeof x === 'string' && /^0x[0-9a-f]{40}$/i.test(x);
function fail() {
  throw new Error('invalid_deployment_journal');
}
function prepared(record) {
  if (
    !record ||
    record.version !== 1 ||
    record.stage !== 'prepared' ||
    ![296, 31337].includes(record.chainId) ||
    !address(record.deployer) ||
    !address(record.expectedAddress) ||
    !Number.isSafeInteger(record.nonce) ||
    record.nonce < 0 ||
    !hash(record.bytecodeHash) ||
    !hash(record.runtimeCodeHash)
  )
    fail();
  // Explicit allowlist: never persist signer, raw signed transaction, environment or arbitrary metadata.
  return {
    version: 1,
    stage: 'prepared',
    chainId: record.chainId,
    deployer: record.deployer,
    expectedAddress: record.expectedAddress,
    nonce: record.nonce,
    bytecodeHash: record.bytecodeHash,
    runtimeCodeHash: record.runtimeCodeHash,
  };
}
function syncDirectory(file) {
  const fd = fs.openSync(path.dirname(file), 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function writeRecord(fd, record) {
  const bytes = Buffer.from(JSON.stringify(record) + '\n');
  if (fs.writeSync(fd, bytes) !== bytes.length) throw new Error('journal_write_incomplete');
  fs.fsyncSync(fd);
}

/** Exclusive durable intent BEFORE sending. Even an incomplete file blocks a second deployment. */
function reserveAttempt(file, record) {
  const safe = prepared(record);
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    writeRecord(fd, safe);
  } finally {
    fs.closeSync(fd);
  }
  syncDirectory(file);
  return safe;
}

function readAttempt(file) {
  const text = fs.readFileSync(file, 'utf8');
  // A torn record is uncertain: never repair it by automatically sending again.
  if (text.length > 4096 || !text.endsWith('\n')) fail();
  const lines = text.trimEnd().split('\n');
  if (lines.length < 1 || lines.length > 2) fail();
  let first, second;
  try {
    first = JSON.parse(lines[0]);
    second = lines.length === 2 ? JSON.parse(lines[1]) : null;
  } catch {
    fail();
  }
  const intent = prepared(first);
  if (second && (second.stage !== 'submitted' || !hash(second.transactionHash))) fail();
  return { ...intent, transactionHash: second ? second.transactionHash : null };
}

function recordSubmission(file, transactionHash) {
  if (!hash(transactionHash)) fail();
  const current = readAttempt(file);
  if (current.transactionHash) throw new Error('submission_already_recorded');
  // No automatic creation: the durable intent must already exist.
  const fd = fs.openSync(file, 'r+');
  try {
    const bytes = Buffer.from(JSON.stringify({ stage: 'submitted', transactionHash }) + '\n');
    const size = fs.fstatSync(fd).size;
    if (fs.writeSync(fd, bytes, 0, bytes.length, size) !== bytes.length) throw new Error('journal_write_incomplete');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = { reserveAttempt, readAttempt, recordSubmission };
