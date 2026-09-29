// Leituras do mirror para o runner HCS: só GET, host fixo (testnet) ou 127.0.0.1 no ensaio, sem credenciais,
// sem redirecionamento, prazo e limite de bytes (buscar de lib/rede.mjs). Erros saem só como código.
import { validKey, validTopicId, type HcsKey } from '../../packages/core/src/hcs.ts';
// @ts-expect-error módulo .mjs sem tipos
import { buscar, Falha } from './rede.mjs';
import { paraMirror } from './hcs-diario.ts';

export type Registro = { result: string; name: string; entityId: string | null; consenso: string };
export interface MirrorHcs {
  /** Registros de consenso de um id de transação; [] quando o mirror não conhece o id. */
  transacao(txId: string): Promise<Registro[]>;
  /** Até onde o mirror já ingeriu (ms desde a época), pelo último bloco registrado. */
  frescor(): Promise<number>;
  /** Chave pública única da conta (ED25519 ou ECDSA secp256k1 comprimida). */
  chaveDaConta(conta: string): Promise<HcsKey>;
  /** Tópicos criados com sucesso tendo esta conta como pagadora. */
  topicosCriados(conta: string): Promise<{ topicId: string; txMirror: string }[]>;
}

const TESTNET = 'https://testnet.mirrornode.hedera.com';
const CONSENSO = /^[0-9]{1,12}\.[0-9]{9}$/;
const TXM = /^0\.0\.[1-9][0-9]{0,15}-[0-9]{1,12}-[0-9]{9}$/;
const NOME = /^[A-Z][A-Z0-9_]{0,63}$/;
const LIMITE = 512 * 1024;
const PAGINAS_CRIACOES = 20;

export function mirrorHcs(base: string = TESTNET): MirrorHcs {
  let origem: string;
  try {
    const u = new URL(base);
    const local = u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname);
    if (!local && base !== TESTNET) throw new Error();
    origem = u.origin;
  } catch {
    throw new Falha('mirror_nao_permitido');
  }
  async function get(caminho: string): Promise<Record<string, unknown> | null> {
    const { status, bytes } = await buscar(
      origem + caminho,
      { headers: { accept: 'application/json' }, credentials: 'omit' },
      { prazoMs: 10_000, limiteBytes: LIMITE, codigo: 'mirror' },
    );
    if (status === 404) return null;
    if (status !== 200) throw new Falha('mirror_http', status);
    let x: unknown;
    try {
      x = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Falha('mirror_resposta_invalida');
    }
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Falha('mirror_resposta_invalida');
    return x as Record<string, unknown>;
  }
  const registro = (t: Record<string, unknown>, esperado?: string): Registro => {
    if (
      !t ||
      typeof t.transaction_id !== 'string' ||
      !TXM.test(t.transaction_id) ||
      (esperado !== undefined && t.transaction_id !== esperado) ||
      typeof t.result !== 'string' ||
      !NOME.test(t.result) ||
      typeof t.name !== 'string' ||
      !NOME.test(t.name) ||
      typeof t.consensus_timestamp !== 'string' ||
      !CONSENSO.test(t.consensus_timestamp) ||
      (t.entity_id !== null && t.entity_id !== undefined && !validTopicId(t.entity_id))
    )
      throw new Falha('mirror_resposta_invalida');
    return {
      result: t.result,
      name: t.name,
      entityId: (t.entity_id as string | null | undefined) ?? null,
      consenso: t.consensus_timestamp,
    };
  };
  return {
    async transacao(txId) {
      const id = paraMirror(txId);
      const x = await get(`/api/v1/transactions/${id}`);
      if (x === null) return [];
      if (!Array.isArray(x.transactions) || x.transactions.length > 20) throw new Falha('mirror_resposta_invalida');
      // Transação agendada ou filha com o mesmo id não é o envio deste runner.
      return (x.transactions as Record<string, unknown>[])
        .filter(t => t && t.scheduled !== true && (t.nonce === undefined || t.nonce === 0))
        .map(t => registro(t, id));
    },
    async frescor() {
      const x = await get('/api/v1/blocks?limit=1&order=desc');
      const b = Array.isArray(x?.blocks) ? (x!.blocks as Record<string, unknown>[])[0] : undefined;
      const ate = (b?.timestamp as { to?: unknown } | undefined)?.to;
      if (typeof ate !== 'string' || !CONSENSO.test(ate)) throw new Falha('mirror_resposta_invalida');
      const [s, ns] = ate.split('.') as [string, string];
      return Number(s) * 1000 + Math.floor(Number(ns) / 1_000_000);
    },
    async chaveDaConta(conta) {
      const x = await get(`/api/v1/accounts/${conta}?transactions=false`);
      if (x === null) throw new Falha('conta_nao_encontrada');
      const k = x.key as { _type?: unknown; key?: unknown } | null | undefined;
      if (x.account !== conta) throw new Falha('mirror_resposta_invalida');
      const chave = { type: k?._type, key: typeof k?.key === 'string' ? k.key.toLowerCase() : k?.key };
      if (!validKey(chave)) throw new Falha('chave_da_conta_nao_suportada');
      return chave;
    },
    async topicosCriados(conta) {
      // O mirror pagina por janelas de tempo (cerca de 60 dias), inclusive vazias. Começar na criação da conta
      // mantém poucas páginas para uma conta nova; passar do limite faz parar, nunca vira "nenhum tópico".
      const a = await get(`/api/v1/accounts/${conta}?transactions=false`);
      if (a === null) throw new Falha('conta_nao_encontrada');
      if (a.account !== conta || typeof a.created_timestamp !== 'string' || !CONSENSO.test(a.created_timestamp))
        throw new Falha('mirror_resposta_invalida');
      const base = `/api/v1/transactions?account.id=${conta}&transactiontype=CONSENSUSCREATETOPIC&result=success&order=asc&limit=100&timestamp=gte:${a.created_timestamp}`;
      const out: { topicId: string; txMirror: string }[] = [];
      let caminho: string | null = base;
      for (let p = 0; caminho; p++) {
        if (p === PAGINAS_CRIACOES) throw new Falha('mirror_limite_de_paginas');
        const x = await get(caminho);
        if (x === null || !Array.isArray(x.transactions) || x.transactions.length > 100)
          throw new Falha('mirror_resposta_invalida');
        for (const t of x.transactions as Record<string, unknown>[]) {
          const r = registro(t);
          const tx = t.transaction_id as string;
          // Só as pagas por esta conta; account.id também traz as que só a envolvem.
          if (!tx.startsWith(`${conta}-`) || r.result !== 'SUCCESS' || r.name !== 'CONSENSUSCREATETOPIC') continue;
          if (!r.entityId) throw new Falha('mirror_resposta_invalida');
          out.push({ topicId: r.entityId, txMirror: tx });
        }
        const prox = (x.links as { next?: unknown } | undefined)?.next ?? null;
        if (
          prox !== null &&
          (typeof prox !== 'string' ||
            !prox.startsWith(`/api/v1/transactions?account.id=${conta}&transactiontype=CONSENSUSCREATETOPIC&`))
        )
          throw new Falha('mirror_resposta_invalida');
        caminho = prox as string | null;
      }
      return out;
    },
  };
}
