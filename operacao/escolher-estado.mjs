// Escolhe o estado de prova para retomar: o artefato mais recente da execução indicada, que também precisa ser o
// estado mais recente da MESMA prova (provaId) entre todas as execuções, concluído ou não. Retomar um estado velho
// repetiria etapas já feitas por outra execução. Só lê arquivos baixados; não usa rede nem chave.
import { copyFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Falha, publico } from './lib/rede.mjs';
import { ler, linha } from './lib/estado.mjs';

function estados(dir) {
  const out = [];
  const andar = d => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) andar(p);
      else if (n === 'prova-estado.json') {
        const e = ler(p);
        const execucao = path.relative(dir, p).split(path.sep)[0];
        out.push({ arquivo: p, execucao, e });
      }
    }
  };
  if (existsSync(dir)) andar(dir);
  return out;
}

try {
  const [, , , anteriores, , retomar, , saida] = process.argv;
  if (process.argv[2] !== '--anteriores' || process.argv[4] !== '--retomar' || process.argv[6] !== '--saida')
    throw new Falha('uso');
  if (!retomar) {
    linha({ etapa: 'retomada', situacao: 'nova_prova' });
    process.exit(0);
  }
  if (!/^\d+$/.test(retomar)) throw new Falha('retomar_deve_ser_id_de_execucao');
  const todos = estados(anteriores);
  if (todos.some(x => typeof x.e.provaId !== 'string' || !x.e.atualizadoEm))
    throw new Falha('estado_anterior_sem_linhagem');
  const recente = (a, b) => Date.parse(b.e.atualizadoEm) - Date.parse(a.e.atualizadoEm);
  const daExecucao = todos.filter(x => x.execucao === retomar).sort(recente);
  if (!daExecucao.length) throw new Falha('execucao_sem_estado');
  const escolhido = daExecucao[0];
  // Linhagem = mesmo provaId, em qualquer execução e em qualquer situação (concluída inclusive).
  const maisNovoDaLinhagem = todos.filter(x => x.e.provaId === escolhido.e.provaId).sort(recente)[0];
  if (maisNovoDaLinhagem.e.situacao === 'concluida') throw new Falha('prova_ja_concluida');
  if (
    maisNovoDaLinhagem !== escolhido &&
    Date.parse(maisNovoDaLinhagem.e.atualizadoEm) > Date.parse(escolhido.e.atualizadoEm)
  )
    throw new Falha('existe_estado_mais_recente_na_mesma_prova');
  copyFileSync(escolhido.arquivo, saida);
  const car = escolhido.arquivo.replace(/\.json$/, '.car');
  if (existsSync(car)) copyFileSync(car, saida.replace(/\.json$/, '.car'));
  linha({
    etapa: 'retomada',
    execucao: retomar,
    situacao: escolhido.e.situacao,
    atualizadoEm: escolhido.e.atualizadoEm,
  });
} catch (e) {
  process.stderr.write(JSON.stringify({ etapa: 'erro', ...publico(e) }) + '\n');
  process.exit(1);
}
