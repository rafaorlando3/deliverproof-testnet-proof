// Ensaio do runner HCS com rede Hedera e mirror FALSOS, na nuvem (nunca no Mac). Relógio simulado.
// A rede falsa imita as regras de que o runner depende: validade do id (início e fim), deduplicação do
// mesmo id, recibo por id, sequência por tópico e mirror com atraso configurável. Isso prova a lógica do
// runner contra essas regras, não o comportamento da rede real nem o sdkExecutor.
// uso, na raiz da cópia: vite-node operacao/ensaios/hcs.ensaio.ts <pasta de saída>
import { cpSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { PrivateKey } from '@hiero-ledger/sdk';
import type { TrustedDeployment, NetworkResult } from '../../packages/core/src/network.ts';
import type { HcsKey, TopicReader, TopicMessage, TrustedTopic } from '../../packages/core/src/hcs.ts';
import { preparar, transmitir, concluir, type Contexto, type Deps } from '../lib/hcs-runner.ts';
import { partes, validaAte, paraMirror, mesclar, type Intencao } from '../lib/hcs-diario.ts';
import type { MirrorHcs, Registro } from '../lib/hcs-mirror.ts';
import type { Enviador, Desfecho } from '../lib/hcs-envio.ts';
import { montar, enviadorSdk } from '../lib/hcs-envio.ts';
import { Client } from '@hiero-ledger/sdk';
// @ts-expect-error módulo .mjs sem tipos
import { publico } from '../lib/rede.mjs';

const saidaDir = process.argv[2];
if (!saidaDir) throw new Error('uso: hcs.ensaio.ts <saída>');
rmSync(saidaDir, { recursive: true, force: true });
mkdirSync(saidaDir, { recursive: true });
// Marcador sintético: se aparecer em qualquer arquivo gerado, algum erro remoto vazou.
const MARCADOR = 'MARCADOR' + randomBytes(28).toString('hex').toUpperCase();
const OPERADOR = '0.0.4815162';
const ORIGEM = { template: '398a0b3ed526b8fe8f4304f4c4d28728bdfe0dd1', operacao: '0'.repeat(40) };

const hex = (n: number) => ('0x' + randomBytes(n).toString('hex')) as `0x${string}`;
const chaveHex = hex(32);
const chavePriv = PrivateKey.fromStringECDSA(chaveHex.slice(2));
const PUBLICA: HcsKey = { type: 'ECDSA_SECP256K1', key: chavePriv.publicKey.toStringRaw().toLowerCase() };

const implantacao: TrustedDeployment = {
  chainId: 296,
  address: hex(20),
  deployer: hex(20),
  deploymentTx: hex(32),
  deploymentBlock: 100n,
  runtimeCodeHash: hex(32),
};
const EVENTOS: Record<string, string[]> = {
  '1': ['Created', 'Funded', 'Submitted', 'Approved', 'CreditAvailable', 'Withdrawn'],
  '2': ['Created', 'Funded', 'Refunded', 'CreditAvailable', 'Withdrawn'],
  '3': ['Created', 'Funded', 'Submitted', 'Approved', 'Refunded', 'CreditAvailable', 'Withdrawn'], // só para o limite
};
const verificados = new Map<string, NetworkResult>();
for (const [id, evs] of Object.entries(EVENTOS)) {
  let bloco = 200n + BigInt(id) * 100n;
  verificados.set(id, {
    status: 'verified',
    code: 'chain_matches',
    agreement: {} as never,
    snapshot: { number: 10_000n, hash: hex(32), timestamp: 0n },
    delivery: null,
    milestones: evs.map((event, k) => ({ event, hash: hex(32), block: (bloco += 3n), logIndex: k })),
  } as NetworkResult);
}

// ---------------- rede e mirror falsos ----------------
type Topico = { submitKey: HcsKey; mensagens: { sequence: number; consenso: number; bytes: Uint8Array }[] };
class RedeFalsa {
  agora = Date.UTC(2026, 8, 30, 12, 0, 0);
  atrasoMirror = 3_000;
  registros = new Map<string, (Registro & { em: number })[]>();
  topicos = new Map<string, Topico>();
  proximo = 7000;
  execucoes = 0;
  criacoesExternas: { topicId: string; txMirror: string; em: number }[] = [];
  consensoStr = (ms: number) => `${Math.floor(ms / 1000)}.${String((ms % 1000) * 1_000_000).padStart(9, '0')}`;
  /** Consenso de um id: dentro da validade, sem repetir o mesmo id. */
  executar(i: Intencao, assinante: HcsKey, falha?: string): { status: string; topicId?: string } {
    const { s, ns } = partes(i.transactionId);
    const inicio = s * 1000 + Math.floor(ns / 1e6);
    if (this.agora < inicio) throw Object.assign(new Error(MARCADOR), { status: 'INVALID_TRANSACTION_START' });
    if (this.agora > validaAte(i.transactionId))
      throw Object.assign(new Error(MARCADOR), { status: 'TRANSACTION_EXPIRED' });
    const ja = this.registros.get(i.transactionId);
    if (ja?.length) {
      const orig = ja[0]!;
      ja.push({ ...orig, result: 'DUPLICATE_TRANSACTION', em: this.agora });
      return { status: orig.result, ...(orig.entityId && i.acao === 'criar_topico' ? { topicId: orig.entityId } : {}) };
    }
    this.execucoes++;
    const em = (this.agora += 50);
    const reg = (result: string, entityId: string | null) =>
      this.registros.set(i.transactionId, [
        {
          result,
          name: i.acao === 'criar_topico' ? 'CONSENSUSCREATETOPIC' : 'CONSENSUSSUBMITMESSAGE',
          entityId,
          consenso: this.consensoStr(em),
          em,
        },
      ]);
    if (falha) {
      reg(falha, i.acao === 'mensagem' ? i.topicId! : null);
      return { status: falha };
    }
    if (i.acao === 'criar_topico') {
      const topicId = `0.0.${this.proximo++}`;
      this.topicos.set(topicId, { submitKey: assinante, mensagens: [] });
      reg('SUCCESS', topicId);
      return { status: 'SUCCESS', topicId };
    }
    const t = this.topicos.get(i.topicId!);
    if (!t) {
      reg('INVALID_TOPIC_ID', i.topicId!);
      return { status: 'INVALID_TOPIC_ID' };
    }
    if (t.submitKey.key !== assinante.key) {
      reg('INVALID_SIGNATURE', i.topicId!);
      return { status: 'INVALID_SIGNATURE' };
    }
    t.mensagens.push({ sequence: t.mensagens.length + 1, consenso: em, bytes: new TextEncoder().encode(i.texto!) });
    reg('SUCCESS', i.topicId!);
    return { status: 'SUCCESS' };
  }
  visivel = (em: number) => em <= this.agora - this.atrasoMirror;
  mirror(): MirrorHcs {
    return {
      transacao: async txId => {
        paraMirror(txId);
        return (this.registros.get(txId) ?? []).filter(r => this.visivel(r.em)).map(({ em: _e, ...r }) => r);
      },
      frescor: async () => this.agora - this.atrasoMirror,
      chaveDaConta: async () => ({ ...PUBLICA }),
      topicosCriados: async () => [
        ...[...this.registros.entries()].flatMap(([tx, rs]) =>
          rs
            .filter(r => r.result === 'SUCCESS' && r.name === 'CONSENSUSCREATETOPIC' && this.visivel(r.em))
            .map(r => ({ topicId: r.entityId!, txMirror: paraMirror(tx) })),
        ),
        ...this.criacoesExternas.filter(c => this.visivel(c.em)).map(({ em: _e, ...c }) => c),
      ],
    };
  }
  leitor(): TopicReader {
    return {
      topic: async topicId => {
        const t = this.topicos.get(topicId);
        if (!t) throw Object.assign(new Error(MARCADOR), { code: 'topic_not_found' });
        return { topicId, deleted: false, submitKey: { ...t.submitKey } };
      },
      messages: async topicId =>
        (this.topicos.get(topicId)?.mensagens ?? [])
          .filter(m => this.visivel(m.consenso))
          .map(
            m =>
              ({
                topicId,
                sequence: m.sequence,
                consensusTimestamp: this.consensoStr(m.consenso),
                bytes: m.bytes,
                chunkTotal: 1,
              }) as TopicMessage,
          ),
    };
  }
}

type Modo = 'normal' | 'perde_resposta' | 'falha_antes' | 'assinatura_errada' | 'lenta';
function enviadorFalso(
  rede: RedeFalsa,
  modos: Modo[] = [],
  publica: HcsKey = PUBLICA,
): Enviador & { chamadas: number } {
  const e = {
    chamadas: 0,
    chavePublica: () => ({ ...publica }),
    async enviar(i: Intencao): Promise<Desfecho> {
      const modo = modos[e.chamadas++] ?? 'normal';
      if (modo === 'falha_antes') return { situacao: 'desconhecida' };
      if (modo === 'lenta') rede.agora += 115_000;
      try {
        const r = rede.executar(i, publica, modo === 'assinatura_errada' ? 'INVALID_SIGNATURE' : undefined);
        if (modo === 'perde_resposta') return { situacao: 'desconhecida' };
        if (r.status === 'SUCCESS')
          return { situacao: 'confirmada', resultado: r.topicId ? { topicId: r.topicId } : {} };
        return { situacao: 'falhou', status: r.status };
      } catch {
        return { situacao: 'desconhecida' };
      }
    },
    fechar: () => {},
  };
  return e;
}

function montarDeps(rede: RedeFalsa, log: string[]): Deps {
  return {
    agora: () => rede.agora,
    dormir: async ms => {
      rede.agora += ms;
    },
    mirror: rede.mirror(),
    leitor: rede.leitor(),
    implantacao,
    verificar: async id => verificados.get(id.toString()) ?? { status: 'mismatch', code: 'agreement_not_found' },
    saida: o => log.push(JSON.stringify(o)),
  };
}

// ---------------- execuções simuladas (cada uma = um disparo do workflow) ----------------
let seqExec = 1000;
const EVM = ['500', '501']; // execuções EVM (deploy e prova) já no operacao-registro.json revisado
const sha256 = (f: string) => createHash('sha256').update(readFileSync(f)).digest('hex');
type Registro1 = { versao: 1; operador: string; execucoes: Record<string, unknown>[] };
type OpcoesExec = {
  /** Registro HCS escrito pela revisão; padrão: a revisão registra toda execução anterior com os hashes. */
  registro?: (padrao: Registro1) => Registro1 | null;
  /** Inventário do ambiente (implantações do GitHub); padrão: EVM + todas as execuções anteriores. */
  ambiente?: (padrao: string[]) => string[];
  /** Simula a listagem ou o ZIP sem um artefato: recebe a pasta baixada, antes da execução começar. */
  baixar?: (baixados: string) => void;
};
class Cenario {
  rede = new RedeFalsa();
  log: string[] = [];
  dir: string;
  anteriores: string;
  execucoes: { id: string; fim: number }[] = [];
  constructor(readonly nome: string) {
    this.dir = path.join(saidaDir, nome);
    // Artefatos de todas as execuções, como o GitHub guarda; cada execução baixa os das OUTRAS no início.
    this.anteriores = path.join(this.dir, 'artefatos');
    mkdirSync(this.anteriores, { recursive: true });
  }
  /** O que a revisão manual commitaria antes do próximo disparo: cada execução anterior com o hash dos diários. */
  revisao(): Registro1 {
    const ids = new Set([...this.execucoes.map(e => e.id), ...readdirSync(this.anteriores)]);
    const execucoes = [...ids].sort().map(id => {
      const base = path.join(this.anteriores, id);
      const artefatos: Record<string, string> = {};
      if (existsSync(base))
        for (const a of readdirSync(base).sort())
          if (existsSync(path.join(base, a, 'hcs-diario.json')))
            artefatos[`${a}/hcs-diario.json`] = sha256(path.join(base, a, 'hcs-diario.json'));
      if (Object.keys(artefatos).length) return { id, artefatos };
      const fim = this.execucoes.find(e => e.id === id)?.fim ?? this.rede.agora;
      return { id, perdida: true, revisao: 'parou antes de guardar diário', encerradaEm: new Date(fim).toISOString() };
    });
    return { versao: 1, operador: OPERADOR, execucoes };
  }
  novaExecucao(op: OpcoesExec = {}) {
    const execucao = String(++seqExec);
    const pasta = path.join(this.dir, `exec-${execucao}`);
    mkdirSync(pasta, { recursive: true });
    const baixados = path.join(pasta, 'anteriores');
    cpSync(this.anteriores, baixados, { recursive: true }); // baixar-artefatos.sh: só execuções anteriores
    op.baixar?.(baixados);
    const padraoAmbiente = [...EVM, ...new Set([...this.execucoes.map(e => e.id), ...readdirSync(this.anteriores)])];
    const registro = op.registro ? op.registro(this.revisao()) : this.revisao();
    if (registro) writeFileSync(path.join(pasta, 'hcs-registro.json'), JSON.stringify(registro, null, 2));
    writeFileSync(
      path.join(pasta, 'operacao-registro.json'),
      JSON.stringify({ versao: 2, execucoes: EVM.map(id => ({ id, autorizacao: `aut-${id}`, artefatos: {} })) }),
    );
    const ambiente = op.ambiente ? op.ambiente(padraoAmbiente) : padraoAmbiente;
    writeFileSync(path.join(pasta, 'execucoes-ambiente.json'), JSON.stringify(ambiente));
    const esta = { id: execucao, fim: this.rede.agora }; // fim: o último guardar (ou o início, se nada foi guardado)
    this.execucoes.push(esta);
    const ctx: Contexto = {
      diario: path.join(pasta, 'hcs-diario.json'),
      anteriores: baixados,
      registro: path.join(pasta, 'hcs-registro.json'),
      registroEvm: path.join(pasta, 'operacao-registro.json'),
      ambiente: path.join(pasta, 'execucoes-ambiente.json'),
      operador: OPERADOR,
      execucao,
      origem: ORIGEM,
    };
    let artefatos = 0;
    return {
      ctx,
      deps: montarDeps(this.rede, this.log),
      /** upload-artifact: copia o diário como está para anteriores/<execução>/hcs-diario-NN/. */
      guardar: () => {
        esta.fim = this.rede.agora;
        if (!existsSync(ctx.diario)) return;
        const alvo = path.join(this.anteriores, execucao, `hcs-diario-${String(++artefatos).padStart(2, '0')}`);
        mkdirSync(alvo, { recursive: true });
        writeFileSync(path.join(alvo, 'hcs-diario.json'), readFileSync(ctx.diario));
      },
    };
  }
  gravarLog() {
    writeFileSync(path.join(this.dir, 'eventos.jsonl'), this.log.join('\n') + '\n');
  }
}

const resultados: { caso: string; ok: boolean; obs: string }[] = [];
async function caso(nome: string, f: (c: Cenario) => Promise<string>) {
  const c = new Cenario(nome);
  try {
    const obs = await f(c);
    resultados.push({ caso: nome, ok: true, obs });
  } catch (e) {
    resultados.push({
      caso: nome,
      ok: false,
      obs: `${(e as Error).message === MARCADOR ? 'marcador' : JSON.stringify(publico(e))} ${(e as Error).message?.slice(0, 120)}`,
    });
  } finally {
    c.gravarLog();
  }
}
function exigir(ok: unknown, msg: string): asserts ok {
  if (!ok) throw new Error(`falhou: ${msg}`);
}
async function falhaCom(p: Promise<unknown>, codigo: string) {
  try {
    await p;
  } catch (e) {
    const c = publico(e).codigo;
    exigir(c === codigo, `esperado ${codigo}, veio ${c}`);
    return;
  }
  throw new Error(`falhou: esperado ${codigo}, não parou`);
}
const ler = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

async function criarTopico(c: Cenario, modos: Modo[] = []) {
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null });
  x.guardar();
  await transmitir(x.ctx, x.deps, enviadorFalso(c.rede, modos));
  x.guardar();
  return x;
}
function topicoRegistrado(c: Cenario): TrustedTopic {
  const [topicId, t] = [...c.rede.topicos.entries()][0]!;
  return { topicId, submitKey: { ...t.submitKey } };
}
/** Um disparo de publicar: três trios preparar/guardar/transmitir e concluir, como o workflow. */
async function publicar(c: Cenario, topico: TrustedTopic, modos: Modo[] = []) {
  const x = c.novaExecucao();
  const env = enviadorFalso(c.rede, modos);
  const acordos = [1n, 2n];
  let parou = '';
  for (let k = 0; k < 3 && !parou; k++) {
    await preparar(x.ctx, x.deps, { acao: 'publicar', acordos, topico });
    x.guardar();
    const r = await transmitir(x.ctx, x.deps, env);
    if (r.codigo !== 'enviadas' && r.codigo !== 'nada_a_enviar') parou = r.codigo;
  }
  let fim = '';
  if (!parou) fim = (await concluir(x.ctx, x.deps, { acordos, topico, releituras: 4, esperaMs: 2_000 })).codigo;
  x.guardar();
  return { x, parou, fim, env };
}
const mensagensNoTopico = (c: Cenario, t: TrustedTopic) => c.rede.topicos.get(t.topicId)!.mensagens.length;

