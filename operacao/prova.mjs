// Prova pública do DeliverProof na rede, como máquina de estados retomável.
//   preparar   --estado prova-estado.json [--anteriores DIR]
//       Reconcilia (só leitura) a etapa reservada, faz as ações sem transação (fixar o CAR, conferir a gravação,
//       conferir a porta pública, esperar prazo) e reserva a PRÓXIMA transação: assina com o nonce da conta,
//       grava hash e transação assinada no estado. Não transmite. No GitHub, o estado sobe como artefato antes
//       de transmitir. Sem estado e com prova anterior não concluída em DIR: para (retome aquela).
//   transmitir --estado prova-estado.json
//       Confere a reserva e o nonce; transmite exatamente aquela transação; espera o recibo. Falha no envio =
//       resultado desconhecido (código 3): não reenvia; a próxima preparação reconcilia pelo hash.
//   executar   --estado prova-estado.json [--anteriores DIR]   (local: preparar e transmitir em sequência)
// Comprador: DELIVERPROOF_TESTNET_PRIVATE_KEY. Fornecedor de teste: DELIVERPROOF_FORNECEDOR_PRIVATE_KEY, identidade
// recuperável guardada como segredo protegido (nunca em arquivo, artefato, canal ou log). Retomar usa as mesmas contas.
// Saída: só dados públicos. Erros: só código fixo e número.
import { existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { encodeFunctionData, decodeFunctionResult, keccak256, stringToHex, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import {
  Falha,
  publico,
  rpc,
  numero,
  conferirNonce,
  assinar,
  conferirBruta,
  transmitir,
  situacao,
  comprovarSubstituicao,
  substituicoes,
} from './lib/rede.mjs';
import { configuracao, chave, autorizado, artefato, origem, primeiraTentativa } from './lib/config.mjs';
import { gravar, ler, linha } from './lib/estado.mjs';
import { montarEntrega, fixar, conferirPorta } from './lib/ipfs.mjs';
import { lerRegistro, conferirIdentidade } from './lib/registro.mjs';

const raiz = process.cwd();
const TEXTO = rede => `DeliverProof: entrega sintética pública para a prova na ${rede}. Sem dados de clientes.\n`;
const TERMOS1 = 'Termos públicos sintéticos: entregar o texto de prova; aprovação explícita do comprador.';
const TERMOS2 = 'Termos públicos sintéticos: sem entrega; o silêncio não libera pagamento.';
const VALOR1 = 50_000_000n; // 0,5 HBAR em tinybar
const VALOR2 = 30_000_000n; // 0,3 HBAR
const PLANO = [
  'fixar',
  'saldo_fornecedor',
  'a1.criar',
  'a1.depositar',
  'a1.entregar',
  'a1.gravado',
  'a1.porta',
  'a1.aprovar',
  'a1.sacar',
  'a2.criar',
  'a2.depositar',
  'a2.prazo',
  'a2.devolver',
  'a2.sacar',
];

function args(lista) {
  const o = {};
  for (let i = 0; i < lista.length; i += 2) {
    if (!lista[i]?.startsWith('--')) throw new Falha('argumento_invalido');
    o[lista[i].slice(2)] = lista[i + 1];
  }
  return o;
}

function contexto({ comChaves = true } = {}) {
  const cfg = configuracao();
  autorizado(cfg);
  const art = artefato(raiz);
  const manifesto = ler(path.join(raiz, 'packages/nextjs/lib/deployment.json'));
  if (!manifesto) throw new Falha('deployment_json_null_revise_o_candidato');
  if (manifesto.chainId !== cfg.chainId) throw new Falha('deployment_json_de_outra_rede');
  if (manifesto.runtimeCodeHash !== art.runtimeCodeHash) throw new Falha('deployment_json_de_outro_codigo');
  // Transmitir não precisa de chave: a transação já está assinada na reserva.
  if (!comChaves) return { cfg, art, manifesto, chaves: null, contas: null, chamar: rpc(cfg.rpc) };
  const kc = chave('DELIVERPROOF_TESTNET_PRIVATE_KEY');
  const kf = chave('DELIVERPROOF_FORNECEDOR_PRIVATE_KEY');
  const comprador = privateKeyToAccount(kc).address;
  const fornecedor = privateKeyToAccount(kf).address;
  if (comprador.toLowerCase() === fornecedor.toLowerCase()) throw new Falha('comprador_e_fornecedor_iguais');
  return {
    cfg,
    art,
    manifesto,
    chaves: { comprador: kc, fornecedor: kf },
    contas: { comprador, fornecedor },
    chamar: rpc(cfg.rpc),
  };
}

async function conferirRede(c) {
  if (numero(await c.chamar('eth_chainId')) !== BigInt(c.cfg.chainId)) throw new Falha('rede_errada');
  // Nunca mandar valor para um endereço que não é o contrato revisado.
  const codigo = await c.chamar('eth_getCode', [c.manifesto.address, 'latest']);
  if (!codigo || codigo === '0x' || keccak256(codigo) !== c.manifesto.runtimeCodeHash)
    throw new Falha('codigo_no_endereco_nao_confere');
}

const ler_ = async (c, functionName, args) =>
  decodeFunctionResult({
    abi: c.art.abi,
    functionName,
    data: await c.chamar('eth_call', [
      { to: c.manifesto.address, data: encodeFunctionData({ abi: c.art.abi, functionName, args }) },
      'latest',
    ]),
  });
const blocoAgora = async c => numero((await c.chamar('eth_getBlockByNumber', ['latest', false])).timestamp);

/**
 * Provas anteriores ainda abertas. Cada prova tem um provaId (linhagem); retomadas mantêm o mesmo id.
 * Só conta o estado MAIS RECENTE de cada linhagem, entre todos os artefatos (01..10, 99, de todas as execuções):
 * snapshots intermediários de uma prova que depois concluiu não bloqueiam; prova realmente aberta bloqueia.
 */
export function linhagensAbertas(dir) {
  if (!dir) return [];
  if (!existsSync(dir)) throw new Falha('pasta_de_anteriores_ausente');
  const achadas = [];
  const andar = d => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) andar(p);
      else if (n === 'prova-estado.json') achadas.push(ler(p));
    }
  };
  andar(dir);
  const ultimo = new Map();
  for (const e of achadas) {
    if (typeof e.provaId !== 'string' || !e.atualizadoEm) throw new Falha('estado_anterior_sem_linhagem');
    const u = ultimo.get(e.provaId);
    if (!u || Date.parse(e.atualizadoEm) > Date.parse(u.atualizadoEm)) ultimo.set(e.provaId, e);
  }
  return [...ultimo.values()].filter(e => e.situacao !== 'concluida');
}

