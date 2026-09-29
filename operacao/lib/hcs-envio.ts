// Envio pelo Hiero SDK com o id da transação FIXADO no diário. É o único trecho do runner que vê a chave.
// A chave vem do ambiente protegido, fica neste closure e nunca vai para arquivo, artefato, log ou erro.
// Só o recibo decide "confirmada" ou "falhou". Qualquer outro desfecho (precheck, prazo, transporte, id
// diferente do diário) é "desconhecida": a rede pode ter aceitado, e a próxima preparação resolve pelo mirror.
import {
  AccountId,
  Client,
  Hbar,
  PrivateKey,
  ReceiptStatusError,
  Timestamp,
  TransactionId,
  type TopicCreateTransaction,
  type TopicMessageSubmitTransaction,
} from '@hiero-ledger/sdk';
import { buildCreateTopic, buildSubmit } from '../../packages/core/src/hcs-sdk.ts';
import { hederaStatus } from '../../packages/core/src/hcs-publish.ts';
import { validKey, validTopicId, type HcsKey } from '../../packages/core/src/hcs.ts';
// @ts-expect-error módulo .mjs sem tipos
import { Falha } from './rede.mjs';
import { AMBIGUOS, partes, VALIDADE_S, type Intencao } from './hcs-diario.ts';

export type Desfecho =
  | { situacao: 'confirmada'; resultado: { topicId?: string } }
  | { situacao: 'falhou'; status?: string }
  | { situacao: 'desconhecida' };

export interface Enviador {
  chavePublica(): HcsKey;
  enviar(i: Intencao): Promise<Desfecho>;
  fechar(): void;
}

const CHAVE = /^0x[0-9a-fA-F]{64}$/;
const MAX_FEE = new Hbar(2);
/** "falhou" só com status da lista fechada e não ambíguo; o resto é "desconhecida". */
const falhaOuDesconhecida = (status: string | undefined): Desfecho =>
  status && !AMBIGUOS.has(status) ? { situacao: 'falhou', status } : { situacao: 'desconhecida' };

/** Monta e congela exatamente a transação do diário. Exportado para o teste offline. */
export function montar(
  i: Intencao,
  key: PrivateKey,
  client: Client,
): TopicCreateTransaction | TopicMessageSubmitTransaction {
  const { conta, s, ns } = partes(i.transactionId);
  const id = TransactionId.withValidStart(AccountId.fromString(conta), new Timestamp(s, ns));
  let tx: TopicCreateTransaction | TopicMessageSubmitTransaction;
  if (i.acao === 'criar_topico') tx = buildCreateTopic(key, i.memo!);
  else {
    if (!validTopicId(i.topicId) || typeof i.texto !== 'string') throw new Falha('intencao_invalida');
    tx = buildSubmit(i.topicId, new TextEncoder().encode(i.texto));
  }
  tx.setTransactionId(id);
  tx.setTransactionValidDuration(VALIDADE_S);
  tx.setMaxTransactionFee(MAX_FEE);
  tx.setRegenerateTransactionId(false);
  tx.freezeWith(client);
  return tx;
}

/** Status Hedera de um erro do SDK, só se estiver na lista fechada do template. Nunca lança. */
function statusDe(e: unknown): string | undefined {
  try {
    const raw = (e as { status?: { toString?: () => string } } | null)?.status;
    return raw && typeof raw.toString === 'function' ? hederaStatus(raw.toString()) : undefined;
  } catch {
    return undefined;
  }
}

export function enviadorSdk(operador: string, chaveHex: unknown, cliente?: Client): Enviador {
  if (typeof chaveHex !== 'string' || !CHAVE.test(chaveHex)) throw new Falha('chave_ausente_ou_invalida');
  let key: PrivateKey;
  try {
    key = PrivateKey.fromStringECDSA(chaveHex.slice(2));
  } catch {
    throw new Falha('chave_ausente_ou_invalida');
  }
  const publica: HcsKey = { type: 'ECDSA_SECP256K1', key: key.publicKey.toStringRaw().toLowerCase() };
  if (!validKey(publica)) throw new Falha('chave_ausente_ou_invalida');
  const client = cliente ?? Client.forTestnet();
  client.setOperator(AccountId.fromString(operador), key);
  client.setDefaultMaxTransactionFee(MAX_FEE);
  client.setDefaultRegenerateTransactionId(false);
  client.setMaxAttempts(5);
  client.setRequestTimeout(30_000);
  return {
    chavePublica: () => ({ ...publica }),
    async enviar(i) {
      if (i.situacao !== 'reservada') throw new Falha('intencao_nao_reservada');
      if (partes(i.transactionId).conta !== operador) throw new Falha('intencao_de_outra_conta');
      let tx: TopicCreateTransaction | TopicMessageSubmitTransaction;
      try {
        tx = montar(i, key, client);
      } catch {
        return { situacao: 'desconhecida' }; // nada saiu; o mirror vai mostrar que o id nunca entrou
      }
      try {
        const resposta = await tx.execute(client);
        if (resposta.transactionId.toString() !== i.transactionId) return { situacao: 'desconhecida' };
        const recibo = await resposta.getReceipt(client);
        if (recibo.status.toString() !== 'SUCCESS') return falhaOuDesconhecida(hederaStatus(recibo.status.toString()));
        if (i.acao === 'criar_topico') {
          const topicId = recibo.topicId ? recibo.topicId.toString() : null;
          if (!validTopicId(topicId)) return { situacao: 'desconhecida' };
          return { situacao: 'confirmada', resultado: { topicId } };
        }
        return { situacao: 'confirmada', resultado: {} };
      } catch (e) {
        // Recibo com status de falha: a transação chegou ao consenso e falhou; o mesmo id não entra de novo.
        if (e instanceof ReceiptStatusError) return falhaOuDesconhecida(statusDe(e));
        return { situacao: 'desconhecida' };
      }
    },
    fechar: () => client.close(),
  };
}