// ---------------- casos ----------------
await caso('H01-criar-topico-feliz', async c => {
  const x = await criarTopico(c);
  const d = ler(x.ctx.diario);
  exigir(d.intencoes.length === 1 && d.intencoes[0].situacao === 'confirmada', 'criação confirmada');
  exigir(c.rede.topicos.size === 1, 'um tópico');
  c.rede.agora += 10_000;
  const y = c.novaExecucao();
  const r = await preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null });
  exigir(r.codigo === 'topico_criado_registre_por_revisao' && r.novas === 0, 'segunda execução não cria outro');
  return `topico ${[...c.rede.topicos.keys()][0]}; segunda execução: ${r.codigo}`;
});

await caso('H02-criacao-resposta-perdida', async c => {
  await criarTopico(c, ['perde_resposta']);
  exigir(c.rede.topicos.size === 1, 'rede criou');
  c.rede.agora += 1_000; // mirror ainda atrasado
  const y = c.novaExecucao();
  const r = await preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null });
  exigir(r.codigo === 'topico_criado_registre_por_revisao', 'resolvida pelo mirror');
  exigir(c.rede.topicos.size === 1 && c.rede.execucoes === 1, 'sem segunda criação');
  return 'desconhecida -> confirmada pelo mirror; 1 tópico';
});

