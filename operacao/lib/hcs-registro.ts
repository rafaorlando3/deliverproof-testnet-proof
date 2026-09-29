// Registro revisado da trilha HCS (hcs-registro.json, versão 1), commitado na cópia de prova por revisão manual,
// como o operacao-registro.json dos fluxos EVM. É o que separa "primeiro uso" de "histórico perdido": a lista de
// artefatos baixada sozinha nunca prova que o histórico está completo.
// {
//   "versao": 1,
//   "operador": "0.0.N",
//   "execucoes": [                                                  // toda execução do hcs-testnet que entrou no ambiente
//     { "id": "123", "artefatos": { "hcs-diario-99/hcs-diario.json": "<sha256>" } },   // diários conferidos por hash
//     { "id": "456", "perdida": true, "revisao": "motivo", "encerradaEm": "2026-10-01T12:00:00.000Z" }
//   ]
// }
// Bootstrap: o primeiro registro tem `execucoes: []`. Cada execução do ambiente testnet (implantações do GitHub,
// listadas por listar-execucoes-ambiente.sh) precisa estar aqui ou no operacao-registro.json (execuções EVM);
// o que não estiver em nenhum dos dois faz parar antes de qualquer reserva. `perdida` exige o horário em que a
// execução terminou: nada novo é reservado até o mirror passar desse horário + validade + margem.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
// @ts-expect-error módulo .mjs sem tipos
import { Falha } from './rede.mjs';
import { contaValida, ARQUIVO } from './hcs-diario.ts';

export type ExecucaoHcs =
  | { id: string; artefatos: Record<string, string> }
  | { id: string; perdida: true; revisao: string; encerradaEm: string };
export type RegistroHcs = { versao: 1; operador: string; execucoes: ExecucaoHcs[] };

const ID = /^[0-9]{1,20}$/;
const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$/;
const ARTEFATO = /^hcs-diario-[0-9]{2}\/hcs-diario\.json$/;
const AUTORIZACAO = /^[\w.-]{1,64}$/;

function lerJson(arquivo: string, codigo: string): unknown {
  if (!arquivo || !existsSync(arquivo)) throw new Falha(codigo);
  try {
    return JSON.parse(readFileSync(arquivo, 'utf8'));
  } catch {
    throw new Falha('arquivo_ilegivel');
  }
}

/** Formato exato; `autorizacao` é aceito só para colar a saída de registrar-execucao.mjs sem editar. */
export function lerRegistroHcs(arquivo: string, operador: string): RegistroHcs {
  const r = lerJson(arquivo, 'registro_hcs_ausente') as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || Array.isArray(r)) throw new Falha('registro_hcs_invalido');
  if (Object.keys(r).sort().join() !== 'execucoes,operador,versao') throw new Falha('registro_hcs_invalido');
  if (r.versao !== 1 || !contaValida(r.operador)) throw new Falha('registro_hcs_invalido');
  if (r.operador !== operador) throw new Falha('registro_hcs_de_outra_conta');
  if (!Array.isArray(r.execucoes) || r.execucoes.length > 200) throw new Falha('registro_hcs_invalido');
  const vistos = new Set<string>();
  const execucoes: ExecucaoHcs[] = r.execucoes.map((x: unknown) => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Falha('registro_hcs_invalido');
    const e = x as Record<string, unknown>;
    if (typeof e.id !== 'string' || !ID.test(e.id)) throw new Falha('registro_hcs_invalido');
    if (vistos.has(e.id)) throw new Falha('registro_hcs_execucao_repetida');
    vistos.add(e.id);
    if (e.perdida === true) {
      if (Object.keys(e).sort().join() !== 'encerradaEm,id,perdida,revisao') throw new Falha('registro_hcs_invalido');
      if (typeof e.revisao !== 'string' || !e.revisao.trim() || e.revisao.length > 500)
        throw new Falha('registro_hcs_perdida_sem_revisao');
      if (typeof e.encerradaEm !== 'string' || !ISO.test(e.encerradaEm) || Number.isNaN(Date.parse(e.encerradaEm)))
        throw new Falha('registro_hcs_perdida_sem_horario');
      return { id: e.id, perdida: true, revisao: e.revisao, encerradaEm: e.encerradaEm };
    }
    const chaves = Object.keys(e).sort().join();
    if (chaves !== 'artefatos,id' && chaves !== 'artefatos,autorizacao,id') throw new Falha('registro_hcs_invalido');
    if (e.autorizacao !== undefined && (typeof e.autorizacao !== 'string' || !AUTORIZACAO.test(e.autorizacao)))
      throw new Falha('registro_hcs_invalido');
    const a = e.artefatos as Record<string, unknown> | null;
    if (!a || typeof a !== 'object' || Array.isArray(a) || !Object.keys(a).length)
      throw new Falha('registro_hcs_execucao_sem_diario');
    for (const [p, h] of Object.entries(a))
      if (!ARTEFATO.test(p) || typeof h !== 'string' || !/^[0-9a-f]{64}$/.test(h))
        throw new Falha('registro_hcs_invalido');
    return { id: e.id, artefatos: { ...(a as Record<string, string>) } };
  });
  return { versao: 1, operador, execucoes };
}

