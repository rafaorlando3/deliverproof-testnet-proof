// Rede: JSON-RPC mínimo, com prazo por pedido, limite de bytes e erros só por código.
// Nenhuma mensagem de biblioteca, corpo remoto ou dado de pedido vai para log ou arquivo:
// um erro vira { codigo, status? } com status numérico (HTTP ou código JSON-RPC).
import { keccak256, recoverTransactionAddress, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export class Falha extends Error {
  /**
   * @param {string} codigo código fixo deste pacote; @param {number|null} status número público (HTTP/JSON-RPC);
   * @param {string} [dados] dado hexadecimal de revert devolvido pela RPC (público, nunca impresso)
   */
  constructor(codigo, status = null, dados = undefined) {
    super(codigo);
    this.codigo = codigo;
    this.status = typeof status === 'number' && Number.isFinite(status) ? status : null;
    if (dados !== undefined) this.dados = dados;
  }
}
/** O único formato de erro que sai para log: código fixo e, no máximo, um número. */
export function publico(e) {
  // Bibliotecas (viem) embrulham o erro: procura a Falha na cadeia de causas; fora disso, código genérico.
  for (let x = e, i = 0; x && i < 8; x = x.cause, i++)
    if (x instanceof Falha) return { codigo: x.codigo, ...(x.status !== null ? { status: x.status } : {}) };
  return { codigo: 'falha_inesperada' };
}

/** Lê o corpo com limite de bytes; o prazo é do AbortController de quem chamou. */
export async function lerLimitado(resposta, limite) {
  if (!resposta.body) return new Uint8Array();
  const leitor = resposta.body.getReader();
  const partes = [];
  let n = 0;
  for (;;) {
    const { done, value } = await leitor.read();
    if (done) break;
    n += value.length;
    if (n > limite) {
      await leitor.cancel().catch(() => {});
      throw new Falha('resposta_grande_demais');
    }
    partes.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of partes) (out.set(p, o), (o += p.length));
  return out;
}

/** fetch com prazo total (conexão + corpo) e limite de bytes. Devolve { status, bytes }. */
export async function buscar(url, init, { prazoMs, limiteBytes, codigo }) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), prazoMs);
  try {
    const r = await fetch(url, { ...init, signal: ac.signal, redirect: 'error' });
    const bytes = await lerLimitado(r, limiteBytes);
    return { status: r.status, tipo: r.headers.get('content-type') ?? '', bytes };
  } catch (e) {
    if (e instanceof Falha) throw e;
    throw new Falha(ac.signal.aborted ? `${codigo}_prazo` : `${codigo}_transporte`);
  } finally {
    clearTimeout(t);
  }
}

export function rpc(url, { prazoMs = 20_000 } = {}) {
  let id = 0;
  return async function chamar(method, params = []) {
    const { status, bytes } = await buscar(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      },
      { prazoMs, limiteBytes: 4_000_000, codigo: 'rpc' },
    );
    if (status < 200 || status > 299) throw new Falha('rpc_http', status);
    let j;
    try {
      j = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new Falha('rpc_nao_json', status);
    }
    if (j && j.error) {
      // Só o código numérico e, se houver, o dado de revert em hexadecimal (para decodificar o erro do contrato).
      const d = typeof j.error.data === 'string' ? j.error.data : j.error.data?.data;
      const dados = typeof d === 'string' && /^0x[0-9a-fA-F]*$/.test(d) && d.length <= 20_000 ? d : undefined;
      throw new Falha('rpc_erro', typeof j.error.code === 'number' ? j.error.code : null, dados);
    }
    if (!j || !('result' in j)) throw new Falha('rpc_sem_resultado');
    return j.result;
  };
}

export const hexN = n => '0x' + BigInt(n).toString(16);
export const numero = h => {
  if (typeof h !== 'string' || !/^0x[0-9a-f]+$/i.test(h)) throw new Falha('rpc_formato');
  return BigInt(h);
};

/** Nonce "latest" e "pending" da conta; os dois precisam bater com o esperado antes de assinar e antes de transmitir. */
export async function conferirNonce(chamar, conta, esperado) {
  const latest = numero(await chamar('eth_getTransactionCount', [conta, 'latest']));
  const pending = numero(await chamar('eth_getTransactionCount', [conta, 'pending']));
  if (latest !== BigInt(esperado) || pending !== BigInt(esperado))
    throw new Falha('nonce_diferente_nao_assinar_nem_transmitir');
  return { latest, pending };
}

/**
 * Assina fora da rede com nonce explícito. O hash sai da própria transação assinada, antes de qualquer envio,
 * e a transação é conferida de volta (assinante, nonce, chain, destino, valor e dados).
 */
export async function assinar(chamar, chave, { chainId, nonce, to, data, value, gasMinimo = 0n }) {
  const conta = privateKeyToAccount(chave);
  const precoRede = numero(await chamar('eth_gasPrice'));
  const gasPrice = (precoRede * 11n) / 10n; // margem pequena: o Hedera recusa preço abaixo do corrente
  const estimativa = numero(
    await chamar('eth_estimateGas', [{ from: conta.address, ...(to ? { to } : {}), data, value: hexN(value) }]),
  );
  let gas = (estimativa * 5n) / 4n; // o Hedera cobra ao menos 80% do limite: margem curta de propósito
  if (gas < BigInt(gasMinimo)) gas = BigInt(gasMinimo); // piso pedido por quem chama (conta oca, ver prova.mjs)
  const bruta = await conta.signTransaction({
    type: 'legacy',
    chainId,
    nonce: Number(nonce),
    gasPrice,
    gas,
    ...(to ? { to } : {}),
    data,
    value,
  });
  const hash = keccak256(bruta);
  await conferirBruta(bruta, { de: conta.address, chainId, nonce, to: to ?? null, data, value });
  return { bruta, hash, de: conta.address, gas: gas.toString(), gasPrice: gasPrice.toString() };
}