await caso('H03-criacao-nunca-transmitida', async c => {
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null });
  x.guardar(); // o runner some depois de guardar, antes de transmitir
  c.rede.agora += 5_000;
  const y = c.novaExecucao();
  const r = await preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null });
  const d = ler(y.ctx.diario);
  exigir(
    d.intencoes.length === 2 && d.intencoes[0].situacao === 'expirada' && d.intencoes[1].situacao === 'reservada',
    'antiga expirada, nova reservada',
  );
  exigir(r.novas === 1 && c.rede.agora >= validaAte(d.intencoes[0].transactionId), 'esperou a validade');
  exigir(d.intencoes[0].transactionId !== d.intencoes[1].transactionId, 'id novo');
  return 'reservada sem envio -> expirada depois da validade; nova intenção com id novo';
});

await caso('H04-conta-ja-criou-topico-fora-do-diario', async c => {
  c.rede.criacoesExternas.push({
    topicId: '0.0.6999',
    txMirror: `${OPERADOR}-1790000000-000000000`,
    em: c.rede.agora - 60_000,
  });
  const x = c.novaExecucao();
  await falhaCom(preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'conta_ja_criou_topico');
  exigir(c.rede.execucoes === 0 && !existsSync(x.ctx.diario), 'nada reservado');
  return 'parou antes de reservar';
});

