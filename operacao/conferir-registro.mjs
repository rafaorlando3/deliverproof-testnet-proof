// Confere o registro revisado (lib/registro.mjs, versão 2) contra os artefatos, o ambiente do GitHub e a rede,
// antes de qualquer preparação. Só leitura; não usa chave. Para (código 1) em qualquer diferença:
//   - registro ausente, sem os dois papéis, sem autorização vigente, ou autorização já usada;
//   - autorização pedida na execução diferente da vigente;
//   - artefato registrado ausente ou com hash diferente (inclusive o último estado de uma execução);
//   - artefato baixado de execução que não está no registro, ou que já carrega a autorização vigente;
//   - execução que entrou no ambiente protegido (implantações do GitHub) sem estar no registro;
//   - nonce da rede diferente do registrado na autorização (alguém consumiu nonce depois da revisão);
//   - nonce entre `nonceRevisado` e o atual sem tentativa conhecida com recibo.
// Bootstrap único: o primeiro registro tem `execucoes: []`, `nonceRevisado` = nonces da autorização.
// uso: node operacao/conferir-registro.mjs --registro R --anteriores DIR --autorizacao ID [--execucoes-ambiente F]
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { Falha, publico, rpc, numero } from './lib/rede.mjs';
import { configuracao, primeiraTentativa } from './lib/config.mjs';
import { ler, linha } from './lib/estado.mjs';
import { lerRegistro, conferirArtefatos } from './lib/registro.mjs';

const LIMITE_INTERVALO = 200;

/** Tentativas conhecidas e autorizações que aparecem nos artefatos baixados, por execução. */
function artefatos(dir) {
  const tentativas = [];
  const usos = []; // { execucao, autorizacao }
  const execucoes = new Set();
  const andar = d => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) andar(p);
      else if (n === 'reserva-implantacao.json' || n === 'prova-estado.json') {
        const execucao = path.relative(dir, p).split(path.sep)[0];
        execucoes.add(execucao);
        const x = ler(p);
        if (n === 'reserva-implantacao.json') {
          tentativas.push({ conta: x.conta, nonce: x.nonce, hash: x.txHash });
          if (x.autorizacao) usos.push({ execucao, autorizacao: x.autorizacao });
        } else {
          for (const et of Object.values(x.etapas ?? {})) {
            if (et.de && et.nonce !== undefined) {
              if (et.txHash) tentativas.push({ conta: et.de, nonce: et.nonce, hash: et.txHash });
              for (const a of et.anteriores ?? []) tentativas.push({ conta: et.de, nonce: et.nonce, hash: a.txHash });
            }
            for (const s of et.substituidas ?? []) tentativas.push({ conta: s.de, nonce: s.nonce, hash: s.por });
            for (const u of [et.autorizacao, ...(et.anteriores ?? []).map(a => a.autorizacao)])
              if (u) usos.push({ execucao, autorizacao: u });
          }
        }
      }
    }
  };
  if (existsSync(dir)) andar(dir);
  return { tentativas, usos, execucoes };
}

function args(lista) {
  const o = {};
  for (let i = 0; i < lista.length; i += 2) {
    if (!lista[i]?.startsWith('--')) throw new Falha('uso');
    o[lista[i].slice(2)] = lista[i + 1];
  }
  return o;
}

async function principal() {
  const o = args(process.argv.slice(2));
  primeiraTentativa();
  const cfg = configuracao();
  const r = lerRegistro(o.registro);
  if (!o.anteriores || !existsSync(o.anteriores)) throw new Falha('pasta_de_anteriores_ausente');
  if (o.autorizacao !== r.autorizacao.id) throw new Falha('autorizacao_diferente_da_vigente');
  conferirArtefatos(r, o.anteriores);
  const registradas = new Set(r.execucoes.map(x => x.id));
  const { tentativas, usos, execucoes } = artefatos(o.anteriores);
  for (const e of execucoes) if (!registradas.has(e)) throw new Falha('execucao_nao_revisada');
  if (usos.some(u => u.autorizacao === r.autorizacao.id)) throw new Falha('autorizacao_ja_usada');
  if (cfg.nome === 'testnet' && !o['execucoes-ambiente']) throw new Falha('lista_do_ambiente_obrigatoria');
  if (o['execucoes-ambiente']) {
    const doAmbiente = ler(o['execucoes-ambiente']);
    if (!Array.isArray(doAmbiente)) throw new Falha('lista_do_ambiente_invalida');
    for (const e of doAmbiente) if (!registradas.has(String(e))) throw new Falha('execucao_no_ambiente_sem_registro');
  }
  const chamar = rpc(cfg.rpc);
  if (numero(await chamar('eth_chainId')) !== BigInt(cfg.chainId)) throw new Falha('rede_errada');
  for (const conta of [r.contas.comprador, r.contas.fornecedor]) {
    const latest = numero(await chamar('eth_getTransactionCount', [conta, 'latest']));
    const pending = numero(await chamar('eth_getTransactionCount', [conta, 'pending']));
    const autorizado = BigInt(r.autorizacao.nonces[conta]);
    if (latest !== autorizado || pending !== autorizado) {
      linha({
        etapa: 'nonce_diferente_da_autorizacao',
        conta,
        autorizado: autorizado.toString(),
        rede: latest.toString(),
      });
      throw new Falha('autorizacao_desatualizada');
    }
    const desde = BigInt(r.nonceRevisado[conta]);
    if (latest < desde) throw new Falha('nonce_da_rede_abaixo_do_registro');
    if (latest - desde > BigInt(LIMITE_INTERVALO)) throw new Falha('intervalo_grande_revise_o_registro');
    for (let n = desde; n < latest; n++) {
      let coberto = false;
      for (const t of tentativas.filter(t => t.conta?.toLowerCase() === conta.toLowerCase() && BigInt(t.nonce) === n))
        if (await chamar('eth_getTransactionReceipt', [t.hash])) coberto = true;
      if (!coberto) {
        linha({ etapa: 'nonce_sem_tentativa_conhecida', conta, nonce: n.toString() });
        throw new Falha('nonce_sem_reserva_conhecida');
      }
    }
    linha({ etapa: 'conta_conferida', conta, nonce: latest.toString() });
  }
  linha({ etapa: 'registro_conferido', autorizacao: r.autorizacao.id, execucoes: r.execucoes.length });
}

principal().catch(e => {
  process.stderr.write(JSON.stringify({ etapa: 'erro', ...publico(e) }) + '\n');
  process.exitCode = 1;
});