async function carregarOuCriar(c, o) {
  if (!o.estado) throw new Falha('estado_obrigatorio');
  if (existsSync(o.estado)) {
    const e = ler(o.estado);
    if (
      e.versao !== 1 ||
      e.chainId !== c.cfg.chainId ||
      e.contrato.toLowerCase() !== c.manifesto.address.toLowerCase() ||
      e.comprador.toLowerCase() !== c.contas.comprador.toLowerCase() ||
      e.fornecedor.toLowerCase() !== c.contas.fornecedor.toLowerCase()
    )
      throw new Falha('estado_de_outro_contrato_ou_outras_contas');
    return e;
  }
  const pendentes = linhagensAbertas(o.anteriores);
  if (pendentes.length) throw new Falha('prova_anterior_nao_concluida_retome_aquela');
  const entrega = await montarEntrega(TEXTO(c.cfg.nome === 'testnet' ? 'hedera-testnet-296' : 'local-31337'));
  writeFileSync(o.estado.replace(/\.json$/, '') + '.car', entrega.car);
  const e = {
    versao: 1,
    provaId: randomUUID(),
    rede: c.cfg.nome,
    chainId: c.cfg.chainId,
    contrato: c.manifesto.address,
    comprador: c.contas.comprador,
    fornecedor: c.contas.fornecedor,
    origem: origem(raiz),
    iniciadaEm: new Date().toISOString(),
    execucoes: [],
    situacao: 'em_andamento',
    arquivo: {
      cid: entrega.cid,
      sha256: entrega.sha256,
      bytes: entrega.bytes,
      mediaType: 1,
      texto: TEXTO(c.cfg.nome === 'testnet' ? 'hedera-testnet-296' : 'local-31337'),
    },
    acordos: {},
    etapas: {},
  };
  salvar(o.estado, e, { exclusivo: true });
  return e;
}