await caso('H05-topico-ja-registrado', async c => {
  const x = c.novaExecucao();
  await falhaCom(
    preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: { topicId: '0.0.7000', submitKey: PUBLICA } }),
    'topico_ja_registrado',
  );
  return 'parou';
});

await caso('H06-publicar-feliz', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const { parou, fim } = await publicar(c, t);
  exigir(!parou && fim === 'trilha_consistente', `fim ${parou || fim}`);
  exigir(mensagensNoTopico(c, t) === 11, 'onze mensagens');
  c.rede.agora += 10_000;
  const y = c.novaExecucao();
  const r = await preparar(y.ctx, y.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t });
  exigir(r.codigo === 'nada_a_enviar' && r.novas === 0, 'nova execução não envia nada');
  return '11 mensagens em 2 lotes (6 + 5); consistente; nova execução: nada_a_enviar';
});

await caso('H07-mensagem-resposta-perdida-no-meio', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const a = await publicar(c, t, ['normal', 'normal', 'perde_resposta']);
  exigir(a.parou === 'desconhecida', 'parou no desconhecido');
  exigir(mensagensNoTopico(c, t) === 3, 'três entraram (a terceira sem resposta)');
  c.rede.agora += 10_000;
  const b = await publicar(c, t);
  exigir(b.fim === 'trilha_consistente', `fim ${b.fim}`);
  exigir(mensagensNoTopico(c, t) === 11, `sem duplicata: ${mensagensNoTopico(c, t)}`);
  return 'terceira confirmada pelo mirror, sem reenvio; 11 mensagens, 0 duplicatas';
});

await caso('H08-mirror-atrasado-depois-do-recibo', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  c.rede.atrasoMirror = 90_000; // o recibo confirma, mas a lista de mensagens do mirror demora
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t });
  x.guardar();
  await transmitir(x.ctx, x.deps, enviadorFalso(c.rede));
  const r = await preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t });
  x.guardar();
  exigir(r.novas === 5, `só as 5 que faltam, não as 6 já confirmadas por recibo: ${r.novas}`);
  exigir(mensagensNoTopico(c, t) === 6, 'nenhuma repetida');
  return 'confirmadas por recibo não voltam à fila enquanto o mirror atrasa';
});

await caso('H09-validade-insuficiente-nao-envia', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t });
  x.guardar();
  c.rede.agora += 95_000; // guardar demorou: faltam menos de 30 s de validade
  const r = await transmitir(x.ctx, x.deps, enviadorFalso(c.rede));
  exigir(r.codigo === 'validade_insuficiente' && r.enviadas === 0 && mensagensNoTopico(c, t) === 0, 'nada saiu');
  x.guardar();
  c.rede.agora += 10_000;
  const b = await publicar(c, t);
  exigir(b.fim === 'trilha_consistente' && mensagensNoTopico(c, t) === 11, 'retomada completa');
  return 'não enviou com a validade no fim; retomada expirou as 6 e publicou 11';
});

