// Rede e chaves. Testnet tem endereços fixos; o modo local só aceita 127.0.0.1/localhost,
// para uma chave nunca ir para outro servidor por variável de ambiente.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { keccak256 } from 'viem';
import { Falha } from './rede.mjs';

const local = u => {
  let url;
  try {
    url = new URL(u);
  } catch {
    throw new Falha('url_local_invalida');
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
    throw new Falha('url_local_invalida');
  return url.origin + url.pathname.replace(/\/$/, '');
};
const ms = (v, padrao) =>
  v === undefined ? padrao : Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : padrao;

export function configuracao(env = process.env) {
  if (env.DELIVERPROOF_REDE === 'testnet')
    return {
      nome: 'testnet',
      chainId: 296,
      rpc: 'https://testnet.hashio.io/api',
      gateway: 'https://trustless-gateway.link',
      filebase: 'https://rpc.filebase.io',
      // No Hedera, o contrato vê tinybar; na RPC o valor é tinybar x 10^10 (weibar).
      paraRpc: tinybar => tinybar * 10_000_000_000n,
      janelaMs: 600_000,
      prazoReciboMs: 180_000,
      intervaloMs: 3_000,
      porta: { tentativas: 12, esperaMs: 15_000, prazoPedidoMs: 20_000, prazoTotalMs: 300_000 },
      saldoFornecedor: 3_000_000_000_000_000_000n, // 3 HBAR em weibar, só para as taxas do fornecedor
      minimoFornecedor: 2_000_000_000_000_000_000n,
      gasContaOca: 610_000n, // piso do relay para criar conta oca (ver prova.mjs, etapa saldo_fornecedor)
    };
  if (env.DELIVERPROOF_REDE === 'local')
    return {
      nome: 'local',
      chainId: 31337,
      rpc: local(env.DELIVERPROOF_RPC_LOCAL ?? 'http://127.0.0.1:8545'),
      gateway: env.DELIVERPROOF_GATEWAY_LOCAL ? local(env.DELIVERPROOF_GATEWAY_LOCAL) : null,
      filebase: env.DELIVERPROOF_FILEBASE_LOCAL ? local(env.DELIVERPROOF_FILEBASE_LOCAL) : null,
      paraRpc: tinybar => tinybar,
      janelaMs: ms(env.DELIVERPROOF_JANELA_MS, 600_000),
      prazoReciboMs: ms(env.DELIVERPROOF_PRAZO_RECIBO_MS, 10_000),
      intervaloMs: 200,
      porta: {
        tentativas: ms(env.DELIVERPROOF_PORTA_TENTATIVAS, 3),
        esperaMs: ms(env.DELIVERPROOF_PORTA_ESPERA_MS, 200),
        prazoPedidoMs: ms(env.DELIVERPROOF_PORTA_PRAZO_MS, 1_000),
        prazoTotalMs: ms(env.DELIVERPROOF_PORTA_PRAZO_TOTAL_MS, 5_000),
      },
      saldoFornecedor: 1_000_000_000_000_000_000n,
      minimoFornecedor: 500_000_000_000_000_000n,
      gasContaOca: 610_000n, // mesmo piso no nó local, para o ensaio conferir o limite assinado
    };
  throw new Falha('rede_nao_definida');
}

/** Chave do ambiente protegido: nunca argumento, arquivo ou log. */
export function chave(nome, env = process.env) {
  const k = env[nome];
  if (!k || !/^0x[0-9a-fA-F]{64}$/.test(k)) throw new Falha(`chave_ausente_ou_invalida:${nome}`);
  return k;
}

/** Re-execução (tentativa > 1) mantém o id da execução e esconderia o histórico dela: só um novo disparo. */
export function primeiraTentativa(env = process.env) {
  if (env.GITHUB_RUN_ATTEMPT !== undefined && env.GITHUB_RUN_ATTEMPT !== '1')
    throw new Falha('reexecucao_proibida_use_novo_disparo');
}

export function autorizado(cfg, env = process.env) {
  if (cfg.nome === 'testnet' && env.DELIVERPROOF_TESTNET_AUTHORIZED !== 'yes')
    throw new Falha('falta_autorizacao_testnet');
}

/** Artefato compilado do contrato, na cópia de prova gerada a partir do SHA aprovado. */
export function artefato(raiz) {
  let a;
  try {
    a = JSON.parse(
      readFileSync(path.join(raiz, 'packages/hardhat/artifacts/contracts/DeliverProof.sol/DeliverProof.json'), 'utf8'),
    );
  } catch {
    throw new Falha('compile_antes');
  }
  if (
    a.contractName !== 'DeliverProof' ||
    !/^0x[0-9a-f]+$/i.test(a.bytecode) ||
    !/^0x[0-9a-f]+$/i.test(a.deployedBytecode)
  )
    throw new Falha('compile_antes');
  return {
    abi: a.abi,
    bytecode: a.bytecode,
    bytecodeHash: keccak256(a.bytecode),
    runtimeCodeHash: keccak256(a.deployedBytecode),
  };
}

/** Origem registrada pela geração da cópia de prova (SHA do template e do pacote operacional). */
export function origem(raiz) {
  try {
    const o = JSON.parse(readFileSync(path.join(raiz, 'ORIGEM-PROVA.json'), 'utf8'));
    if (!/^[0-9a-f]{40}$/.test(o.template) || !/^[0-9a-f]{40}$/.test(o.operacao)) throw new Error();
    return { template: o.template, operacao: o.operacao };
  } catch {
    throw new Falha('origem_da_copia_ausente');
  }
}
