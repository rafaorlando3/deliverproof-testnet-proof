// Lógica do runner HCS, sem rede própria: tudo o que lê a rede entra por `Deps` (mirror, leitor do tópico,
// verificação do acordo) e o envio por `Enviador`. O CLI (operacao/hcs.ts) liga a rede real; o ensaio liga falsos.
//   preparar  (sem chave): resolve pelo mirror toda intenção aberta, decide o que falta e fixa as novas
//             intenções (id da transação incluso) no diário. Não transmite.
//   transmitir (com a chave): envia só as intenções reservadas do último lote desta execução, na ordem,
//             com o id do diário, e grava o desfecho de cada uma. Não reenvia.
//   concluir  (sem chave): resolve as abertas e confere a trilha no mirror, com releituras.
import { existsSync } from 'node:fs';
import {
  hcsPending,
  parseHcsMessage,
  validKey,
  validTopicId,
  verifyHcsTrail,
  type HcsKey,
  type HcsResult,
  type TopicReader,
  type TrustedTopic,
} from '../../packages/core/src/hcs.ts';
import { TOPIC_MEMO, hederaStatus } from '../../packages/core/src/hcs-publish.ts';
import type { NetworkResult, TrustedDeployment } from '../../packages/core/src/network.ts';
// @ts-expect-error módulo .mjs sem tipos
import { Falha } from './rede.mjs';
// @ts-expect-error módulo .mjs sem tipos
import { gravar, ler } from './estado.mjs';
import {
  AMBIGUOS,
  EXECUCAO_MAX,
  LOTE_MAX,
  MARGEM_ENVIO_MS,
  MARGEM_MIRROR_MS,
  VALIDADE_S,
  idTransacao,
  lerAnteriores,
  mesclar,
  terminal,
  validaAte,
  validarDiario,
  type Diario,
  type Intencao,
} from './hcs-diario.ts';
import type { MirrorHcs, Registro } from './hcs-mirror.ts';
import { conferirHistorico, idsEvm, lerAmbiente, lerRegistroHcs } from './hcs-registro.ts';
import type { Enviador } from './hcs-envio.ts';

export type Deps = {
  agora: () => number;
  dormir: (ms: number) => Promise<void>;
  mirror: MirrorHcs;
  leitor: TopicReader;
  implantacao: TrustedDeployment | null;
  verificar: (id: bigint) => Promise<NetworkResult>;
  saida: (o: Record<string, unknown>) => void;
};
export type Contexto = {
  diario: string;
  anteriores: string;
  /** hcs-registro.json revisado (obrigatório; o bootstrap é `execucoes: []`). */
  registro: string;
  /** operacao-registro.json revisado: execuções EVM do mesmo ambiente. */
  registroEvm: string;
  /** Saída de listar-execucoes-ambiente.sh: inventário independente das execuções do ambiente. */
  ambiente: string;
  operador: string;
  execucao: string;
  origem: { template: string; operacao: string };
};

const NOMES = { criar_topico: 'CONSENSUSCREATETOPIC', mensagem: 'CONSENSUSSUBMITMESSAGE' } as const;
const ESPERA_MAX_MS = 6 * 60_000;
const INTERVALO_MS = 5_000;
const codigo = (x: string) => (/^[a-z0-9_]{1,64}$/.test(x) ? x : 'codigo_desconhecido');
const igual = (a: HcsKey, b: HcsKey) => a.type === b.type && a.key.toLowerCase() === b.key.toLowerCase();

/**
 * Histórico completo ou parada: o registro revisado e o inventário do ambiente dizem quais execuções existiram;
 * cada diário registrado precisa estar presente com o mesmo hash. Só então os diários são juntados.
 */
function carregar(ctx: Contexto): { atual: Diario | null; intencoes: Intencao[]; perdidaAte: number | null } {
  const registro = lerRegistroHcs(ctx.registro, ctx.operador);
  const evm = idsEvm(ctx.registroEvm);
  const ambiente = lerAmbiente(ctx.ambiente);
  const anteriores = lerAnteriores(ctx.anteriores, ctx.operador, ctx.execucao);
  const { perdidaAte } = conferirHistorico(registro, evm, ambiente, ctx.anteriores, anteriores.execucoes, ctx.execucao);
  let atual: Diario | null = null;
  if (existsSync(ctx.diario)) {
    atual = validarDiario(ler(ctx.diario), ctx.operador);
    if (atual.execucao !== ctx.execucao) throw new Falha('diario_de_outra_execucao');
  }
  return { atual, intencoes: mesclar([...anteriores.intencoes, atual?.intencoes ?? []]), perdidaAte };
}