const hashesDe = et => [et.txHash, ...(et.anteriores ?? []).map(a => a.txHash)].filter(Boolean);
const tentativaAtual = et => ({
  autorizacao: et.autorizacao,
  txHash: et.txHash,
  para: et.para,
  valor: et.valor,
  args: et.args,
  reservadaEm: et.reservadaEm,
  execucao: et.execucao,
});

/** Efeito de um recibo confirmado no estado público. Vale a tentativa que entrou, seja a atual ou uma anterior. */
function aplicar(c, e, id, recibo, hash) {
  const et = e.etapas[id];
  if (hash.toLowerCase() !== et.txHash?.toLowerCase()) {
    const entrou = (et.anteriores ?? []).find(a => a.txHash.toLowerCase() === hash.toLowerCase());
    if (!entrou) throw new Falha('recibo_de_tentativa_desconhecida');
    et.anteriores = [...et.anteriores.filter(a => a !== entrou), ...(et.txHash ? [tentativaAtual(et)] : [])];
    Object.assign(et, entrou);
  }
  et.estado = 'confirmada';
  et.bloco = numero(recibo.blockNumber).toString();
  delete et.txBruta; // já está na rede; o estado final fica menor
  delete et.dados;
  if (id.endsWith('.criar')) {
    const ev = parseEventLogs({ abi: c.art.abi, logs: recibo.logs, eventName: 'Created' }).filter(
      l => l.address.toLowerCase() === c.manifesto.address.toLowerCase(),
    );
    if (ev.length !== 1) throw new Falha('recibo_de_criacao_sem_evento_created');
    e.acordos[id.slice(0, 2)] = { ...(e.acordos[id.slice(0, 2)] ?? {}), id: ev[0].args.id.toString() };
  }
}

/**
 * Reconcilia, só por leitura, cada etapa com tentativas em aberto, olhando TODAS as tentativas (mesmo nonce).
 * Exatamente um recibo é aplicado. Nonce, conta e tentativas são preservados: reassinar só com o mesmo nonce.
 */
