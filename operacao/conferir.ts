// Conferência só de leitura do deploy e dos acordos, com a biblioteca do núcleo DESTA cópia de prova
// (packages/core no SHA do template registrado em ORIGEM-PROVA.json). Sem chave, sem assinatura, sem envio.
// Uso, na raiz da cópia: vite-node operacao/conferir.ts <deployment.json> <artifact.json> --acordos 1,2 [--controle 999]
// Toda leitura de rede passa pelo cliente limitado deste pacote (prazo, limite de bytes, sem redirecionamento);
// erros saem só como código. Manifesto ou chain inválidos param antes das leituras seguintes.
// Links públicos (HashScan e mirror) só na chain 296; no nó local não há tabela pública.
import { createPublicClient, custom, keccak256, type Hex } from 'viem';
import { readFileSync } from 'node:fs';
import { validateDeployment, verifyAgreement, type TrustedDeployment } from '../packages/core/src/network.ts';
import { viemReader } from '../packages/core/test-chain/viem-reader.ts';
// @ts-expect-error módulo .mjs sem tipos
import { rpc, buscar, publico, Falha } from './lib/rede.mjs';

const MIRROR = 'https://testnet.mirrornode.hedera.com';
const sair = (codigo: string) => {
  console.log(JSON.stringify({ etapa: 'parada', codigo }));
  process.exit(1);
};

