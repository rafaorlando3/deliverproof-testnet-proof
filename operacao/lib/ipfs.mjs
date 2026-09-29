// Entrega sintética: CAR com um bloco raw, fixação no Filebase (RPC dag/import) e conferência pela porta pública.
// Prazo por pedido, prazo total medido e limite de bytes; nenhum corpo remoto sai para log.
import { bytesToHex } from 'viem';
import { CarWriter } from '@ipld/car';
import { CID } from 'multiformats/cid';
import { sha256 } from 'multiformats/hashes/sha2';
import { Falha, buscar } from './rede.mjs';

export async function montarEntrega(texto) {
  const bytes = new TextEncoder().encode(texto);
  const resumo = await sha256.digest(bytes);
  const cid = CID.createV1(0x55, resumo);
  const { writer, out } = CarWriter.create([cid]);
  const partes = [];
  const coleta = (async () => {
    for await (const p of out) partes.push(p);
  })();
  await writer.put({ cid, bytes });
  await writer.close();
  await coleta;
  const car = new Uint8Array(partes.reduce((n, p) => n + p.length, 0));
  partes.reduce((o, p) => (car.set(p, o), o + p.length), 0);
  return { cid: cid.toString(), sha256: bytesToHex(resumo.digest), bytes: bytes.length, car };
}

/** Filebase RPC dag/import com pin-roots; a raiz tem de voltar na resposta, sem erro de fixação. */
export async function fixar(base, token, entrega) {
  if (!token) throw new Falha('falta_token_filebase');
  const form = new FormData();
  form.append('file', new Blob([entrega.car]), 'entrega.car');
  const { status, bytes } = await buscar(
    `${base}/api/v0/dag/import?pin-roots=true`,
    { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form },
    { prazoMs: 60_000, limiteBytes: 64_000, codigo: 'filebase' },
  );
  if (status !== 200) throw new Falha('filebase_http', status);
  let raizes;
  try {
    raizes = new TextDecoder()
      .decode(bytes)
      .split('\n')
      .filter(Boolean)
      .map(l => JSON.parse(l))
      .filter(l => l && l.Root);
  } catch {
    throw new Falha('filebase_resposta_ilegivel');
  }
  if (!raizes.some(l => l.Root.Cid?.['/'] === entrega.cid && !l.Root.PinErrorMsg))
    throw new Falha('filebase_sem_a_raiz');
}

/**
 * Busca os bytes pela porta pública (formato raw, trustless) e compara com o SHA-256 e o tamanho gravados.
 * HTML, tamanho diferente, bytes diferentes, pedido travado ou resposta grande: não confere. Prazo total medido.
 */
export async function conferirPorta(base, entrega, { tentativas, esperaMs, prazoPedidoMs, prazoTotalMs }) {
  const fim = Date.now() + prazoTotalMs;
  const motivos = [];
  for (let i = 0; i < tentativas; i++) {
    const resta = fim - Date.now();
    if (resta <= 0) break;
    try {
      const { status, tipo, bytes } = await buscar(
        `${base}/ipfs/${entrega.cid}?format=raw`,
        { headers: { accept: 'application/vnd.ipld.raw' } },
        { prazoMs: Math.min(prazoPedidoMs, resta), limiteBytes: entrega.bytes, codigo: 'porta' },
      );
      if (status !== 200) motivos.push(`http_${status}`);
      else if (/html/i.test(tipo)) motivos.push('html');
      else if (bytes.length !== entrega.bytes) motivos.push('tamanho_diferente');
      else if (bytesToHex((await sha256.digest(bytes)).digest) !== entrega.sha256) motivos.push('bytes_diferentes');
      else return { conferido: true, tentativas: i + 1, motivos };
    } catch (e) {
      motivos.push(e instanceof Falha ? e.codigo : 'porta_falha');
    }
    if (i + 1 < tentativas && Date.now() + esperaMs < fim) await new Promise(ok => setTimeout(ok, esperaMs));
  }
  return { conferido: false, tentativas: motivos.length, motivos };
}