await caso('H10-envio-lento-expira-na-rede', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const a = await publicar(c, t, ['normal', 'lenta']);
  exigir(a.parou === 'desconhecida' && mensagensNoTopico(c, t) === 1, 'segunda expirou na rede');
  c.rede.agora += 10_000;
  const b = await publicar(c, t);
  exigir(b.fim === 'trilha_consistente' && mensagensNoTopico(c, t) === 11, 'retomada completa');
  return 'TRANSACTION_EXPIRED vira desconhecida; mirror resolve como expirada; 11 mensagens';
});

await caso('H11-recibo-de-falha', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const a = await publicar(c, t, ['assinatura_errada']);
  exigir(a.parou === 'falhou', 'parou em falhou');
  const d = ler(a.x.ctx.diario);
  const f = d.intencoes.find((i: Intencao) => i.situacao === 'falhou');
  exigir(f && f.status === 'INVALID_SIGNATURE', 'status da lista fechada');
  c.rede.agora += 10_000;
  const b = await publicar(c, t);
  exigir(b.fim === 'trilha_consistente' && mensagensNoTopico(c, t) === 11, 'retomada completa');
  return 'falha com recibo não é reenviada com o mesmo id; nova execução usa id novo';
});

await caso('H12-chave-do-segredo-diferente', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t });
  x.guardar();
  const outra: HcsKey = {
    type: 'ECDSA_SECP256K1',
    key: PrivateKey.generateECDSA().publicKey.toStringRaw().toLowerCase(),
  };
  const env = enviadorFalso(c.rede, [], outra);
  await falhaCom(transmitir(x.ctx, x.deps, env), 'chave_do_segredo_difere_do_diario');
  exigir(env.chamadas === 0 && mensagensNoTopico(c, t) === 0, 'nada enviado');
  return 'parou antes de enviar';
});

await caso('H13-topico-com-outra-chave', async c => {
  const x = c.novaExecucao();
  const t: TrustedTopic = { topicId: '0.0.7000', submitKey: { type: 'ECDSA_SECP256K1', key: '02' + '1'.repeat(64) } };
  await falhaCom(
    preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t }),
    'chave_da_conta_difere_do_topico',
  );
  return 'parou';
});

await caso('H14-diario-contraditorio', async c => {
  const x = await criarTopico(c);
  const d = ler(x.ctx.diario);
  const alterado = {
    ...d,
    execucao: '999999',
    intencoes: [{ ...d.intencoes[0], situacao: 'expirada', resultado: undefined }],
  };
  delete alterado.intencoes[0].resultado;
  const pasta = path.join(c.anteriores, '999999', 'hcs-diario-01');
  mkdirSync(pasta, { recursive: true });
  writeFileSync(path.join(pasta, 'hcs-diario.json'), JSON.stringify(alterado));
  const y = c.novaExecucao();
  await falhaCom(preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'diario_contraditorio');
  return 'confirmada x expirada para o mesmo id: parou';
});

await caso('H15-diario-com-campo-extra-ou-chave', async c => {
  const x = await criarTopico(c);
  const d = ler(x.ctx.diario);
  d.execucao = '888888';
  d.intencoes[0].bruta = '0x' + 'ab'.repeat(40);
  const pasta = path.join(c.anteriores, '888888', 'hcs-diario-01');
  mkdirSync(pasta, { recursive: true });
  writeFileSync(path.join(pasta, 'hcs-diario.json'), JSON.stringify(d));
  const y = c.novaExecucao();
  await falhaCom(preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'diario_invalido');
  return 'campo fora do formato: parou';
});

await caso('H16-trilha-divergente', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  const v = verificados.get('1') as Extract<NetworkResult, { status: 'verified' }>;
  const texto = JSON.stringify({
    v: 1,
    domain: 'DeliverProof.hcs.v1',
    chainId: 296,
    contract: implantacao.address.toLowerCase(),
    agreementId: '1',
    event: 'Funded',
    tx: v.milestones[0]!.hash.toLowerCase(),
    logIndex: v.milestones[0]!.logIndex,
    block: v.milestones[0]!.block.toString(),
  });
  c.rede.topicos
    .get(t.topicId)!
    .mensagens.push({ sequence: 1, consenso: c.rede.agora - 60_000, bytes: new TextEncoder().encode(texto) });
  c.rede.agora += 10_000;
  const x = c.novaExecucao();
  await falhaCom(preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t }), 'hcs_hcs_event_mismatch');
  return 'mensagem divergente no tópico: parou sem reservar';
});

await caso('H17-acordo-nao-verificado', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const x = c.novaExecucao();
  await falhaCom(
    preparar(x.ctx, x.deps, { acao: 'publicar', acordos: [1n, 4n], topico: t }),
    'acordo_nao_verificado_agreement_not_found',
  );
  return 'parou';
});

await caso('H18-mirror-sem-desfecho-para', async c => {
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null });
  x.guardar();
  c.rede.atrasoMirror = 3_600_000; // mirror parado: não dá para provar expiração
  const y = c.novaExecucao();
  await falhaCom(
    preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'intencao_aberta_sem_desfecho',
  );
  return 'sem mirror em dia, não declara expirada e não cria outra';
});

await caso('H19-limite-16-por-execucao', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const acordos = [1n, 2n, 3n]; // 6 + 5 + 7 = 18 mensagens
  const x = c.novaExecucao();
  const lotes: number[] = [];
  for (let k = 0; k < 4; k++) {
    const r = await preparar(x.ctx, x.deps, { acao: 'publicar', acordos, topico: t });
    x.guardar();
    lotes.push(r.novas);
    await transmitir(x.ctx, x.deps, enviadorFalso(c.rede));
  }
  exigir(lotes.join('+') === '6+6+4+0' && mensagensNoTopico(c, t) === 16, `lotes ${lotes.join('+')}`);
  c.rede.agora += 10_000;
  const y = c.novaExecucao();
  const r = await preparar(y.ctx, y.deps, { acao: 'publicar', acordos, topico: t });
  exigir(r.novas === 2, `próxima execução com as 2 que faltam: ${r.novas}`);
  return '18 pendentes: 6 + 6 + 4 nesta execução (limite 16), as 2 restantes na seguinte';
});

