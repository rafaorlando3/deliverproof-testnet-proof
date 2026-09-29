// Ajuda a revisão manual: imprime o trecho do registro de uma execução já baixada (nomes dos artefatos e
// sha256 de cada arquivo público). Não escreve no repositório; quem revisa cola no operacao-registro.json.
// uso: node operacao/registrar-execucao.mjs --anteriores DIR --execucao ID --autorizacao ID
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const a = process.argv.slice(2);
const o = Object.fromEntries([0, 2, 4].map(i => [a[i]?.replace(/^--/, ''), a[i + 1]]));
if (!o.anteriores || !/^\d+$/.test(o.execucao ?? '') || !/^[\w.-]{1,64}$/.test(o.autorizacao ?? '')) {
  console.error('uso: registrar-execucao.mjs --anteriores DIR --execucao ID --autorizacao ID');
  process.exit(2);
}
const base = path.join(o.anteriores, o.execucao);
if (!existsSync(base)) {
  console.error(JSON.stringify({ etapa: 'erro', codigo: 'execucao_sem_artefatos_marque_perdida_com_revisao' }));
  process.exit(1);
}
const artefatos = {};
for (const nome of readdirSync(base).sort())
  if (statSync(path.join(base, nome)).isDirectory())
    for (const arq of readdirSync(path.join(base, nome)).sort())
      if (/\.json$/.test(arq))
        artefatos[`${nome}/${arq}`] = createHash('sha256')
          .update(readFileSync(path.join(base, nome, arq)))
          .digest('hex');
console.log(JSON.stringify({ id: o.execucao, autorizacao: o.autorizacao, artefatos }, null, 2));
