// Gravação atômica e durável de arquivos públicos (reserva, estado da prova, candidato).
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync, existsSync } from 'node:fs';
import { Falha } from './rede.mjs';

export function gravar(arquivo, dado, { exclusivo = false } = {}) {
  if (exclusivo && existsSync(arquivo)) throw new Falha('arquivo_ja_existe');
  const tmp = `${arquivo}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'wx', 0o644);
  try {
    writeSync(fd, JSON.stringify(dado, null, 2) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, arquivo);
}

export function ler(arquivo) {
  try {
    return JSON.parse(readFileSync(arquivo, 'utf8'));
  } catch {
    throw new Falha('arquivo_ilegivel');
  }
}

/** Uma linha pública por evento, no stdout. Só campos públicos passam por aqui. */
export const linha = o => process.stdout.write(JSON.stringify(o) + '\n');