// Teste offline do montador real: id e validade fixados, sem regenerar id, sem rede, sem gravar bytes.
await caso('H20-montar-sdk-offline', async () => {
  const client = Client.forTestnet();
  const i: Intencao = {
    transactionId: `${OPERADOR}@1790000000.000000007`,
    acao: 'mensagem',
    execucao: '1',
    lote: 1,
    chave: PUBLICA,
    topicId: '0.0.7000',
    texto: JSON.stringify({
      v: 1,
      domain: 'DeliverProof.hcs.v1',
      chainId: 296,
      contract: implantacao.address.toLowerCase(),
      agreementId: '1',
      event: 'Created',
      tx: hex(32),
      logIndex: 0,
      block: '10',
    }),
    situacao: 'reservada',
  };
  const tx = montar(i, chavePriv, client);
  exigir(tx.transactionId!.toString() === i.transactionId, 'id do diário');
  exigir(tx.transactionValidDuration === 120, 'validade 120 s');
  exigir(tx.regenerateTransactionId === false, 'não regenera id');
  exigir(tx.isFrozen(), 'congelada');
  const c = { ...i, acao: 'criar_topico' as const, memo: 'DeliverProof.hcs.v1' };
  delete (c as Partial<Intencao>).topicId;
  delete (c as Partial<Intencao>).texto;
  const tc = montar(c, chavePriv, client);
  exigir(tc.transactionId!.toString() === i.transactionId, 'id do diário na criação');
  const env = enviadorSdk(OPERADOR, chaveHex, Client.forTestnet());
  exigir(env.chavePublica().key === PUBLICA.key, 'chave pública derivada');
  env.fechar();
  client.close();
  return 'TransactionId, validade 120 s, regenerate=false e freeze conferidos sem rede';
});

// ---------------- R1: histórico perdido nunca vira primeiro uso ----------------
/** Mirror 30 s atrasado (dentro da regra de 60 s) e a consulta de criações ainda sem a criação de A. */
async function criacaoDeAEAtraso(c: Cenario) {
  const a = await criarTopico(c);
  exigir(c.rede.topicos.size === 1, 'A criou');
  c.rede.atrasoMirror = 30_000;
  c.rede.agora += 10_000; // B dispara 10 s depois
  return a;
}
const semReserva = (c: Cenario, y: { ctx: Contexto }) => {
  exigir(!existsSync(y.ctx.diario), 'B não gravou diário nem reservou');
  exigir(c.rede.topicos.size === 1 && c.rede.execucoes === 1, 'um tópico só, nenhuma transação nova');
};

await caso('H21-R1-listagem-sem-os-diarios-de-A', async c => {
  const a = await criacaoDeAEAtraso(c);
  const y = c.novaExecucao({ baixar: d => rmSync(path.join(d, a.ctx.execucao), { recursive: true }) });
  await falhaCom(
    preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'diario_registrado_ausente',
  );
  semReserva(c, y);
  return 'A registrada pela revisão, listagem sem A, mirror 30 s atrasado: parou antes de reservar; 1 tópico';
});

await caso('H22-R1-zip-presente-sem-o-arquivo', async c => {
  const a = await criacaoDeAEAtraso(c);
  const y = c.novaExecucao({
    baixar: d => rmSync(path.join(d, a.ctx.execucao, 'hcs-diario-02', 'hcs-diario.json')),
  });
  exigir(existsSync(path.join(y.ctx.anteriores, a.ctx.execucao, 'hcs-diario-02')), 'pasta do artefato presente');
  await falhaCom(
    preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'diario_registrado_ausente',
  );
  semReserva(c, y);
  return 'ZIP do último artefato sem hcs-diario.json: parou; 1 tópico';
});

await caso('H23-R1-perda-de-todos-os-artefatos-de-A', async c => {
  const a = await criacaoDeAEAtraso(c);
  // O GitHub perdeu (ou a listagem omitiu) todos os artefatos de A, e a revisão não viu nenhum diário.
  rmSync(path.join(c.anteriores, a.ctx.execucao), { recursive: true });
  const y = c.novaExecucao({ registro: () => ({ versao: 1, operador: OPERADOR, execucoes: [] }) });
  await falhaCom(
    preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'execucao_no_ambiente_sem_registro',
  );
  semReserva(c, y);
  return 'A está no inventário do ambiente e não no registro: parou; bootstrap não é presumido';
});

