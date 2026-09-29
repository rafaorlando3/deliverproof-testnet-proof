// Implantação do DeliverProof com reserva pública antes da transmissão.
//   preparar    --nonce N --reservas DIR --saida reserva.json
//       Reconcilia (só leitura) todas as reservas anteriores em DIR e para se alguma não estiver resolvida
//       ou se o contrato já foi implantado. Confere chain e nonce (latest e pending = N), assina a criação
//       com o nonce N e grava a reserva: conta, nonce, endereço previsto, hash da transação e a transação
//       assinada (pública). Não transmite. No GitHub, a reserva sobe como artefato antes do passo seguinte.
//   transmitir  --reserva reserva.json
//       Confere a reserva de novo (assinante, nonce, dados) e o nonce na rede; transmite exatamente aquela
//       transação; espera o recibo pelo hash. Falha no envio = resultado desconhecido: não reenvia.
//   reconciliar --reservas DIR
//       Só leitura. Diz a situação de cada reserva; se uma entrou, confere e grava o candidato.
// Duas reservas com o mesmo nonce se excluem: no máximo uma entra, e as duas criam o mesmo contrato
// no mesmo endereço (conta + nonce), com o mesmo código. Nonce diferente só depois de reconciliar.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { getContractAddress, keccak256 } from 'viem';
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
import { lerRegistro, conferirIdentidade } from './lib/registro.mjs';

const raiz = process.cwd();
const DESTINO = path.join(raiz, 'packages/nextjs/lib/deployment.json');
const CANDIDATO = path.join(raiz, 'packages/nextjs/lib/deployment.candidate.json');

function args(lista) {
  const o = { _: [] };
  for (let i = 0; i < lista.length; i++)
    if (lista[i].startsWith('--')) o[lista[i].slice(2)] = lista[++i];
    else o._.push(lista[i]);
  return o;
}

/** Todas as reservas de implantação em DIR (qualquer profundidade), validadas no formato. */
export function lerReservas(dir) {
  if (!dir || !existsSync(dir)) throw new Falha('pasta_de_reservas_ausente');
  const achadas = [];
  const andar = d => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) andar(p);
      else if (n === 'reserva-implantacao.json') achadas.push(ler(p));
    }
  };
  andar(dir);
  for (const r of achadas)
    if (
      r.tipo !== 'implantacao' ||
      r.versao !== 1 ||
      !/^0x[0-9a-f]{64}$/i.test(r.txHash) ||
      !/^0x[0-9a-f]{40}$/i.test(r.conta)
    )
      throw new Falha('reserva_em_formato_desconhecido');
  return achadas;
}

async function reconciliarTodas(chamar, cfg, art, reservas, subst = new Map()) {
  const out = [];
  for (const r of reservas) {
    if (r.chainId !== cfg.chainId || r.bytecodeHash !== art.bytecodeHash) {
      out.push({ reserva: r, estado: 'outro_contexto' });
      continue;
    }
    const s = await situacao(
      chamar,
      { hashes: [r.txHash], de: r.conta, nonce: r.nonce, reservadaEm: r.reservadaEm },
      { janelaMs: cfg.janelaMs },
    );
    // Nonce avançou sem recibo desta: só fica resolvida com a outra transação daquele nonce comprovada na rede.
    if (s.estado === 'nonce_avancou_sem_recibo' && subst.has(r.txHash.toLowerCase())) {
      await comprovarSubstituicao(
        chamar,
        { hash: r.txHash, de: r.conta, nonce: r.nonce },
        subst.get(r.txHash.toLowerCase()),
      );
      out.push({ reserva: r, estado: 'substituida_comprovada' });
    } else out.push({ reserva: r, ...s });
  }
  // Outra reserva da mesma conta com o mesmo nonce já entrou (com recibo): esta nunca entra.
  for (const a of out)
    if (
      a.estado === 'nonce_avancou_sem_recibo' &&
      out.some(
        b =>
          ['confirmada', 'revertida'].includes(b.estado) &&
          b.reserva.conta.toLowerCase() === a.reserva.conta.toLowerCase() &&
          b.reserva.nonce === a.reserva.nonce,
      )
    )
      a.estado = 'substituida_por_outra_reserva';
  return out;
}