/** Leitura do frescor que nunca volta atrás dentro da mesma execução (mirror inconsistente faz parar). */
function frescorMonotono(deps: Deps) {
  let ultimo = -Infinity;
  return async () => {
    const f = await deps.mirror.frescor();
    if (!Number.isFinite(f) || f < ultimo) throw new Falha('mirror_regrediu');
    ultimo = f;
    return f;
  };
}

type Leitura =
  | { tipo: 'confirmada'; resultado: { topicId?: string; consenso: string } }
  | { tipo: 'falhou'; status: string }
  | { tipo: 'nenhum' };

/**
 * O que os registros do mirror provam sobre ESTA intenção. Só dois desfechos terminais:
 *   - um único registro original (fora DUPLICATE_TRANSACTION) com SUCCESS, a operação e o tópico do diário;
 *   - um único registro original com status de falha reconhecido, não ambíguo, da mesma operação (e, na
 *     mensagem, do mesmo tópico quando o mirror informa).
 * Qualquer outra coisa (status desconhecido ou ambíguo, operação ou tópico diferente, mais de um original,
 * só duplicatas) faz parar: a intenção fica aberta no diário e nada novo é reservado em cima dela.
 */
function lerRegistros(i: Intencao, regs: Registro[]): Leitura {
  if (!regs.length) return { tipo: 'nenhum' };
  const originais = regs.filter(r => r.result !== 'DUPLICATE_TRANSACTION');
  if (!originais.length) throw new Falha('mirror_duplicata_sem_original');
  if (originais.length > 1) throw new Falha('mirror_registros_contraditorios');
  const r = originais[0]!;
  if (r.name !== NOMES[i.acao]) throw new Falha('mirror_operacao_diferente_do_diario');
  if (r.result === 'SUCCESS') {
    if (i.acao === 'mensagem' && r.entityId !== i.topicId) throw new Falha('mirror_topico_diferente_do_diario');
    if (i.acao === 'criar_topico' && !validTopicId(r.entityId)) throw new Falha('mirror_resposta_invalida');
    return {
      tipo: 'confirmada',
      resultado: { ...(i.acao === 'criar_topico' ? { topicId: r.entityId! } : {}), consenso: r.consenso },
    };
  }
  if (i.acao === 'mensagem' && r.entityId !== null && r.entityId !== i.topicId)
    throw new Falha('mirror_topico_diferente_do_diario');
  const status = hederaStatus(r.result);
  if (status === undefined || AMBIGUOS.has(status)) throw new Falha('mirror_status_nao_conclusivo');
  return { tipo: 'falhou', status };
}

function salvar(ctx: Contexto, deps: Deps, intencoes: Intencao[]) {
  const d: Diario = {
    v: 1,
    tipo: 'deliverproof-hcs-diario',
    origem: ctx.origem,
    operador: ctx.operador,
    execucao: ctx.execucao,
    atualizadoEm: new Date(deps.agora()).toISOString(),
    intencoes,
  };
  gravar(ctx.diario, d);
}

/**
 * Resolve pelo mirror cada intenção aberta (reservada ou desconhecida), qualquer que seja a execução:
 *   - registro original SUCCESS com a operação certa: confirmada (criação: o topicId vem do registro);
 *   - registro original de falha reconhecida e não ambígua, da mesma operação: falhou, com o status;
 *   - "expirada" só com evidência negativa POSTERIOR ao frescor que a justifica: primeiro o frescor (além da
 *     validade + margem), depois a leitura do id; e de novo, frescor e id, depois de um intervalo. Uma leitura
 *     vazia anterior ao avanço do mirror nunca conta. Assume-se o que o mirror promete: o que tem consenso até o
 *     instante já ingerido aparece nas leituras seguintes. Frescor que volta atrás faz parar;
 *   - sem desfecho dentro da janela: espera; passou do limite, para. Status desconhecido, ambíguo ou de outra
 *     operação faz parar (lerRegistros).
 */