async function principal() {
  const argv = process.argv.slice(2);
  const [manifestPath, artifactPath] = argv;
  const lista = (n: string) => {
    if (!argv.includes(n)) return [];
    const v = argv[argv.indexOf(n) + 1] ?? '';
    if (!/^\d+(,\d+)*$/.test(v)) throw new Falha('lista_de_ids_invalida');
    return v.split(',').map(BigInt);
  };
  const acordos = lista('--acordos');
  const controles = lista('--controle');
  if (!manifestPath || !artifactPath || !acordos.length) throw new Falha('uso');
  const lerJson = (f: string) => {
    try {
      return JSON.parse(readFileSync(f, 'utf8'));
    } catch {
      throw new Falha('arquivo_ilegivel');
    }
  };
  const origem = lerJson('ORIGEM-PROVA.json');
  const m = lerJson(manifestPath);
  const art = lerJson(artifactPath);
  if (!m || typeof m !== 'object') return sair('manifesto_invalido');
  let t: TrustedDeployment;
  try {
    t = { ...m, deploymentBlock: BigInt(m.deploymentBlock) };
    validateDeployment(t);
  } catch {
    return sair('manifesto_invalido');
  }
  const publica = t.chainId === 296;
  if (!publica && t.chainId !== 31337) return sair('chain_nao_suportada');
  const url = publica
    ? 'https://testnet.hashio.io/api'
    : (process.env.DELIVERPROOF_RPC_LOCAL ?? 'http://127.0.0.1:8545');
  if (!publica && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(url)) return sair('url_local_invalida');
  const chamar = rpc(url);
  // Erro da RPC vira um erro EIP-1193 só com código e dado de revert (sem a mensagem remota), para o viem
  // distinguir "acordo inexistente" (revert) de rede indisponível. Sem novas tentativas automáticas.
  const pub = createPublicClient({
    transport: custom(
      {
        request: async ({ method, params }) => {
          try {
            return await chamar(method, params ?? []);
          } catch (e) {
            if (e instanceof Falha && (e as { codigo: string }).codigo === 'rpc_erro') {
              const f = e as unknown as { status: number | null; dados?: string };
              throw Object.assign(new Error('rpc_erro'), { code: f.status ?? -32603, data: f.dados, cause: e });
            }
            throw e;
          }
        },
      },
      { retryCount: 0 },
    ),
  });
  const ok: Record<string, boolean | string> = {};
  let falhas = 0;
  const marca = (k: string, v: boolean, obs = '') => {
    ok[k] = v ? obs || true : `FALHA${obs ? `: ${obs}` : ''}`;
    if (!v) falhas++;
  };
  async function mirror(h: Hex) {
    try {
      const { status, bytes } = await buscar(
        `${MIRROR}/api/v1/contracts/results/${h}`,
        { headers: { accept: 'application/json' } },
        { prazoMs: 20_000, limiteBytes: 200_000, codigo: 'mirror' },
      );
      if (status !== 200) return { erro: `mirror_http_${status}` } as const;
      return JSON.parse(new TextDecoder().decode(bytes)) as {
        result?: string;
        block_number?: number;
        address?: string;
      };
    } catch (e) {
      return { erro: publico(e).codigo } as const;
    }
  }

  console.log(JSON.stringify({ origem }));
  marca('manifesto válido (validateDeployment)', true);
  if ((await pub.getChainId()) !== t.chainId) return sair('chain_da_rpc_diferente_do_manifesto');
  marca('chainId da RPC = manifesto', true);
  const r = await pub.getTransactionReceipt({ hash: t.deploymentTx });
  const tx = await pub.getTransaction({ hash: t.deploymentTx });
  const b = await pub.getBlock({ blockNumber: r.blockNumber });
  const code = await pub.getCode({ address: t.address });
  marca('recibo do deploy: sucesso', r.status === 'success');
  marca('recibo do deploy: to = null (criação)', r.to === null);
  marca('contractAddress = manifesto', r.contractAddress?.toLowerCase() === t.address.toLowerCase());
  marca('from = deployer', r.from.toLowerCase() === t.deployer.toLowerCase());
  marca('bloco e hash do bloco conferem', r.blockNumber === t.deploymentBlock && b.hash === r.blockHash);
  marca('valor anexado ao deploy = 0', tx.value === 0n);
  marca('runtime do artifact = runtimeCodeHash', keccak256(art.deployedBytecode) === t.runtimeCodeHash);
  marca('runtime na rede = runtimeCodeHash', !!code && keccak256(code) === t.runtimeCodeHash);
  if (falhas) return sair('implantacao_nao_confere');

  const linhas: string[] = [];
  const link = (h: string) =>
    `| \`${h}\` | [HashScan](https://hashscan.io/testnet/transaction/${h}) · [mirror](${MIRROR}/api/v1/contracts/results/${h}) |`;
  if (publica) {
    linhas.push(`| Contract deployment ${link(t.deploymentTx)}`);
    const mr = await mirror(t.deploymentTx);
    if ('erro' in mr) marca('mirror: resultado do deploy', false, mr.erro);
    else {
      marca('mirror: deploy SUCCESS', mr.result === 'SUCCESS');
      marca('mirror: endereço criado = manifesto', (mr.address ?? '').toLowerCase() === t.address.toLowerCase());
      marca('mirror: bloco = relay', BigInt(mr.block_number ?? -1) === r.blockNumber);
    }
  }
  const reader = viemReader(pub as never, { timeWindows: publica });
  for (const id of acordos) {
    const res = await verifyAgreement(t, id, reader);
    if (res.status !== 'verified') {
      marca(`acordo ${id}: verified`, false, `${res.status}: ${res.code}`);
      continue;
    }
    marca(
      `acordo ${id}: verified`,
      true,
      `estado ${res.agreement.state}; ${res.milestones.map(x => x.event).join(' > ')}`,
    );
    for (const ms of res.milestones) {
      if (!publica) continue;
      linhas.push(`| Agreement ${id}: ${ms.event} ${link(ms.hash)}`);
      const mr = await mirror(ms.hash);
      if ('erro' in mr) marca(`acordo ${id} ${ms.event}: mirror`, false, mr.erro);
      else
        marca(
          `acordo ${id} ${ms.event}: mirror SUCCESS e mesmo bloco`,
          mr.result === 'SUCCESS' && BigInt(mr.block_number ?? -1) === ms.block,
        );
    }
  }
  // Controle negativo, separado do resultado: um id que não existe NÃO pode sair verificado.
  const controle: Record<string, string> = {};
  for (const id of controles) {
    const res = await verifyAgreement(t, id, reader);
    controle[`id ${id}`] =
      res.status === 'verified' ? 'FALHA: saiu verificado' : `${res.status}: ${res.code} (esperado)`;
    if (res.status === 'verified') falhas++;
  }
  console.log(JSON.stringify({ conferencias: ok, controleNegativo: controle }, null, 1));
  if (publica) console.log('\n| Step | Transaction | Links |\n| --- | --- | --- |\n' + linhas.join('\n'));
  else console.log('\n(nó local: sem tabela pública e sem links)');
  console.log(`\n${falhas === 0 ? 'TUDO OK' : `${falhas} FALHA(S)`}`);
  process.exit(falhas === 0 ? 0 : 1);
}

principal().catch(e => {
  // Só o código: nunca mensagem de biblioteca ou corpo remoto.
  console.log(JSON.stringify({ etapa: 'erro', ...publico(e) }));
  process.exit(1);
});