async function candidato(chamar, cfg, art, r, recibo) {
  // As mesmas conferências do deploy.cjs do template, com a transação da reserva.
  const endereco = getContractAddress({ from: r.conta, nonce: BigInt(r.nonce) });
  const tx = await chamar('eth_getTransactionByHash', [r.txHash]);
  const bloco = await chamar('eth_getBlockByNumber', [recibo.blockNumber, false]);
  const codigo = await chamar('eth_getCode', [endereco, recibo.blockNumber]);
  if (
    numero(recibo.status) !== 1n ||
    recibo.to !== null ||
    recibo.contractAddress?.toLowerCase() !== endereco.toLowerCase() ||
    endereco.toLowerCase() !== r.enderecoPrevisto.toLowerCase() ||
    recibo.from?.toLowerCase() !== r.conta.toLowerCase() ||
    recibo.transactionHash?.toLowerCase() !== r.txHash.toLowerCase() ||
    !tx ||
    tx.to !== null ||
    numero(tx.nonce) !== BigInt(r.nonce) ||
    numero(tx.value) !== 0n ||
    keccak256(tx.input) !== art.bytecodeHash ||
    !bloco ||
    bloco.hash !== recibo.blockHash ||
    keccak256(codigo) !== art.runtimeCodeHash
  )
    throw new Falha('implantacao_nao_confere');
  const manifesto = {
    chainId: cfg.chainId,
    address: endereco,
    deployer: r.conta,
    deploymentTx: r.txHash,
    deploymentBlock: numero(recibo.blockNumber).toString(),
    runtimeCodeHash: art.runtimeCodeHash,
  };
  if (existsSync(CANDIDATO)) {
    const atual = ler(CANDIDATO);
    if (JSON.stringify(atual) !== JSON.stringify(manifesto)) throw new Falha('candidato_existente_diferente');
  } else gravar(CANDIDATO, manifesto, { exclusivo: true });
  return manifesto;
}