export async function reconciliar(intencoes: Intencao[], deps: Deps): Promise<Intencao[]> {
  const limite = deps.agora() + ESPERA_MAX_MS;
  const frescor = frescorMonotono(deps);
  const out: Intencao[] = [];
  const aplicar = (i: Intencao, l: Exclude<Leitura, { tipo: 'nenhum' }>) => {
    if (l.tipo === 'confirmada') {
      const nova: Intencao = { ...i, situacao: 'confirmada', resultado: l.resultado };
      delete nova.status;
      out.push(nova);
      deps.saida({ etapa: 'hcs_resolvida', transactionId: i.transactionId, situacao: 'confirmada', ...l.resultado });
    } else {
      out.push({ ...i, situacao: 'falhou', status: l.status });
      deps.saida({ etapa: 'hcs_resolvida', transactionId: i.transactionId, situacao: 'falhou', status: l.status });
    }
  };
  for (const i of intencoes) {
    if (terminal(i.situacao)) {
      out.push(i);
      continue;
    }
    const corte = validaAte(i.transactionId) + MARGEM_MIRROR_MS;
    for (;;) {
      const f1 = await frescor();
      const l1 = lerRegistros(i, await deps.mirror.transacao(i.transactionId));
      if (l1.tipo !== 'nenhum') {
        aplicar(i, l1);
        break;
      }
      if (f1 > corte) {
        await deps.dormir(INTERVALO_MS);
        const f2 = await frescor();
        const l2 = lerRegistros(i, await deps.mirror.transacao(i.transactionId));
        if (l2.tipo !== 'nenhum') {
          aplicar(i, l2);
          break;
        }
        if (f2 > corte) {
          out.push({ ...i, situacao: 'expirada' });
          deps.saida({ etapa: 'hcs_resolvida', transactionId: i.transactionId, situacao: 'expirada' });
          break;
        }
      }
      if (deps.agora() > limite) throw new Falha('intencao_aberta_sem_desfecho');
      await deps.dormir(INTERVALO_MS);
    }
  }
  return out;
}

async function chaveConferida(deps: Deps, operador: string): Promise<HcsKey> {
  const k = await deps.mirror.chaveDaConta(operador);
  if (!validKey(k)) throw new Falha('chave_da_conta_nao_suportada');
  return k;
}

async function trilhas(deps: Deps, topico: TrustedTopic, acordos: bigint[]) {
  if (!deps.implantacao) throw new Falha('implantacao_ausente');
  const out: { id: bigint; verified: NetworkResult; check: HcsResult }[] = [];
  for (const id of acordos) {
    const verified = await deps.verificar(id);
    if (verified.status !== 'verified') throw new Falha(`acordo_nao_verificado_${codigo(verified.code)}`);
    const check = await verifyHcsTrail(deps.implantacao, id, verified, topico, deps.leitor);
    out.push({ id, verified, check });
  }
  return out;
}

