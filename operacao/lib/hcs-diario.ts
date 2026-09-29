// Diário público da trilha HCS. Cada intenção tem o id da transação Hedera (conta pagadora + validStart)
// fixado ANTES de transmitir, e sobe como artefato antes do envio. Nada de chave nem de bytes assinados aqui:
// só a conta pagadora, o validStart, a ação, a chave PÚBLICA esperada e o texto canônico público.
// O mesmo id nunca executa duas vezes na rede (deduplicação) e deixa de ser aceito quando a validade acaba,
// por isso uma intenção sem registro no mirror, com a validade vencida e o mirror já adiante dela, nunca entra.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { parseHcsMessage, validKey, validTopicId, type HcsKey } from '../../packages/core/src/hcs.ts';
import { hederaStatus, validTransactionId, TOPIC_MEMO } from '../../packages/core/src/hcs-publish.ts';
// @ts-expect-error módulo .mjs sem tipos
import { Falha } from './rede.mjs';
// @ts-expect-error módulo .mjs sem tipos
import { ler } from './estado.mjs';

export const VALIDADE_S = 120; // setTransactionValidDuration de cada transação
export const RECUO_MS = 10_000; // validStart = agora - 10 s: a rede recusa início no futuro
export const MARGEM_ENVIO_MS = 30_000; // só transmite se faltar pelo menos isso para a validade acabar
export const MARGEM_MIRROR_MS = 30_000; // "expirada" só com o mirror ingerido além da validade + margem
export const LOTE_MAX = 6; // intenções por preparação (cabem com folga na validade)
export const EXECUCAO_MAX = 16; // mensagens por execução, como MAX_PUBLISH_PER_RUN do template
export const ARQUIVO = 'hcs-diario.json';

// Status que não provam o desfecho do id, no recibo e no mirror: o resultado ainda não existe, é de outra cópia do
// mesmo id, ou a rede não decidiu. Nunca viram "falhou"; no mirror, fazem parar para revisão.
export const AMBIGUOS: ReadonlySet<string> = new Set([
  'BUSY',
  'UNKNOWN',
  'RECEIPT_NOT_FOUND',
  'DUPLICATE_TRANSACTION',
  'TRANSACTION_EXPIRED',
  'PLATFORM_NOT_ACTIVE',
  'PLATFORM_TRANSACTION_NOT_CREATED',
]);

export type Situacao = 'reservada' | 'desconhecida' | 'confirmada' | 'falhou' | 'expirada';
const SITUACOES: readonly Situacao[] = ['reservada', 'desconhecida', 'confirmada', 'falhou', 'expirada'];
const TERMINAIS: readonly Situacao[] = ['confirmada', 'falhou', 'expirada'];
export const terminal = (s: Situacao) => TERMINAIS.includes(s);

export type Intencao = {
  transactionId: string;
  acao: 'criar_topico' | 'mensagem';
  execucao: string;
  lote: number;
  chave: HcsKey;
  memo?: string;
  topicId?: string;
  texto?: string;
  situacao: Situacao;
  status?: string;
  resultado?: { topicId?: string; consenso?: string };
};
export type Diario = {
  v: 1;
  tipo: 'deliverproof-hcs-diario';
  origem: { template: string; operacao: string };
  operador: string;
  execucao: string;
  atualizadoEm: string;
  intencoes: Intencao[];
};

const CONTA = /^0\.0\.[1-9][0-9]{0,15}$/;
const EXECUCAO = /^(local-[0-9a-z-]{1,40}|[0-9]{1,20})$/;
const CONSENSO = /^[0-9]{1,12}\.[0-9]{9}$/;
export const contaValida = (x: unknown): x is string => typeof x === 'string' && CONTA.test(x);

/** Id com validStart = agora - RECUO; `i` separa as intenções do mesmo lote por nanossegundo. */
export function idTransacao(operador: string, agoraMs: number, i: number): string {
  if (!contaValida(operador)) throw new Falha('operador_invalido');
  if (!Number.isSafeInteger(i) || i < 0 || i >= 1000) throw new Falha('indice_invalido');
  const inicio = Math.floor(agoraMs) - RECUO_MS;
  const s = Math.floor(inicio / 1000);
  const ns = (inicio % 1000) * 1_000_000 + i;
  return `${operador}@${s}.${String(ns).padStart(9, '0')}`;
}

export function partes(txId: string): { conta: string; s: number; ns: number } {
  if (!validTransactionId(txId)) throw new Falha('transaction_id_invalido');
  const [conta, inicio] = txId.split('@') as [string, string];
  const [s, ns] = inicio.split('.') as [string, string];
  return { conta, s: Number(s), ns: Number(ns.padEnd(9, '0')) };
}