async function reconciliar(c, e, o) {
  const subst = substituicoes(o.substituidas);
  for (const [id, et] of Object.entries(e.etapas)) {
    if (!['reservada', 'pendente'].includes(et.estado) || et.nonce === undefined) continue;
    const hashes = hashesDe(et);
    const ultima = [et.reservadaEm, ...(et.anteriores ?? []).map(a => a.reservadaEm)].filter(Boolean).sort().at(-1);
    let s = await situacao(
      c.chamar,
      { hashes, de: et.de, nonce: et.nonce, reservadaEm: ultima },
      { janelaMs: c.cfg.janelaMs },
    );
    const pedida = hashes.find(h => subst.has(h.toLowerCase()));
    if (s.estado === 'nonce_avancou_sem_recibo' && pedida) {
      // Outra transação da conta usou o nonce (comprovada na rede): nenhuma tentativa desta etapa entra mais.
      await comprovarSubstituicao(
        c.chamar,
        { hash: pedida, de: et.de, nonce: et.nonce },
        subst.get(pedida.toLowerCase()),
      );
      s = { estado: 'nonce_liberado' };
    }
    linha({
      etapa: id,
      reconciliacao: s.estado,
      nonce: et.nonce,
      tentativas: hashes.length,
      ...(s.hash ? { txHash: s.hash } : {}),
    });
    if (s.estado === 'confirmada') aplicar(c, e, id, s.recibo, s.hash);
    else if (s.estado === 'revertida') {
      et.estado = 'revertida';
      e.situacao = 'parada_revertida';
      salvar(o.estado, e);
      throw new Falha('etapa_revertida_na_rede');
    } else if (s.estado === 'sem_recibo_janela_vencida') {
      if (et.estado === 'reservada')
        e.etapas[id] = {
          estado: 'pendente',
          conta: et.conta,
          de: et.de,
          nonce: et.nonce,
          anteriores: [...(et.anteriores ?? []), tentativaAtual(et)],
        };
    } else if (s.estado === 'nonce_liberado') {
      e.etapas[id] = {
        estado: 'pendente',
        conta: et.conta,
        substituidas: [
          ...(et.substituidas ?? []),
          { de: et.de, nonce: et.nonce, hashes, por: subst.get(pedida.toLowerCase()) },
        ],
      };
    } else {
      salvar(o.estado, e);
      throw new Falha(`reconciliacao_inconclusiva:${s.estado}`);
    }
    salvar(o.estado, e);
  }
}