export async function preparar(
  ctx: Contexto,
  deps: Deps,
  opcoes: { acao: 'criar-topico' | 'publicar'; acordos: bigint[]; topico: TrustedTopic | null },
): Promise<{ codigo: string; novas: number }> {
  const { atual, intencoes: todas, perdidaAte } = carregar(ctx);
  const intencoes = await reconciliar(todas, deps);
  // Execução perdida (revisada): nada novo até o mirror passar do fim dela + validade + margem. Assim toda
  // transação que ela possa ter enviado já aparece na consulta de criações e na leitura do tópico.
  if (perdidaAte !== null && (await deps.mirror.frescor()) <= perdidaAte + VALIDADE_S * 1000 + MARGEM_MIRROR_MS) {
    deps.saida({ etapa: 'parada', codigo: 'mirror_antes_do_fim_da_execucao_perdida' });
    throw new Falha('mirror_antes_do_fim_da_execucao_perdida');
  }
  const lote = Math.max(0, ...intencoes.filter(i => i.execucao === ctx.execucao).map(i => i.lote)) + 1;
  if (lote > 99) throw new Falha('lotes_demais');
  const chave = await chaveConferida(deps, ctx.operador);
  const novas: Intencao[] = [];
  let resultado = 'reservadas';

  if (opcoes.acao === 'criar-topico') {
    if (opcoes.topico) throw new Falha('topico_ja_registrado');
    const criada = intencoes.find(i => i.acao === 'criar_topico' && i.situacao === 'confirmada');
    if (criada) {
      deps.saida({
        etapa: 'hcs_topico_criado',
        registrar: { topicId: criada.resultado!.topicId, submitKey: criada.chave, criacao: criada.transactionId },
      });
      resultado = 'topico_criado_registre_por_revisao';
    } else {
      // O mirror precisa estar em dia para "nenhum tópico desta conta" valer: frescor ANTES da consulta, e o
      // frescor não pode voltar atrás depois dela.
      const f1 = await deps.mirror.frescor();
      if (f1 < deps.agora() - 60_000) throw new Falha('mirror_atrasado');
      const criados = await deps.mirror.topicosCriados(ctx.operador);
      if ((await deps.mirror.frescor()) < f1) throw new Falha('mirror_regrediu');
      if (criados.length) {
        deps.saida({ etapa: 'parada', codigo: 'conta_ja_criou_topico', topicos: criados.map(c => c.topicId) });
        throw new Falha('conta_ja_criou_topico');
      }
      novas.push({
        transactionId: idTransacao(ctx.operador, deps.agora(), 0),
        acao: 'criar_topico',
        execucao: ctx.execucao,
        lote,
        chave,
        memo: TOPIC_MEMO,
        situacao: 'reservada',
      });
    }
  } else {
    const topico = opcoes.topico;
    if (!topico || !validTopicId(topico.topicId) || !validKey(topico.submitKey))
      throw new Falha('topico_nao_registrado');
    if (!igual(topico.submitKey, chave)) throw new Falha('chave_da_conta_difere_do_topico');
    if (!opcoes.acordos.length || opcoes.acordos.length > 4) throw new Falha('acordos_invalidos');
    // Confirmada por recibo ou pelo mirror, ainda que a lista de mensagens do mirror esteja atrasada: não repete.
    const feitos = new Set(
      intencoes
        .filter(i => i.acao === 'mensagem' && i.situacao === 'confirmada' && i.topicId === topico.topicId)
        .map(i => i.texto),
    );
    const faltam: string[] = [];
    for (const t of await trilhas(deps, topico, opcoes.acordos)) {
      if (t.check.status === 'mismatch' || t.check.status === 'inconclusive')
        throw new Falha(`hcs_${codigo(t.check.code)}`);
      for (const texto of hcsPending(deps.implantacao!, t.id, t.verified, t.check))
        if (!feitos.has(texto)) faltam.push(texto);
    }
    const nestaExecucao = intencoes.filter(i => i.execucao === ctx.execucao && i.acao === 'mensagem').length;
    const cabe = Math.max(0, Math.min(LOTE_MAX, EXECUCAO_MAX - nestaExecucao));
    faltam.slice(0, cabe).forEach((texto, n) => {
      if (parseHcsMessage(new TextEncoder().encode(texto)) === null) throw new Falha('texto_nao_canonico');
      novas.push({
        transactionId: idTransacao(ctx.operador, deps.agora(), n),
        acao: 'mensagem',
        execucao: ctx.execucao,
        lote,
        chave,
        topicId: topico.topicId,
        texto,
        situacao: 'reservada',
      });
    });
    if (!faltam.length) resultado = 'nada_a_enviar';
    else if (!novas.length) resultado = 'limite_da_execucao';
  }
  const final = mesclar([intencoes, novas]);
  salvar(ctx, deps, final);
  for (const n of novas)
    deps.saida({ etapa: 'hcs_reservada', transactionId: n.transactionId, acao: n.acao, lote: n.lote });
  deps.saida({
    etapa: 'hcs_preparada',
    codigo: resultado,
    novas: novas.length,
    anterior: atual ? 'mesma_execucao' : 'novo',
  });
  return { codigo: resultado, novas: novas.length };
}