await caso('H24-R1-execucao-perdida-espera-o-mirror', async c => {
  const a = await criacaoDeAEAtraso(c);
  rmSync(path.join(c.anteriores, a.ctx.execucao), { recursive: true });
  const fimA = c.rede.agora;
  const perdida = (r: Registro1): Registro1 => ({
    ...r,
    execucoes: r.execucoes.map(e =>
      e.id === a.ctx.execucao
        ? { id: e.id, perdida: true, revisao: 'artefatos expirados', encerradaEm: new Date(fimA).toISOString() }
        : e,
    ),
  });
  const y = c.novaExecucao({ registro: perdida });
  await falhaCom(
    preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'mirror_antes_do_fim_da_execucao_perdida',
  );
  semReserva(c, y);
  c.rede.agora += 200_000; // mirror passa do fim de A + validade + margem
  const z = c.novaExecucao({ registro: perdida });
  await falhaCom(preparar(z.ctx, z.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'conta_ja_criou_topico');
  semReserva(c, z);
  return 'perdida revisada: espera o mirror; depois a consulta de criações acha o tópico de A; 1 tópico';
});

await caso('H25-R1-registro-ausente-ou-incoerente', async c => {
  const a = await criacaoDeAEAtraso(c);
  const y = c.novaExecucao({ registro: () => null });
  await falhaCom(preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'registro_hcs_ausente');
  const z = c.novaExecucao({ ambiente: amb => amb.filter(id => id !== a.ctx.execucao) });
  await falhaCom(
    preparar(z.ctx, z.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'execucao_registrada_fora_do_ambiente',
  );
  const w = c.novaExecucao({ registro: r => ({ ...r, execucoes: [...r.execucoes, { id: '500', artefatos: {} }] }) });
  await falhaCom(
    preparar(w.ctx, w.deps, { acao: 'criar-topico', acordos: [], topico: null }),
    'registro_hcs_execucao_sem_diario',
  );
  const v = c.novaExecucao({ registro: r => ({ ...r, extra: 1 }) as Registro1 });
  await falhaCom(preparar(v.ctx, v.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'registro_hcs_invalido');
  exigir(c.rede.topicos.size === 1 && c.rede.execucoes === 1, 'nada novo');
  return 'sem registro, execução fora do ambiente, entrada sem diário, campo extra: todos param';
});

await caso('H26-R1-bootstrap-explicito', async c => {
  const x = c.novaExecucao({ registro: () => ({ versao: 1, operador: OPERADOR, execucoes: [] }) });
  const r = await preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null });
  exigir(r.novas === 1, 'primeiro uso reserva a criação');
  return 'execucoes: [] e ambiente só com as execuções EVM: primeiro uso aceito';
});

// ---------------- R2: evidência negativa só depois do frescor que a justifica ----------------
await caso('H27-R2-leitura-vazia-antes-do-avanco-do-mirror', async c => {
  await criarTopico(c);
  const t = topicoRegistrado(c);
  c.rede.agora += 10_000;
  const a = await publicar(c, t, ['perde_resposta']);
  exigir(a.parou === 'desconhecida' && mensagensNoTopico(c, t) === 1, 'a primeira entrou sem resposta');
  c.rede.agora += 300_000; // muito além da validade
  // Índice do mirror congelado ANTES do registro; só a chamada de frescor faz o índice avançar.
  let indexado = c.rede.agora - 400_000;
  const base = c.rede.mirror();
  const y = c.novaExecucao();
  y.deps.mirror = {
    ...base,
    transacao: async txId =>
      (c.rede.registros.get(txId) ?? []).filter(r => r.em <= indexado).map(({ em: _e, ...r }) => r),
    frescor: async () => (indexado = c.rede.agora - c.rede.atrasoMirror),
  };
  await preparar(y.ctx, y.deps, { acao: 'publicar', acordos: [1n, 2n], topico: t });
  const d = ler(y.ctx.diario);
  const primeira = d.intencoes.find(
    (i: Intencao) => i.transactionId === ler(a.x.ctx.diario).intencoes[1].transactionId,
  );
  exigir(primeira && primeira.situacao === 'confirmada', `confirmada, nunca expirada: ${primeira?.situacao}`);
  const novas = d.intencoes.filter((i: Intencao) => i.execucao === y.ctx.execucao);
  exigir(novas.length > 0 && !novas.some((i: Intencao) => i.texto === primeira.texto), 'o texto confirmado não volta');
  return 'id lido depois do frescor: SUCCESS aceito dentro da validade vira confirmada, sem outra intenção';
});

await caso('H28-R2-frescor-que-volta-atras', async c => {
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null });
  x.guardar();
  c.rede.agora += 300_000;
  const base = c.rede.mirror();
  let n = 0;
  const y = c.novaExecucao();
  y.deps.mirror = { ...base, frescor: async () => c.rede.agora - (n++ === 0 ? 3_000 : 250_000) };
  await falhaCom(preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'mirror_regrediu');
  exigir(c.rede.execucoes === 0 && !existsSync(y.ctx.diario), 'nada novo');
  return 'segunda leitura de frescor menor que a primeira: parou sem declarar expirada';
});