async function preparar(o) {
  const cfg = configuracao();
  primeiraTentativa();
  autorizado(cfg);
  const k = chave('DELIVERPROOF_TESTNET_PRIVATE_KEY');
  const { privateKeyToAccount } = await import('viem/accounts');
  const conta = privateKeyToAccount(k).address;
  // Identidade e autorização presas ao registro revisado, antes de tudo (obrigatório na testnet; no local, se informado).
  if (cfg.nome === 'testnet' || o.registro)
    conferirIdentidade(lerRegistro(o.registro), 'comprador', conta, o.autorizacao);
  if (!/^\d+$/.test(o.nonce ?? '')) throw new Falha('nonce_esperado_obrigatorio');
  if (!o.saida) throw new Falha('saida_obrigatoria');
  if (ler(DESTINO) !== null) throw new Falha('deployment_json_ja_configurado');
  const art = artefato(raiz);
  const org = origem(raiz);
  const chamar = rpc(cfg.rpc);
  if (numero(await chamar('eth_chainId')) !== BigInt(cfg.chainId)) throw new Falha('rede_errada');

  const anteriores = await reconciliarTodas(chamar, cfg, art, lerReservas(o.reservas), substituicoes(o.substituidas));
  for (const a of anteriores)
    linha({ etapa: 'reserva_anterior', txHash: a.reserva.txHash, nonce: a.reserva.nonce, estado: a.estado });
  if (anteriores.some(a => a.estado === 'confirmada')) throw new Falha('ja_implantado_rode_reconciliar');
  const bloqueio = anteriores.find(
    a =>
      ![
        'revertida',
        'sem_recibo_janela_vencida',
        'outro_contexto',
        'substituida_comprovada',
        'substituida_por_outra_reserva',
      ].includes(a.estado),
  );
  if (bloqueio) throw new Falha(`reserva_anterior_nao_resolvida:${bloqueio.estado}`);

  const nonce = BigInt(o.nonce);
  // Reassinar só com o MESMO nonce de uma reserva sem recibo: as duas se excluem na rede (a antiga pode entrar depois).
  const naoChegou = anteriores.filter(a => a.estado === 'sem_recibo_janela_vencida');
  if (naoChegou.some(a => BigInt(a.reserva.nonce) !== nonce || a.reserva.conta.toLowerCase() !== conta.toLowerCase()))
    throw new Falha('nonce_diferente_de_reserva_sem_recibo');
  await conferirNonce(chamar, conta, nonce);
  const assinada = await assinar(chamar, k, { chainId: cfg.chainId, nonce, to: null, data: art.bytecode, value: 0n });
  const reserva = {
    tipo: 'implantacao',
    versao: 1,
    reservadaEm: new Date().toISOString(),
    execucao: process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_RUN_ID}.${process.env.GITHUB_RUN_ATTEMPT}` : 'local',
    origem: org,
    chainId: cfg.chainId,
    conta,
    nonce: nonce.toString(),
    enderecoPrevisto: getContractAddress({ from: conta, nonce }),
    bytecodeHash: art.bytecodeHash,
    runtimeCodeHash: art.runtimeCodeHash,
    txHash: assinada.hash,
    txBruta: assinada.bruta,
    substitui: naoChegou.map(a => a.reserva.txHash),
    ...(o.autorizacao ? { autorizacao: o.autorizacao } : {}),
  };
  gravar(o.saida, reserva, { exclusivo: true });
  linha({
    etapa: 'reservada',
    conta,
    nonce: reserva.nonce,
    enderecoPrevisto: reserva.enderecoPrevisto,
    txHash: reserva.txHash,
  });
}

async function transmitirReserva(o) {
  const cfg = configuracao();
  autorizado(cfg);
  const art = artefato(raiz);
  const r = ler(o.reserva);
  if (r.tipo !== 'implantacao' || r.chainId !== cfg.chainId || r.bytecodeHash !== art.bytecodeHash)
    throw new Falha('reserva_de_outro_contexto');
  if (keccak256(r.txBruta) !== r.txHash) throw new Falha('reserva_hash_nao_confere');
  await conferirBruta(r.txBruta, {
    de: r.conta,
    chainId: cfg.chainId,
    nonce: r.nonce,
    to: null,
    data: art.bytecode,
    value: 0n,
  });
  const chamar = rpc(cfg.rpc);
  if (numero(await chamar('eth_chainId')) !== BigInt(cfg.chainId)) throw new Falha('rede_errada');
  await conferirNonce(chamar, r.conta, r.nonce); // mudou desde a reserva: não transmite
  linha({ etapa: 'transmitindo', txHash: r.txHash, nonce: r.nonce });
  const { envio, recibo } = await transmitir(chamar, r.txBruta, r.txHash, cfg);
  if (!recibo) {
    linha({ etapa: 'resultado_desconhecido', txHash: r.txHash, envio, acao: 'nao_reenviar_rode_reconciliar' });
    process.exitCode = 3;
    return;
  }
  if (numero(recibo.status) !== 1n) throw new Falha('implantacao_revertida');
  const m = await candidato(chamar, cfg, art, r, recibo);
  linha({
    etapa: 'candidato_gravado',
    address: m.address,
    deploymentTx: m.deploymentTx,
    deploymentBlock: m.deploymentBlock,
  });
}

async function reconciliar(o) {
  const cfg = configuracao();
  const art = artefato(raiz);
  const chamar = rpc(cfg.rpc);
  if (numero(await chamar('eth_chainId')) !== BigInt(cfg.chainId)) throw new Falha('rede_errada');
  const todas = await reconciliarTodas(chamar, cfg, art, lerReservas(o.reservas), substituicoes(o.substituidas));
  for (const a of todas)
    linha({ etapa: 'reserva', txHash: a.reserva.txHash, nonce: a.reserva.nonce, estado: a.estado });
  // Reassinar com o mesmo nonce e o mesmo preço gera a MESMA transação (assinatura determinística): conta uma vez.
  const entrou = [
    ...new Map(todas.filter(a => a.estado === 'confirmada').map(a => [a.reserva.txHash.toLowerCase(), a])).values(),
  ];
  if (entrou.length > 1) throw new Falha('mais_de_uma_implantacao_confirmada');
  if (entrou.length === 1) {
    const m = await candidato(chamar, cfg, art, entrou[0].reserva, entrou[0].recibo);
    linha({
      etapa: 'candidato_gravado',
      address: m.address,
      deploymentTx: m.deploymentTx,
      deploymentBlock: m.deploymentBlock,
    });
  } else if (
    todas.some(
      a =>
        ![
          'revertida',
          'sem_recibo_janela_vencida',
          'outro_contexto',
          'substituida_comprovada',
          'substituida_por_outra_reserva',
        ].includes(a.estado),
    )
  )
    process.exitCode = 3;
}

const [cmd, ...resto] = process.argv.slice(2);
const acoes = { preparar, transmitir: transmitirReserva, reconciliar };
if (!acoes[cmd]) {
  console.error('uso: implantar.mjs preparar|transmitir|reconciliar ...');
  process.exit(2);
}
acoes[cmd](args(resto)).catch(e => {
  // Só código fixo e número: nunca mensagem de biblioteca, corpo remoto ou dado assinado.
  process.stderr.write(JSON.stringify({ etapa: 'erro', ...publico(e) }) + '\n');
  process.exitCode = 1;
});
