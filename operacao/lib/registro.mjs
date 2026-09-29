// Registro revisado (operacao-registro.json, versão 2), commitado na cópia de prova por revisão manual.
// {
//   "versao": 2,
//   "contas": { "comprador": "0x...", "fornecedor": "0x..." },          // papéis obrigatórios
//   "nonceRevisado": { "0x...": 0, "0x...": 0 },                        // até onde a revisão cobriu cada conta
//   "execucoes": [                                                       // toda execução que entrou no ambiente
//     { "id": "123", "autorizacao": "aut-01", "artefatos": { "reserva-implantacao/reserva-implantacao.json": "<sha256>" } },
//     { "id": "456", "autorizacao": "aut-02", "perdida": true, "revisao": "motivo" }
//   ],
//   "autorizacao": { "id": "aut-03", "nonces": { "0x...": 1, "0x...": 0 } } // única autorização vigente
// }
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Falha } from './rede.mjs';
import { ler } from './estado.mjs';

const endereco = v => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);
const id = v => typeof v === 'string' && /^[\w.-]{1,64}$/.test(v);

export function lerRegistro(arquivo) {
  if (!arquivo || !existsSync(arquivo)) throw new Falha('registro_ausente');
  const r = ler(arquivo);
  if (r?.versao !== 2) throw new Falha('registro_versao_invalida');
  if (!r.contas || !endereco(r.contas.comprador) || !endereco(r.contas.fornecedor))
    throw new Falha('registro_contas_ausentes');
  if (r.contas.comprador.toLowerCase() === r.contas.fornecedor.toLowerCase()) throw new Falha('registro_contas_iguais');
  const contas = [r.contas.comprador, r.contas.fornecedor];
  for (const c of contas)
    if (!/^\d+$/.test(String(r.nonceRevisado?.[c] ?? ''))) throw new Falha('registro_nonce_revisado_ausente');
  if (!Array.isArray(r.execucoes)) throw new Falha('registro_invalido');
  for (const x of r.execucoes) {
    if (!id(x?.id) || !id(x?.autorizacao)) throw new Falha('registro_invalido');
    if (x.perdida === true) {
      if (typeof x.revisao !== 'string' || !x.revisao.trim()) throw new Falha('registro_perdida_sem_revisao');
    } else if (!x.artefatos || !Object.keys(x.artefatos).length) throw new Falha('registro_execucao_sem_artefatos');
    for (const [p, h] of Object.entries(x.artefatos ?? {}))
      if (!/^[\w.-]+\/[\w.-]+$/.test(p) || !/^[0-9a-f]{64}$/.test(h)) throw new Falha('registro_invalido');
  }
  if (!id(r.autorizacao?.id)) throw new Falha('registro_sem_autorizacao');
  for (const c of contas)
    if (!/^\d+$/.test(String(r.autorizacao.nonces?.[c] ?? ''))) throw new Falha('registro_sem_autorizacao');
  if (r.execucoes.some(x => x.autorizacao === r.autorizacao.id)) throw new Falha('autorizacao_ja_usada');
  return r;
}

/** Artefatos que o registro espera, com o hash do conteúdo: sumiu ou mudou, para. */
export function conferirArtefatos(r, dir) {
  for (const x of r.execucoes) {
    if (x.perdida) continue;
    for (const [rel, h] of Object.entries(x.artefatos)) {
      const [nome, arquivo] = rel.split('/');
      const p = path.join(dir, x.id, nome, arquivo);
      if (!existsSync(p)) throw new Falha('artefato_registrado_ausente');
      if (createHash('sha256').update(readFileSync(p)).digest('hex') !== h)
        throw new Falha('artefato_registrado_alterado');
    }
  }
}

/** A chave usada na preparação precisa ser a do papel registrado; a autorização da execução, a vigente. */
export function conferirIdentidade(r, papel, conta, autorizacao) {
  if (r.contas[papel]?.toLowerCase() !== conta.toLowerCase()) throw new Falha(`conta_diferente_do_registro:${papel}`);
  if (autorizacao !== r.autorizacao.id) throw new Falha('autorizacao_diferente_da_vigente');
}