/** Ids das execuções EVM já revisadas (operacao-registro.json, versão 2). Só os ids; o resto é do conferir-registro. */
export function idsEvm(arquivo: string): Set<string> {
  const r = lerJson(arquivo, 'registro_evm_ausente') as { versao?: unknown; execucoes?: unknown } | null;
  if (!r || r.versao !== 2 || !Array.isArray(r.execucoes)) throw new Falha('registro_evm_invalido');
  const out = new Set<string>();
  for (const x of r.execucoes as { id?: unknown }[]) {
    if (typeof x?.id !== 'string' || !ID.test(x.id)) throw new Falha('registro_evm_invalido');
    out.add(x.id);
  }
  return out;
}

/** Saída de listar-execucoes-ambiente.sh: execuções que entraram no ambiente testnet, sem a atual. */
export function lerAmbiente(arquivo: string): string[] {
  const x = lerJson(arquivo, 'lista_do_ambiente_obrigatoria');
  if (!Array.isArray(x) || x.length > 1000 || x.some(e => typeof e !== 'string' || !ID.test(e)))
    throw new Falha('lista_do_ambiente_invalida');
  return x as string[];
}

/**
 * Cruza o inventário independente (ambiente do GitHub) com os registros revisados e com os diários baixados.
 * Para antes de qualquer reserva se: uma execução do ambiente não está revisada; uma execução revisada não está
 * no ambiente; um diário registrado sumiu (listagem sem o artefato, ou ZIP sem o arquivo) ou mudou; há pasta
 * baixada de execução não revisada como HCS. Devolve o fim mais tardio das execuções marcadas como perdidas.
 */
export function conferirHistorico(
  registro: RegistroHcs,
  evm: Set<string>,
  ambiente: string[],
  dir: string,
  baixadas: string[],
  execucaoAtual: string,
): { perdidaAte: number | null } {
  const hcs = new Map(registro.execucoes.map(e => [e.id, e]));
  if (hcs.has(execucaoAtual)) throw new Falha('registro_hcs_tem_a_execucao_atual');
  for (const id of hcs.keys()) if (evm.has(id)) throw new Falha('registro_hcs_e_evm_sobrepostos');
  const noAmbiente = new Set(ambiente);
  for (const id of noAmbiente) if (!hcs.has(id) && !evm.has(id)) throw new Falha('execucao_no_ambiente_sem_registro');
  for (const id of hcs.keys()) if (!noAmbiente.has(id)) throw new Falha('execucao_registrada_fora_do_ambiente');
  for (const id of baixadas) {
    const e = hcs.get(id);
    if (!e) throw new Falha('execucao_hcs_nao_revisada');
    if ('perdida' in e) throw new Falha('execucao_perdida_com_diario_revise');
  }
  let perdidaAte: number | null = null;
  for (const e of registro.execucoes) {
    if ('perdida' in e) {
      perdidaAte = Math.max(perdidaAte ?? 0, Date.parse(e.encerradaEm));
      continue;
    }
    for (const [rel, h] of Object.entries(e.artefatos)) {
      const [nome, arquivo] = rel.split('/') as [string, string];
      if (arquivo !== ARQUIVO) throw new Falha('registro_hcs_invalido');
      const p = path.join(dir, e.id, nome, arquivo);
      if (!existsSync(p)) throw new Falha('diario_registrado_ausente');
      if (createHash('sha256').update(readFileSync(p)).digest('hex') !== h)
        throw new Falha('diario_registrado_alterado');
    }
  }
  return { perdidaAte };
}