// ---------------- R3: só falha reconhecida da mesma operação encerra a intenção ----------------
/** A reserva uma criação (ou mensagem) e some; o mirror mostra `regs` para o id; B deve parar com `codigo`. */
async function mirrorMostra(c: Cenario, acao: 'criar' | 'mensagem', regs: (id: string) => Registro[], codigo: string) {
  let t: TrustedTopic | null = null;
  if (acao === 'mensagem') {
    await criarTopico(c);
    t = topicoRegistrado(c);
    c.rede.agora += 10_000;
  }
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: acao === 'criar' ? 'criar-topico' : 'publicar', acordos: [1n, 2n], topico: t });
  x.guardar();
  const alvo = ler(x.ctx.diario).intencoes.find((i: Intencao) => i.situacao === 'reservada') as Intencao;
  c.rede.registros.set(
    alvo.transactionId,
    regs(alvo.topicId ?? '').map(r => ({ ...r, em: c.rede.agora })),
  );
  const antes = c.rede.execucoes;
  c.rede.agora += 300_000;
  const y = c.novaExecucao();
  await falhaCom(
    preparar(y.ctx, y.deps, { acao: acao === 'criar' ? 'criar-topico' : 'publicar', acordos: [1n, 2n], topico: t }),
    codigo,
  );
  exigir(!existsSync(y.ctx.diario) && c.rede.execucoes === antes, 'nenhuma intenção nova, nada enviado');
  return codigo;
}
const reg = (result: string, name: string, entityId: string | null): Registro => ({
  result,
  name,
  entityId,
  consenso: '1790000000.000000001',
});
await caso('H29-R3-status-UNKNOWN', async c =>
  mirrorMostra(c, 'criar', () => [reg('UNKNOWN', 'CONSENSUSCREATETOPIC', null)], 'mirror_status_nao_conclusivo'),
);
await caso('H30-R3-status-fora-da-lista', async c =>
  mirrorMostra(
    c,
    'criar',
    () => [reg('SOME_FUTURE_STATUS', 'CONSENSUSCREATETOPIC', null)],
    'mirror_status_nao_conclusivo',
  ),
);
await caso('H31-R3-operacao-diferente', async c =>
  mirrorMostra(
    c,
    'mensagem',
    t => [reg('INVALID_SIGNATURE', 'CRYPTOTRANSFER', t)],
    'mirror_operacao_diferente_do_diario',
  ),
);
await caso('H32-R3-duplicata-sem-original', async c =>
  mirrorMostra(
    c,
    'mensagem',
    t => [reg('DUPLICATE_TRANSACTION', 'CONSENSUSSUBMITMESSAGE', t)],
    'mirror_duplicata_sem_original',
  ),
);
await caso('H33-R3-falha-de-outro-topico', async c =>
  mirrorMostra(
    c,
    'mensagem',
    () => [reg('INVALID_TOPIC_ID', 'CONSENSUSSUBMITMESSAGE', '0.0.9999')],
    'mirror_topico_diferente_do_diario',
  ),
);
await caso('H34-R3-dois-originais', async c =>
  mirrorMostra(
    c,
    'criar',
    () => [
      reg('INVALID_SIGNATURE', 'CONSENSUSCREATETOPIC', null),
      reg('INSUFFICIENT_PAYER_BALANCE', 'CONSENSUSCREATETOPIC', null),
    ],
    'mirror_registros_contraditorios',
  ),
);
await caso('H35-R3-falha-definitiva-valida-e-sucesso', async c => {
  // Falha reconhecida, da mesma operação, com a duplicata junto: falhou, e a execução seguinte usa id novo.
  const x = c.novaExecucao();
  await preparar(x.ctx, x.deps, { acao: 'criar-topico', acordos: [], topico: null });
  x.guardar();
  const alvo = ler(x.ctx.diario).intencoes[0] as Intencao;
  c.rede.registros.set(alvo.transactionId, [
    { ...reg('INSUFFICIENT_PAYER_BALANCE', 'CONSENSUSCREATETOPIC', null), em: c.rede.agora },
    { ...reg('DUPLICATE_TRANSACTION', 'CONSENSUSCREATETOPIC', null), em: c.rede.agora },
  ]);
  c.rede.agora += 10_000;
  const y = c.novaExecucao();
  const r = await preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null });
  const d = ler(y.ctx.diario);
  exigir(d.intencoes[0].situacao === 'falhou' && d.intencoes[0].status === 'INSUFFICIENT_PAYER_BALANCE', 'falhou');
  exigir(r.novas === 1 && d.intencoes[1].transactionId !== alvo.transactionId, 'id novo');
  await transmitir(y.ctx, y.deps, enviadorFalso(c.rede));
  y.guardar();
  c.rede.agora += 10_000;
  const z = c.novaExecucao();
  const r2 = await preparar(z.ctx, z.deps, { acao: 'criar-topico', acordos: [], topico: null });
  exigir(r2.codigo === 'topico_criado_registre_por_revisao' && c.rede.topicos.size === 1, 'SUCCESS aceito');
  return 'INSUFFICIENT_PAYER_BALANCE (+ duplicata) vira falhou; id novo; SUCCESS confirmado; 1 tópico';
});

// ---------------- diário: formato exato também na raiz ----------------
await caso('H36-diario-raiz-com-campo-extra', async c => {
  const x = await criarTopico(c);
  for (const [id, mudar] of [
    ['777771', (d: Record<string, unknown>) => (d.bytesAssinados = '00')],
    ['777772', (d: Record<string, unknown>) => ((d.origem as Record<string, unknown>).extra = 'x')],
    ['777773', (d: Record<string, unknown>) => (d.atualizadoEm = 'ontem')],
  ] as const) {
    const cc = new Cenario(`${c.nome}-${id}`);
    const d = ler(x.ctx.diario);
    d.execucao = id;
    mudar(d);
    const pasta = path.join(cc.anteriores, id, 'hcs-diario-01');
    mkdirSync(pasta, { recursive: true });
    writeFileSync(path.join(pasta, 'hcs-diario.json'), JSON.stringify(d));
    const y = cc.novaExecucao();
    await falhaCom(preparar(y.ctx, y.deps, { acao: 'criar-topico', acordos: [], topico: null }), 'diario_invalido');
    cc.gravarLog();
  }
  return 'campo a mais na raiz, na origem, ou data fora do formato: parou';
});

// ---------------- fim: nenhum arquivo gerado tem o marcador ou a chave ----------------
const chavesProibidas = [MARCADOR, chaveHex.slice(2).toLowerCase(), chaveHex.slice(2).toUpperCase()];
let vazamentos = 0;
const andar = (d: string) => {
  for (const n of readdirSync(d)) {
    const p = path.join(d, n);
    if (statSync(p).isDirectory()) andar(p);
    else {
      const s = readFileSync(p, 'utf8');
      if (chavesProibidas.some(k => s.includes(k))) vazamentos++;
    }
  }
};
andar(saidaDir);
resultados.push({
  caso: 'Z01-sem-marcador-nem-chave-nos-arquivos',
  ok: vazamentos === 0,
  obs: `${vazamentos} arquivo(s) com marcador ou chave`,
});
const ok = resultados.filter(r => r.ok).length;
const resumo = resultados.map(r => `${r.ok ? 'OK  ' : 'FALHA'} ${r.caso}: ${r.obs}`).join('\n');
writeFileSync(path.join(saidaDir, 'RESULTADO.txt'), `${resumo}\n\n${ok}/${resultados.length}\n`);
console.log(resumo + `\n\n${ok}/${resultados.length}`);
void mesclar;
process.exit(ok === resultados.length ? 0 : 1);