async function reservar(c, e, o, id, quem, { to, data, value, publicoArgs, gasMinimo = 0n }) {
  const prev = e.etapas[id] ?? {};
  const de = c.contas[quem];
  if (prev.de && prev.de.toLowerCase() !== de.toLowerCase()) throw new Falha('etapa_de_outra_conta');
  // Tentativa nova de uma etapa já tentada: o MESMO nonce, sempre. Se ele mudou, alguma tentativa entrou (ou outra
  // transação): para aqui, e a próxima reconciliação aplica o recibo certo. Nunca N+1 para a mesma etapa.
  const nonce =
    prev.nonce !== undefined ? BigInt(prev.nonce) : numero(await c.chamar('eth_getTransactionCount', [de, 'latest']));
  await conferirNonce(c.chamar, de, nonce);
  const a = await assinar(c.chamar, c.chaves[quem], { chainId: c.cfg.chainId, nonce, to, data, value, gasMinimo });
  e.etapas[id] = {
    estado: 'reservada',
    conta: quem,
    de,
    nonce: nonce.toString(),
    anteriores: prev.anteriores ?? [],
    ...(prev.substituidas ? { substituidas: prev.substituidas } : {}),
    para: to,
    valor: value.toString(),
    dados: data,
    args: publicoArgs,
    txHash: a.hash,
    txBruta: a.bruta,
    reservadaEm: new Date().toISOString(),
    execucao: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}` : 'local',
    ...(c.autorizacao ? { autorizacao: c.autorizacao } : {}),
  };
  salvar(o.estado, e);
  linha({
    etapa: id,
    estado: 'reservada',
    de,
    nonce: nonce.toString(),
    txHash: a.hash,
    tentativa: e.etapas[id].anteriores.length + 1,
  });
}

/** Toda gravação do estado marca a hora: a retomada escolhe o estado mais recente. */
function salvar(arquivo, e, opcoes) {
  e.atualizadoEm = new Date().toISOString();
  gravar(arquivo, e, opcoes);
}

const chamada = (c, functionName, args) => encodeFunctionData({ abi: c.art.abi, functionName, args });
const feita = (e, id) => ['confirmada', 'feita', 'dispensada', 'nao_aplicavel'].includes(e.etapas[id]?.estado);

/** Faz as ações sem transação e reserva a próxima transação. Devolve 'reservada' | 'concluida'. */
async function avancar(c, e, o) {
  for (const id of PLANO) {
    if (feita(e, id)) continue;
    if (e.etapas[id]?.estado === 'reservada') return 'reservada';
    const a1 = e.acordos.a1?.id !== undefined ? BigInt(e.acordos.a1.id) : null;
    const a2 = e.acordos.a2?.id !== undefined ? BigInt(e.acordos.a2.id) : null;
    const entrega = { cid: e.arquivo.cid, sha256: e.arquivo.sha256, bytes: e.arquivo.bytes };
    switch (id) {
      case 'fixar': {
        if (c.cfg.nome === 'testnet' || c.cfg.filebase) {
          const m = await montarEntrega(e.arquivo.texto);
          if (m.cid !== e.arquivo.cid || m.sha256 !== e.arquivo.sha256) throw new Falha('entrega_nao_confere');
          await fixar(c.cfg.filebase, process.env.FILEBASE_TOKEN, m);
          e.etapas.fixar = { estado: 'feita', como: 'filebase dag/import, raiz confirmada' };
        } else e.etapas.fixar = { estado: 'nao_aplicavel', como: 'nó local sem Filebase' };
        break;
      }
      case 'saldo_fornecedor': {
        const saldo = numero(await c.chamar('eth_getBalance', [c.contas.fornecedor, 'latest']));
        if (saldo >= c.cfg.minimoFornecedor) e.etapas[id] = { estado: 'dispensada', saldo: saldo.toString() };
        else {
          // Fornecedor sem saldo ainda não tem conta no Hedera: a transferência cria a conta oca (lazy create).
          // O relay oficial usa 610.000 de gás mínimo nesse caso (MIN_TX_HOLLOW_ACCOUNT_CREATION_GAS em
          // hiero-json-rpc-relay, src/relay/lib/constants.ts; testes estimateGas e sendRawTransaction), mas o hashio
          // estimou 22.828 em 28/09 para um endereço novo. Sem o piso, a criação pode faltar gás e reverter.
          await reservar(c, e, o, id, 'comprador', {
            to: c.contas.fornecedor,
            data: '0x',
            value: c.cfg.saldoFornecedor,
            publicoArgs: [],
            gasMinimo: saldo === 0n ? c.cfg.gasContaOca : 0n,
          });
          return 'reservada';
        }
        break;
      }
      case 'a1.criar':
      case 'a2.criar': {
        const t = await blocoAgora(c);
        const [valor, termos, prazos] =
          id === 'a1.criar' ? [VALOR1, TERMOS1, [1800n, 3600n]] : [VALOR2, TERMOS2, [60n, 120n]];
        const argsC = [c.contas.fornecedor, valor, t + prazos[0], t + prazos[1], keccak256(stringToHex(termos))];
        e.acordos[id.slice(0, 2)] = { termos, valorTinybar: valor.toString() };
        await reservar(c, e, o, id, 'comprador', {
          to: c.manifesto.address,
          data: chamada(c, 'createAgreement', argsC),
          value: 0n,
          publicoArgs: argsC.map(String),
        });
        return 'reservada';
      }
      case 'a1.depositar':
      case 'a2.depositar': {
        const [idA, valor] = id === 'a1.depositar' ? [a1, VALOR1] : [a2, VALOR2];
        await reservar(c, e, o, id, 'comprador', {
          to: c.manifesto.address,
          data: chamada(c, 'fund', [idA]),
          value: c.cfg.paraRpc(valor),
          publicoArgs: [idA.toString()],
        });
        return 'reservada';
      }
      case 'a1.entregar': {
        const argsE = [a1, entrega.cid, entrega.sha256, BigInt(entrega.bytes), 1];
        await reservar(c, e, o, id, 'fornecedor', {
          to: c.manifesto.address,
          data: chamada(c, 'submit', argsE),
          value: 0n,
          publicoArgs: argsE.map(String),
        });
        return 'reservada';
      }
      case 'a1.gravado': {
        const g = await ler_(c, 'getAgreement', [a1]);
        if (g.cid !== entrega.cid || g.fileSha256 !== entrega.sha256 || g.fileSize !== BigInt(entrega.bytes))
          throw new Falha('contrato_gravou_outra_entrega');
        e.etapas[id] = { estado: 'feita', commitment: g.commitment };
        break;
      }
      case 'a1.porta': {
        if (!c.cfg.gateway) throw new Falha('porta_publica_nao_configurada');
        const r = await conferirPorta(c.cfg.gateway, entrega, c.cfg.porta);
        e.etapas[id] = {
          estado: r.conferido ? 'feita' : 'pendente',
          tentativas: [...(e.etapas[id]?.tentativas ?? []), { em: new Date().toISOString(), ...r }],
        };
        if (!r.conferido) {
          // Não aprova sem os bytes conferidos. Estado preservado: retomar depois com o mesmo fornecedor e o mesmo acordo.
          e.situacao = 'aguardando_porta_publica';
          salvar(o.estado, e);
          linha({ etapa: id, estado: 'nao_conferida', motivos: r.motivos, acao: 'retomar_depois' });
          return 'aguardando';
        }
        e.situacao = 'em_andamento';
        break;
      }
      case 'a1.aprovar': {
        const commitment = e.etapas['a1.gravado'].commitment;
        await reservar(c, e, o, id, 'comprador', {
          to: c.manifesto.address,
          data: chamada(c, 'approve', [a1, commitment]),
          value: 0n,
          publicoArgs: [a1.toString(), commitment],
        });
        return 'reservada';
      }
      case 'a1.sacar':
        await reservar(c, e, o, id, 'fornecedor', {
          to: c.manifesto.address,
          data: chamada(c, 'withdraw', [a1]),
          value: 0n,
          publicoArgs: [a1.toString()],
        });
        return 'reservada';
      case 'a2.prazo': {
        const prazo = (await ler_(c, 'getAgreement', [a2])).reviewDeadline;
        if (c.cfg.nome === 'local') {
          await c.chamar('evm_increaseTime', [180]);
          await c.chamar('evm_mine', []);
        } else {
          const fim = Date.now() + 600_000;
          while ((await blocoAgora(c)) <= prazo) {
            if (Date.now() > fim) {
              e.situacao = 'aguardando_prazo';
              salvar(o.estado, e);
              return 'aguardando';
            }
            await new Promise(ok => setTimeout(ok, 5_000));
          }
        }
        if ((await blocoAgora(c)) <= prazo) throw new Falha('prazo_nao_venceu');
        e.etapas[id] = { estado: 'feita', reviewDeadline: prazo.toString() };
        e.situacao = 'em_andamento';
        break;
      }
      case 'a2.devolver':
        await reservar(c, e, o, id, 'comprador', {
          to: c.manifesto.address,
          data: chamada(c, 'refund', [a2]),
          value: 0n,
          publicoArgs: [a2.toString()],
        });
        return 'reservada';
      case 'a2.sacar':
        await reservar(c, e, o, id, 'comprador', {
          to: c.manifesto.address,
          data: chamada(c, 'withdraw', [a2]),
          value: 0n,
          publicoArgs: [a2.toString()],
        });
        return 'reservada';
    }
    salvar(o.estado, e);
  }
  e.situacao = 'concluida';
  e.concluidaEm = new Date().toISOString();
  salvar(o.estado, e);
  linha({ etapa: 'fim', acordos: [e.acordos.a1?.id, e.acordos.a2?.id], cid: e.arquivo.cid });
  return 'concluida';
}

async function preparar(o, c = contexto()) {
  primeiraTentativa();
  // Identidades e autorização presas ao registro revisado (obrigatório na testnet; no nó local, se informado).
  if (c.cfg.nome === 'testnet' || o.registro) {
    const r = lerRegistro(o.registro);
    conferirIdentidade(r, 'comprador', c.contas.comprador, o.autorizacao);
    conferirIdentidade(r, 'fornecedor', c.contas.fornecedor, o.autorizacao);
    c.autorizacao = o.autorizacao;
  }
  await conferirRede(c);
  const e = await carregarOuCriar(c, o);
  e.execucoes = [
    ...(e.execucoes ?? []),
    { em: new Date().toISOString(), execucao: process.env.GITHUB_RUN_ID ?? 'local', acao: 'preparar' },
  ].slice(-50);
  if (e.situacao === 'concluida') {
    linha({ etapa: 'nada_a_fazer', situacao: 'concluida' });
    return 'concluida';
  }
  await reconciliar(c, e, o);
  const r = await avancar(c, e, o);
  if (r === 'aguardando') process.exitCode = 4;
  return r;
}

async function transmitirEtapa(o, c = contexto({ comChaves: false })) {
  if (!existsSync(o.estado ?? '')) throw new Falha('estado_obrigatorio');
  const e = ler(o.estado);
  const reservadas = Object.entries(e.etapas).filter(([, et]) => et.estado === 'reservada');
  if (reservadas.length === 0) {
    linha({ etapa: 'nada_a_transmitir', situacao: e.situacao });
    return 'nada';
  }
  if (reservadas.length > 1) throw new Falha('mais_de_uma_reserva');
  await conferirRede(c);
  const [id, et] = reservadas[0];
  if (keccak256(et.txBruta) !== et.txHash) throw new Falha('reserva_hash_nao_confere');
  await conferirBruta(et.txBruta, {
    de: et.de,
    chainId: c.cfg.chainId,
    nonce: et.nonce,
    to: et.para,
    data: et.dados,
    value: BigInt(et.valor),
  });
  if (et.de.toLowerCase() !== e[et.conta]?.toLowerCase()) throw new Falha('reserva_de_outra_conta');
  await conferirNonce(c.chamar, et.de, et.nonce); // mudou desde a reserva: não transmite
  linha({ etapa: id, estado: 'transmitindo', txHash: et.txHash, nonce: et.nonce });
  const { envio, recibo } = await transmitir(c.chamar, et.txBruta, et.txHash, c.cfg);
  if (!recibo) {
    et.envio = envio;
    salvar(o.estado, e);
    linha({
      etapa: id,
      estado: 'resultado_desconhecido',
      txHash: et.txHash,
      envio,
      acao: 'nao_reenviar_retomar_reconcilia',
    });
    process.exitCode = 3;
    return 'desconhecido';
  }
  if (numero(recibo.status) !== 1n) {
    et.estado = 'revertida';
    e.situacao = 'parada_revertida';
    salvar(o.estado, e);
    throw new Falha('etapa_revertida_na_rede');
  }
  aplicar(c, e, id, recibo, et.txHash);
  salvar(o.estado, e);
  linha({ etapa: id, estado: 'confirmada', txHash: et.txHash, bloco: e.etapas[id].bloco });
  return 'confirmada';
}

async function executar(o) {
  const c = contexto();
  for (let i = 0; i < 40; i++) {
    const p = await preparar(o, c);
    if (p !== 'reservada') return;
    const t = await transmitirEtapa(o, c);
    if (t !== 'confirmada') return;
  }
  throw new Falha('passos_demais');
}

const [cmd, ...resto] = process.argv.slice(2);
const acoes = { preparar, transmitir: transmitirEtapa, executar };
if (!acoes[cmd]) {
  console.error('uso: prova.mjs preparar|transmitir|executar --estado prova-estado.json [--anteriores DIR]');
  process.exit(2);
}
Promise.resolve()
  .then(() => acoes[cmd](args(resto)))
  .catch(e => {
    process.stderr.write(JSON.stringify({ etapa: 'erro', ...publico(e) }) + '\n');
    process.exitCode = 1;
  });