/** Fim da validade, em ms (o nanossegundo não muda nada nesta escala). */
export function validaAte(txId: string): number {
  const { s, ns } = partes(txId);
  return s * 1000 + Math.floor(ns / 1_000_000) + VALIDADE_S * 1000;
}

/** Formato do mirror: 0.0.N-segundos-nanossegundos (9 dígitos). */
export function paraMirror(txId: string): string {
  const { conta, s, ns } = partes(txId);
  return `${conta}-${s}-${String(ns).padStart(9, '0')}`;
}

function chaveIgual(a: HcsKey, b: HcsKey) {
  return a.type === b.type && a.key.toLowerCase() === b.key.toLowerCase();
}

/** Aceita só o formato exato; qualquer campo a mais, a menos ou fora do padrão faz parar. */
export function validarIntencao(x: unknown, operador: string): Intencao {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Falha('diario_invalido');
  const i = x as Record<string, unknown>;
  const permitidos = [
    'transactionId',
    'acao',
    'execucao',
    'lote',
    'chave',
    'memo',
    'topicId',
    'texto',
    'situacao',
    'status',
    'resultado',
  ];
  if (Object.keys(i).some(k => !permitidos.includes(k))) throw new Falha('diario_invalido');
  if (typeof i.transactionId !== 'string' || !validTransactionId(i.transactionId)) throw new Falha('diario_invalido');
  if (partes(i.transactionId).conta !== operador) throw new Falha('diario_de_outra_conta');
  if (typeof i.execucao !== 'string' || !EXECUCAO.test(i.execucao)) throw new Falha('diario_invalido');
  if (!Number.isSafeInteger(i.lote) || (i.lote as number) < 1 || (i.lote as number) > 99)
    throw new Falha('diario_invalido');
  const chave = i.chave as { type?: unknown; key?: unknown } | undefined;
  const copia = { type: chave?.type, key: chave?.key };
  if (!validKey(copia) || Object.keys(chave ?? {}).length !== 2) throw new Falha('diario_invalido');
  if (!SITUACOES.includes(i.situacao as Situacao)) throw new Falha('diario_invalido');
  if (i.status !== undefined && hederaStatus(i.status) === undefined) throw new Falha('diario_invalido');
  if (i.acao === 'criar_topico') {
    if (i.memo !== TOPIC_MEMO || i.texto !== undefined || i.topicId !== undefined) throw new Falha('diario_invalido');
  } else if (i.acao === 'mensagem') {
    if (!validTopicId(i.topicId) || typeof i.texto !== 'string' || i.memo !== undefined)
      throw new Falha('diario_invalido');
    if (parseHcsMessage(new TextEncoder().encode(i.texto)) === null) throw new Falha('diario_texto_nao_canonico');
  } else throw new Falha('diario_invalido');
  let resultado: Intencao['resultado'];
  if (i.resultado !== undefined) {
    const r = i.resultado as Record<string, unknown>;
    if (!r || typeof r !== 'object' || Object.keys(r).some(k => k !== 'topicId' && k !== 'consenso'))
      throw new Falha('diario_invalido');
    if (r.topicId !== undefined && !validTopicId(r.topicId)) throw new Falha('diario_invalido');
    if (r.consenso !== undefined && (typeof r.consenso !== 'string' || !CONSENSO.test(r.consenso)))
      throw new Falha('diario_invalido');
    resultado = {
      ...(r.topicId ? { topicId: r.topicId as string } : {}),
      ...(r.consenso ? { consenso: r.consenso as string } : {}),
    };
  }
  return {
    transactionId: i.transactionId,
    acao: i.acao,
    execucao: i.execucao,
    lote: i.lote as number,
    chave: copia,
    ...(i.acao === 'criar_topico' ? { memo: TOPIC_MEMO } : { topicId: i.topicId as string, texto: i.texto as string }),
    situacao: i.situacao as Situacao,
    ...(i.status !== undefined ? { status: i.status as string } : {}),
    ...(resultado ? { resultado } : {}),
  } as Intencao;
}

const RAIZ = ['v', 'tipo', 'origem', 'operador', 'execucao', 'atualizadoEm', 'intencoes'];
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const SHA = /^[0-9a-f]{40}$/;
const soChaves = (x: object, chaves: string[]) =>
  Object.keys(x).length === chaves.length && Object.keys(x).every(k => chaves.includes(k));

