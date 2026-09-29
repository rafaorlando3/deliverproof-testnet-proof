// Runner da trilha HCS suplementar, na cópia de prova. Roda na raiz da cópia, com o núcleo DESTA cópia.
//   vite-node operacao/hcs.ts preparar   --diario D --anteriores DIR --execucoes-ambiente F --acao criar-topico|publicar --operador 0.0.N [--acordos 1,2]
//   vite-node operacao/hcs.ts transmitir --diario D --operador 0.0.N          (único passo com DELIVERPROOF_TESTNET_PRIVATE_KEY)
//   vite-node operacao/hcs.ts concluir   --diario D --anteriores DIR --execucoes-ambiente F --operador 0.0.N [--acordos 1,2]
// O tópico confiável vem de hcs-topico.json, commitado por revisão depois da criação (como o deployment.json).
// O histórico revisado vem de hcs-registro.json (execuções HCS) e operacao-registro.json (execuções EVM), ambos
// commitados por revisão; F é a saída de listar-execucoes-ambiente.sh (inventário independente do ambiente).
// A implantação vem de packages/nextjs/lib/deployment.json da cópia. Saída: uma linha JSON pública por evento;
// erros só como código. Nenhuma chave, bytes assinados ou corpo remoto em arquivo, artefato ou log.
import { existsSync, readFileSync } from 'node:fs';
import { createPublicClient, custom } from 'viem';
import { validateDeployment, verifyAgreement, type TrustedDeployment } from '../packages/core/src/network.ts';
import { mirrorTopicReader, validKey, validTopicId, type TrustedTopic } from '../packages/core/src/hcs.ts';
import { viemReader } from '../packages/core/test-chain/viem-reader.ts';
// @ts-expect-error módulo .mjs sem tipos
import { rpc, publico, Falha } from './lib/rede.mjs';
// @ts-expect-error módulo .mjs sem tipos
import { origem, primeiraTentativa, autorizado, configuracao } from './lib/config.mjs';
// @ts-expect-error módulo .mjs sem tipos
import { linha } from './lib/estado.mjs';
import { contaValida } from './lib/hcs-diario.ts';
import { mirrorHcs } from './lib/hcs-mirror.ts';
import { enviadorSdk } from './lib/hcs-envio.ts';
import { preparar, transmitir, concluir, type Contexto, type Deps } from './lib/hcs-runner.ts';

const raiz = process.cwd();

function args(lista: string[]) {
  const o: Record<string, string> = {};
  for (let i = 0; i < lista.length; i += 2) {
    const k = lista[i];
    if (!k?.startsWith('--') || lista[i + 1] === undefined) throw new Falha('uso');
    o[k.slice(2)] = lista[i + 1]!;
  }
  return o;
}

function acordos(v: string | undefined): bigint[] {
  const s = v ?? '1,2';
  if (!/^[1-9][0-9]{0,9}(,[1-9][0-9]{0,9}){0,3}$/.test(s)) throw new Falha('acordos_invalidos');
  return s.split(',').map(BigInt);
}

function lerJson(f: string) {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    throw new Falha('arquivo_ilegivel');
  }
}

/** hcs-topico.json revisado: { topicId, submitKey: { type, key }, criacao }. Ausente = null. */
function topico(): TrustedTopic | null {
  const f = `${raiz}/hcs-topico.json`;
  if (!existsSync(f)) return null;
  const x = lerJson(f);
  const t = { topicId: x?.topicId, submitKey: { type: x?.submitKey?.type, key: x?.submitKey?.key } };
  if (!validTopicId(t.topicId) || !validKey(t.submitKey)) throw new Falha('hcs_topico_invalido');
  return t as TrustedTopic;
}

function implantacao(): TrustedDeployment | null {
  const m = lerJson(`${raiz}/packages/nextjs/lib/deployment.json`);
  if (m === null) return null;
  try {
    const t = { ...m, deploymentBlock: BigInt(m.deploymentBlock) } as TrustedDeployment;
    validateDeployment(t);
    return t;
  } catch {
    throw new Falha('implantacao_invalida');
  }
}

function deps(cfg: { nome: string; rpc: string }): Deps {
  const t = implantacao();
  const chamar = rpc(cfg.rpc);
  // Mesmo transporte limitado de conferir.ts: erro EIP-1193 só com código e dado de revert.
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
  const reader = viemReader(pub as never, { timeWindows: true });
  return {
    agora: () => Date.now(),
    dormir: ms => new Promise(r => setTimeout(r, ms)),
    mirror: mirrorHcs(),
    // O leitor do tópico do template só aceita o mirror oficial da testnet.
    leitor: mirrorTopicReader(),
    implantacao: t,
    verificar: id => {
      if (!t) throw new Falha('implantacao_ausente');
      return verifyAgreement(t, id, reader);
    },
    saida: linha,
  };
}

async function principal() {
  primeiraTentativa();
  const [cmd, ...resto] = process.argv.slice(2);
  const a = args(resto);
  const cfg = configuracao();
  if (cfg.nome !== 'testnet') throw new Falha('runner_hcs_so_testnet');
  if (!a.diario || !contaValida(a.operador)) throw new Falha('uso');
  const ctx: Contexto = {
    diario: a.diario,
    anteriores: a.anteriores ?? '',
    registro: `${raiz}/hcs-registro.json`,
    registroEvm: `${raiz}/operacao-registro.json`,
    ambiente: a['execucoes-ambiente'] ?? '',
    operador: a.operador,
    execucao:
      process.env.GITHUB_RUN_ID && /^[0-9]{1,20}$/.test(process.env.GITHUB_RUN_ID)
        ? process.env.GITHUB_RUN_ID
        : 'local-cli',
    origem: origem(raiz),
  };
  if (cmd === 'preparar') {
    if (a.acao !== 'criar-topico' && a.acao !== 'publicar') throw new Falha('acao_invalida');
    await preparar(ctx, deps(cfg), { acao: a.acao, acordos: acordos(a.acordos), topico: topico() });
    return 0;
  }
  if (cmd === 'transmitir') {
    autorizado(cfg);
    const enviador = enviadorSdk(ctx.operador, process.env.DELIVERPROOF_TESTNET_PRIVATE_KEY);
    try {
      const r = await transmitir(ctx, { agora: () => Date.now(), saida: linha }, enviador);
      return r.codigo === 'enviadas' || r.codigo === 'nada_a_enviar' ? 0 : r.codigo === 'desconhecida' ? 3 : 1;
    } finally {
      enviador.fechar();
    }
  }
  if (cmd === 'concluir') {
    const r = await concluir(ctx, deps(cfg), { acordos: acordos(a.acordos), topico: topico() });
    return r.codigo === 'trilha_consistente' || r.codigo === 'sem_topico_registrado' ? 0 : 4;
  }
  throw new Falha('uso');
}

principal().then(
  c => process.exit(c),
  e => {
    linha({ etapa: 'erro', ...publico(e) });
    process.exit(1);
  },
);
