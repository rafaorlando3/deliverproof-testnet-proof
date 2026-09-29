// Suíte opcional da revisão do Claude: precisa do artifact compilado e sobe um `hardhat node` local.
// Não entra no `vitest run` padrão (arquivos *.chain.ts).
import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { include: ['test-chain/**/*.chain.ts'], testTimeout: 60_000, hookTimeout: 90_000, fileParallelism: false },
});
