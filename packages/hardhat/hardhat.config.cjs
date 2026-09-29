require('@nomicfoundation/hardhat-ethers');
require('@nomicfoundation/hardhat-chai-matchers');
const { subtask } = require('hardhat/config');
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require('hardhat/builtin-tasks/task-names');
// Registry-pinned solc avoids an unpinned compiler download in the cloud runner.
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD).setAction(async ({ solcVersion }, _, runSuper) => {
  if (solcVersion !== '0.8.28') return runSuper();
  return {
    compilerPath: require.resolve('solc/soljson.js'),
    isSolcJs: true,
    version: '0.8.28',
    longVersion: require('solc').version(),
  };
});
module.exports = {
  solidity: { version: '0.8.28', settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris' } },
  networks: { hardhat: { chainId: 31337 } },
  mocha: { timeout: 20000 },
};