/** Formato exato também na raiz e na origem: campo a mais, a menos ou fora do padrão faz parar. */
export function validarDiario(x: unknown, operador: string): Diario {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Falha('diario_invalido');
  const d = x as Record<string, unknown>;
  if (!soChaves(d, RAIZ)) throw new Falha('diario_invalido');
  if (d.v !== 1 || d.tipo !== 'deliverproof-hcs-diario' || d.operador !== operador) throw new Falha('diario_invalido');
  if (typeof d.execucao !== 'string' || !EXECUCAO.test(d.execucao)) throw new Falha('diario_invalido');
  if (typeof d.atualizadoEm !== 'string' || !ISO.test(d.atualizadoEm)) throw new Falha('diario_invalido');
  if (!Array.isArray(d.intencoes) || d.intencoes.length > 400) throw new Falha('diario_invalido');
  const o = d.origem as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object' || Array.isArray(o) || !soChaves(o, ['template', 'operacao']))
    throw new Falha('diario_invalido');
  if (
    typeof o.template !== 'string' ||
    !SHA.test(o.template) ||
    typeof o.operacao !== 'string' ||
    !SHA.test(o.operacao)
  )
    throw new Falha('diario_invalido');
  return {
    v: 1,
    tipo: 'deliverproof-hcs-diario',
    origem: { template: o.template, operacao: o.operacao },
    operador,
    execucao: d.execucao,
    atualizadoEm: d.atualizadoEm,
    intencoes: d.intencoes.map(i => validarIntencao(i, operador)),
  };
}

/**
 * Junta as intenções de todos os diários pelo id da transação. O mesmo id precisa ter o mesmo conteúdo.
 * Situação: a terminal vence a aberta; duas terminais diferentes (ou resultados diferentes) fazem parar.
 */
export function mesclar(listas: Intencao[][]): Intencao[] {
  const porId = new Map<string, Intencao>();
  for (const lista of listas)
    for (const i of lista) {
      const a = porId.get(i.transactionId);
      if (!a) {
        porId.set(i.transactionId, i);
        continue;
      }
      if (
        a.acao !== i.acao ||
        a.execucao !== i.execucao ||
        a.lote !== i.lote ||
        a.texto !== i.texto ||
        a.topicId !== i.topicId ||
        a.memo !== i.memo ||
        !chaveIgual(a.chave, i.chave)
      )
        throw new Falha('diario_contraditorio');
      if (terminal(a.situacao) && terminal(i.situacao)) {
        if (
          a.situacao !== i.situacao ||
          a.status !== i.status ||
          a.resultado?.topicId !== i.resultado?.topicId ||
          a.resultado?.consenso !== i.resultado?.consenso
        )
          throw new Falha('diario_contraditorio');
      } else if (terminal(i.situacao) || (i.situacao === 'desconhecida' && a.situacao === 'reservada'))
        porId.set(i.transactionId, i);
    }
  return [...porId.values()].sort((x, y) => {
    const a = partes(x.transactionId);
    const b = partes(y.transactionId);
    return a.s - b.s || a.ns - b.ns;
  });
}

/**
 * Diários de execuções anteriores, baixados por baixar-artefatos.sh em DIR/<execução>/<artefato>/.
 * Devolve também as execuções que têm pasta baixada, com ou sem diário dentro, para a conferência contra o
 * registro revisado (lib/hcs-registro.ts): a leitura sozinha nunca decide que o histórico está completo.
 */
export function lerAnteriores(
  dir: string,
  operador: string,
  execucaoAtual: string,
): { intencoes: Intencao[][]; execucoes: string[] } {
  const out: Intencao[][] = [];
  const execucoes = new Set<string>();
  const andar = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) andar(p);
      else if (n === ARQUIVO) {
        const execucao = path.relative(dir, p).split(path.sep)[0];
        const diario = validarDiario(ler(p), operador);
        if (diario.execucao !== execucao || execucao === execucaoAtual) throw new Falha('diario_fora_da_execucao');
        out.push(diario.intencoes);
      }
    }
  };
  if (dir && existsSync(dir)) {
    for (const n of readdirSync(dir))
      if (statSync(path.join(dir, n)).isDirectory()) {
        if (!/^[0-9]{1,20}$/.test(n) && !/^local-[0-9a-z-]{1,40}$/.test(n))
          throw new Falha('pasta_de_anteriores_inesperada');
        execucoes.add(n);
      }
    andar(dir);
  }
  return { intencoes: out, execucoes: [...execucoes].sort() };
}