export async function transmitir(
  ctx: Contexto,
  deps: Pick<Deps, 'agora' | 'saida'>,
  enviador: Enviador,
): Promise<{
  codigo: 'enviadas' | 'nada_a_enviar' | 'desconhecida' | 'falhou' | 'validade_insuficiente';
  enviadas: number;
}> {
  if (!existsSync(ctx.diario)) throw new Falha('diario_ausente');
  const d = validarDiario(ler(ctx.diario), ctx.operador);
  if (d.execucao !== ctx.execucao) throw new Falha('diario_de_outra_execucao');
  const meus = d.intencoes.filter(i => i.execucao === ctx.execucao);
  const lote = Math.max(0, ...meus.map(i => i.lote));
  const fila = meus.filter(i => i.lote === lote && i.situacao === 'reservada');
  if (!fila.length) {
    deps.saida({ etapa: 'hcs_transmitir', codigo: 'nada_a_enviar' });
    return { codigo: 'nada_a_enviar', enviadas: 0 };
  }
  const publica = enviador.chavePublica();
  if (fila.some(i => !igual(i.chave, publica))) throw new Falha('chave_do_segredo_difere_do_diario');
  let enviadas = 0;
  for (const i of fila) {
    if (deps.agora() > validaAte(i.transactionId) - MARGEM_ENVIO_MS) {
      // Não sai: a próxima preparação vê o id sem registro, com a validade vencida, e o declara expirado.
      deps.saida({ etapa: 'hcs_nao_enviada', transactionId: i.transactionId, codigo: 'validade_insuficiente' });
      return { codigo: 'validade_insuficiente', enviadas };
    }
    const r = await enviador.enviar(i);
    const idx = d.intencoes.findIndex(x => x.transactionId === i.transactionId);
    const nova: Intencao = { ...i, situacao: r.situacao };
    if (r.situacao === 'confirmada' && r.resultado.topicId) nova.resultado = { topicId: r.resultado.topicId };
    if (r.situacao === 'falhou' && r.status) nova.status = r.status;
    d.intencoes[idx] = nova;
    d.atualizadoEm = new Date(deps.agora()).toISOString();
    gravar(ctx.diario, d);
    deps.saida({
      etapa: 'hcs_enviada',
      transactionId: i.transactionId,
      situacao: r.situacao,
      ...(nova.resultado?.topicId ? { topicId: nova.resultado.topicId } : {}),
      ...(nova.status ? { status: nova.status } : {}),
    });
    if (r.situacao !== 'confirmada') return { codigo: r.situacao, enviadas };
    enviadas++;
  }
  return { codigo: 'enviadas', enviadas };
}

/** Sem chave: resolve as abertas e relê a trilha até ficar consistente (ou o limite de releituras). */
export async function concluir(
  ctx: Contexto,
  deps: Deps,
  opcoes: { acordos: bigint[]; topico: TrustedTopic | null; releituras?: number; esperaMs?: number },
): Promise<{ codigo: string }> {
  const { intencoes: todas } = carregar(ctx);
  const intencoes = await reconciliar(todas, deps);
  salvar(ctx, deps, intencoes);
  if (!opcoes.topico) {
    deps.saida({ etapa: 'hcs_concluida', codigo: 'sem_topico_registrado' });
    return { codigo: 'sem_topico_registrado' };
  }
  const n = opcoes.releituras ?? 8;
  for (let k = 0; k < n; k++) {
    const ts = await trilhas(deps, opcoes.topico, opcoes.acordos);
    const ruim = ts.find(t => t.check.status === 'mismatch');
    if (ruim) throw new Falha(`hcs_${codigo((ruim.check as { code: string }).code)}`);
    if (ts.every(t => t.check.status === 'consistent')) {
      for (const t of ts)
        if (t.check.status === 'consistent')
          deps.saida({
            etapa: 'hcs_trilha',
            acordo: t.id.toString(),
            topicId: opcoes.topico.topicId,
            mensagens: t.check.matched.map(m => ({
              evento: m.event,
              sequencia: m.sequence,
              consenso: m.consensusTimestamp,
            })),
            duplicatas: t.check.duplicates,
          });
      deps.saida({ etapa: 'hcs_concluida', codigo: 'trilha_consistente' });
      return { codigo: 'trilha_consistente' };
    }
    await deps.dormir(opcoes.esperaMs ?? 5_000);
  }
  deps.saida({ etapa: 'hcs_concluida', codigo: 'trilha_incompleta' });
  return { codigo: 'trilha_incompleta' };
}