/** Confere uma transação assinada contra o que a reserva diz. Não usa rede. */
export async function conferirBruta(bruta, { de, chainId, nonce, to, data, value }) {
  let tx;
  try {
    tx = parseTransaction(bruta);
  } catch {
    throw new Falha('transacao_ilegivel');
  }
  const assinante = await recoverTransactionAddress({ serializedTransaction: bruta }).catch(() => null);
  if (
    !assinante ||
    assinante.toLowerCase() !== de.toLowerCase() ||
    tx.chainId !== chainId ||
    BigInt(tx.nonce) !== BigInt(nonce) ||
    (tx.to ?? null)?.toLowerCase() !== (to ?? null)?.toLowerCase() ||
    keccak256(tx.data ?? '0x') !== keccak256(data) ||
    (tx.value ?? 0n) !== BigInt(value)
  )
    throw new Falha('transacao_nao_confere_com_a_reserva');
}

/**
 * Transmite a transação já reservada. Qualquer falha no envio é "desconhecida": a rede pode ter aceitado
 * e a resposta se perdido. Nunca reenvia; só consulta o recibo pelo hash até o prazo.
 */
export async function transmitir(chamar, bruta, hash, { prazoReciboMs, intervaloMs }) {
  let envio = 'aceita';
  try {
    const h = await chamar('eth_sendRawTransaction', [bruta]);
    if (typeof h !== 'string' || h.toLowerCase() !== hash.toLowerCase()) envio = 'hash_diferente';
  } catch (e) {
    envio = 'desconhecido';
  }
  const recibo = await esperarRecibo(chamar, hash, { prazoMs: prazoReciboMs, intervaloMs });
  return { envio, recibo };
}

export async function esperarRecibo(chamar, hash, { prazoMs, intervaloMs }) {
  const fim = Date.now() + prazoMs;
  for (;;) {
    try {
      const r = await chamar('eth_getTransactionReceipt', [hash]);
      if (r) return r;
    } catch {
      // consulta só de leitura: tenta de novo até o prazo
    }
    if (Date.now() + intervaloMs > fim) return null;
    await new Promise(ok => setTimeout(ok, intervaloMs));
  }
}

/**
 * Situação de uma etapa reservada, só por leitura, olhando TODAS as tentativas dela (todas com o mesmo nonce):
 *  confirmada | revertida (com o hash da tentativa que entrou) |
 *  nonce_avancou_sem_recibo (parar: outra transação usou o nonce, ou o recibo atrasou) |
 *  pendente (dentro da janela: esperar) | nonce_futuro (inconsistente: parar) |
 *  sem_recibo_janela_vencida (nonce parado: pode ser reassinada, SÓ com o mesmo nonce. Não quer dizer que
 *  a tentativa antiga nunca entra: a transação assinada não expira e é pública; o nonce igual é o que as exclui).
 */
export async function situacao(chamar, { hashes, de, nonce, reservadaEm }, { janelaMs, agora = Date.now() }) {
  for (const h of hashes) {
    const r = await chamar('eth_getTransactionReceipt', [h]);
    if (r) return { estado: numero(r.status) === 1n ? 'confirmada' : 'revertida', recibo: r, hash: h };
  }
  const latest = numero(await chamar('eth_getTransactionCount', [de, 'latest']));
  if (latest > BigInt(nonce)) return { estado: 'nonce_avancou_sem_recibo' };
  if (latest < BigInt(nonce)) return { estado: 'nonce_futuro' };
  return { estado: agora - Date.parse(reservadaEm) < janelaMs ? 'pendente' : 'sem_recibo_janela_vencida' };
}

/**
 * Prova, só por leitura, de que uma transação reservada NUNCA entra: outra transação T da mesma conta,
 * com o mesmo nonce e hash diferente, já está na rede. Quem opera informa T (achado pela conta e pelo nonce).
 */
export async function comprovarSubstituicao(chamar, { hash, de, nonce }, outra) {
  if (!/^0x[0-9a-f]{64}$/i.test(outra ?? '') || outra.toLowerCase() === hash.toLowerCase())
    throw new Falha('substituta_invalida');
  const [tx, recibo] = [
    await chamar('eth_getTransactionByHash', [outra]),
    await chamar('eth_getTransactionReceipt', [outra]),
  ];
  if (!tx || !recibo || tx.from?.toLowerCase() !== de.toLowerCase() || numero(tx.nonce) !== BigInt(nonce))
    throw new Falha('substituta_nao_comprova');
  if (await chamar('eth_getTransactionReceipt', [hash])) throw new Falha('reservada_entrou');
  return true;
}

/** "H=T,H2=T2" -> Map(h -> t). */
export function substituicoes(texto) {
  const m = new Map();
  for (const par of (texto ?? '').split(',').filter(Boolean)) {
    const [h, t] = par.split('=');
    if (!/^0x[0-9a-f]{64}$/i.test(h ?? '') || !/^0x[0-9a-f]{64}$/i.test(t ?? ''))
      throw new Falha('substituicoes_invalidas');
    m.set(h.toLowerCase(), t.toLowerCase());
  }
  return m;
}
