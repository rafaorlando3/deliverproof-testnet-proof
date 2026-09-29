// Ensaio local, na nuvem, da implantação e da prova com falhas injetadas. Roda na raiz de uma cópia de prova,
// com um nó Hardhat próprio em 127.0.0.1:8545. Entre os scripts e o nó fica um proxy (8600) que injeta falhas;
// porta pública falsa (8601) e Filebase falso (8602). Chaves aleatórias desta execução, nunca impressas.
// uso: node operacao/ensaios/ensaio.mjs <pasta-de-saida>
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { encodeEventTopics, keccak256, parseTransaction } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { montarEntrega } from '../lib/ipfs.mjs';

const SAIDA = path.resolve(process.argv[2] ?? 'ensaio-saida');
rmSync(SAIDA, { recursive: true, force: true });
mkdirSync(path.join(SAIDA, 'logs'), { recursive: true });
const MARCADOR = 'MARCADOR-SINTETICO-' + Math.random().toString(36).slice(2, 10);
const NO = 'http://127.0.0.1:8545';
const DEPLOYMENT = 'packages/nextjs/lib/deployment.json';
const CANDIDATO = 'packages/nextjs/lib/deployment.candidate.json';
const resultados = [];
const ok = (nome, cond, extra = {}) => {
  resultados.push({ nome, ok: !!cond, ...extra });
  console.log(`${cond ? 'OK   ' : 'FALHA'} ${nome} ${Object.keys(extra).length ? JSON.stringify(extra) : ''}`);
};
const esperar = ms => new Promise(r => setTimeout(r, ms));

// ---------- nó e utilidades ----------
let id = 0;
async function no(method, params = [], url = NO) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error('no_erro');
  return j.result;
}
async function enviarAssinada(k, to, valor) {
  const conta = privateKeyToAccount(k);
  const nonce = Number(BigInt(await no('eth_getTransactionCount', [conta.address, 'latest'])));
  const bruta = await conta.signTransaction({
    type: 'legacy',
    chainId: 31337,
    nonce,
    gasPrice: BigInt(await no('eth_gasPrice')) * 2n,
    gas: 21000n,
    to,
    value: valor,
  });
  return no('eth_sendRawTransaction', [bruta]);
}
const codigoEm = async a => no('eth_getCode', [a, 'latest']);
/** Quantos acordos o contrato criou (eventos Created), direto no nó. */
async function criacoes() {
  const abi = JSON.parse(
    readFileSync('packages/hardhat/artifacts/contracts/DeliverProof.sol/DeliverProof.json', 'utf8'),
  ).abi;
  const topico = encodeEventTopics({ abi, eventName: 'Created' })[0];
  const m = JSON.parse(readFileSync(DEPLOYMENT, 'utf8'));
  return (await no('eth_getLogs', [{ address: m.address, fromBlock: '0x0', toBlock: 'latest', topics: [topico] }]))
    .length;
}

// ---------- proxy com falhas ----------
let modo = { tipo: 'normal' };
let pedidosProxy = 0;
const proxy = createServer(async (req, res) => {
  pedidosProxy++;
  const partes = [];
  for await (const p of req) partes.push(p);
  const corpo = Buffer.concat(partes).toString();
  let pedido;
  try {
    pedido = JSON.parse(corpo);
  } catch {
    pedido = {};
  }
  const m = modo;
  if (m.tipo === 'marcador' && pedido.method === m.metodo) {
    if (!m.persistente) modo = { tipo: 'normal' };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: pedido.id,
        error: { code: -32000, message: `${MARCADOR} erro remoto com dado sensível` },
      }),
    );
  }
  if (m.tipo === 'html' && pedido.method === m.metodo) {
    if (!m.persistente) modo = { tipo: 'normal' };
    res.writeHead(200, { 'content-type': 'text/html' });
    return res.end(`<html>${MARCADOR}</html>`);
  }
  if (m.tipo === 'descartar-envio' && pedido.method === 'eth_sendRawTransaction') {
    if (!m.persistente) modo = { tipo: 'normal' };
    return req.socket.destroy(); // nunca chegou ao nó
  }
  if (m.tipo === 'grande' && pedido.method === m.metodo) {
    if (!m.persistente) modo = { tipo: 'normal' };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end('{"jsonrpc":"2.0","id":1,"result":"' + 'a'.repeat(5_000_000) + MARCADOR + '"}');
  }
  if (m.tipo === 'redirecionar' && pedido.method === m.metodo) {
    if (!m.persistente) modo = { tipo: 'normal' };
    res.writeHead(302, { location: `http://127.0.0.1:8545/?${MARCADOR}` });
    return res.end();
  }
  if (m.tipo === 'chain-errada' && pedido.method === 'eth_chainId') {
    if (!m.persistente) modo = { tipo: 'normal' };
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: pedido.id, result: '0x1' }));
  }
  if (m.tipo === 'preco-maior' && pedido.method === 'eth_gasPrice') {
    if (!m.persistente) modo = { tipo: 'normal' };
    const pr = BigInt(await no('eth_gasPrice')) + 1_000_000_000n;
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: pedido.id, result: '0x' + pr.toString(16) }));
  }
  if (m.tipo === 'injetar' && pedido.method === m.metodo && ++m.vistas === m.ocorrencia) {
    if (!m.persistente) modo = { tipo: 'normal' };
    m.feito = await no('eth_sendRawTransaction', [m.bruta]); // a tentativa antiga entra bem neste intervalo
  }
  if (m.tipo === 'bump-no-estimate' && pedido.method === 'eth_estimateGas') {
    if (!m.persistente) modo = { tipo: 'normal' };
    m.feito = await enviarAssinada(m.chave, privateKeyToAccount(m.chave).address, 1n);
  }
  const r = await fetch(NO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: corpo });
  const texto = await r.text();
  if (m.tipo === 'perder-resposta' && pedido.method === 'eth_sendRawTransaction') {
    if (!m.persistente) modo = { tipo: 'normal' };
    return req.socket.destroy(); // o nó aceitou; a resposta se perde
  }
  res.writeHead(r.status, { 'content-type': 'application/json' });
  res.end(texto);
});

// ---------- porta pública e Filebase falsos ----------
let entregaCerta = null;
let modoPorta = 'certo';
let pedidosPorta = 0;
const porta = createServer((req, res) => {
  pedidosPorta++;
  if (modoPorta === 'travar') return; // nunca responde
  if (modoPorta === 'html')
    return (res.writeHead(200, { 'content-type': 'text/html' }), res.end(`<html>${MARCADOR}</html>`));
  if (modoPorta === 'marcador404') return (res.writeHead(404, { 'content-type': 'text/plain' }), res.end(MARCADOR));
  const b = Buffer.from(entregaCerta.bytesTexto);
  if (modoPorta === 'errados')
    return (res.writeHead(200, { 'content-type': 'application/vnd.ipld.raw' }), res.end(Buffer.alloc(b.length, 0x41)));
  if (modoPorta === 'grande')
    return (
      res.writeHead(200, { 'content-type': 'application/vnd.ipld.raw' }),
      res.end(Buffer.concat([b, Buffer.alloc(5000, 0x42)]))
    );
  res.writeHead(200, { 'content-type': 'application/vnd.ipld.raw' });
  res.end(b);
});
let modoFilebase = 'certo';
const filebase = createServer(async (req, res) => {
  for await (const _ of req);
  if (modoFilebase === 'marcador500') return (res.writeHead(500, { 'content-type': 'text/plain' }), res.end(MARCADOR));
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ Root: { Cid: { '/': entregaCerta.cid }, PinErrorMsg: '' } }) + '\n');
});

// ---------- execução dos scripts ----------
const K = { comprador: generatePrivateKey(), fornecedor: generatePrivateKey() };
const envBase = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  DELIVERPROOF_REDE: 'local',
  DELIVERPROOF_RPC_LOCAL: 'http://127.0.0.1:8600',
  DELIVERPROOF_GATEWAY_LOCAL: 'http://127.0.0.1:8601',
  DELIVERPROOF_FILEBASE_LOCAL: 'http://127.0.0.1:8602',
  FILEBASE_TOKEN: 'token-local-ficticio',
  DELIVERPROOF_JANELA_MS: '3000',
  DELIVERPROOF_PRAZO_RECIBO_MS: '2000',
  DELIVERPROOF_PORTA_TENTATIVAS: '3',
  DELIVERPROOF_PORTA_ESPERA_MS: '200',
  DELIVERPROOF_PORTA_PRAZO_MS: '1000',
  DELIVERPROOF_PORTA_PRAZO_TOTAL_MS: '4000',
};
let nLog = 0;
function rodar(rotulo, args, { chaves = true, env = {} } = {}) {
  return new Promise(ok_ => {
    const e = {
      ...envBase,
      ...env,
      ...(chaves
        ? { DELIVERPROOF_TESTNET_PRIVATE_KEY: K.comprador, DELIVERPROOF_FORNECEDOR_PRIVATE_KEY: K.fornecedor }
        : {}),
    };
    const inicio = Date.now();
    const p = spawn(process.execPath, args, { env: e });
    let out = '';
    let err = '';
    p.stdout.on('data', d => (out += d));
    p.stderr.on('data', d => (err += d));
    p.on('close', code => {
      const arq = path.join(SAIDA, 'logs', `${String(++nLog).padStart(3, '0')}-${rotulo}.log`);
      writeFileSync(
        arq,
        `$ node ${args.join(' ')}\n[código ${code}, ${Date.now() - inicio} ms]\n--- stdout\n${out}--- stderr\n${err}`,
      );
      const linhas = (out + err)
        .split('\n')
        .filter(Boolean)
        .map(l => {
          try {
            return JSON.parse(l);
          } catch {
            return { texto: l };
          }
        });
      ok_({ code, out, err, linhas, ms: Date.now() - inicio, erro: linhas.find(l => l.etapa === 'erro')?.codigo });
    });
  });
}
const implantar = (rotulo, ...a) => rodar(rotulo, ['operacao/implantar.mjs', ...a]);
const prova = (rotulo, ...a) => rodar(rotulo, ['operacao/prova.mjs', ...a]);

async function preparar() {
  await no('hardhat_reset', []);
  const [rico] = await no('eth_accounts');
  for (const d of [privateKeyToAccount(K.comprador).address])
    await no('eth_sendTransaction', [{ from: rico, to: d, value: '0x56BC75E2D63100000' }]); // 100 ETH
  writeFileSync(DEPLOYMENT, 'null\n');
  rmSync(CANDIDATO, { force: true });
}

// ============ cenários ============
async function cenariosImplantacao() {
  const R = path.join(SAIDA, 'reservas');
  const reserva = n => path.join(R, `r${n}`, 'reserva-implantacao.json');
  mkdirSync(R, { recursive: true });
  const deployer = privateKeyToAccount(K.comprador).address;

  // I-01: erro remoto com marcador no meio da preparação: sai só o código; nada reservado
  modo = { tipo: 'marcador', metodo: 'eth_gasPrice' };
  mkdirSync(path.join(R, 'r1'));
  let r = await implantar('I-01-marcador', 'preparar', '--nonce', '0', '--reservas', R, '--saida', reserva(1));
  ok(
    'I-01 erro remoto com marcador: código rpc_erro -32000, nada reservado',
    r.code === 1 && r.erro === 'rpc_erro' && !existsSync(reserva(1)),
    { erro: r.erro },
  );
  rmSync(path.join(R, 'r1'), { recursive: true });

  // I-02: o nonce muda entre a checagem e a assinatura (outra transação da mesma conta no meio)
  const bump = { tipo: 'bump-no-estimate', chave: K.comprador };
  modo = bump;
  mkdirSync(path.join(R, 'r2'));
  r = await implantar(
    'I-02a-nonce-muda-na-preparacao',
    'preparar',
    '--nonce',
    '0',
    '--reservas',
    R,
    '--saida',
    reserva(2),
  );
  const r2 = JSON.parse(readFileSync(reserva(2), 'utf8'));
  ok(
    'I-02a reserva assinada com o nonce autorizado (0), apesar da outra transação',
    r.code === 0 && r2.nonce === '0' && !!bump.feito,
  );
  r = await rodar('I-02b-transmitir-recusa', ['operacao/implantar.mjs', 'transmitir', '--reserva', reserva(2)], {
    chaves: false,
  });
  ok(
    'I-02b transmitir confere o nonce de novo e não envia',
    r.code === 1 &&
      r.erro === 'nonce_diferente_nao_assinar_nem_transmitir' &&
      !(await no('eth_getTransactionReceipt', [r2.txHash])),
  );
  let rejeitada = false;
  try {
    await no('eth_sendRawTransaction', [r2.txBruta]);
  } catch {
    rejeitada = true;
  }
  ok(
    'I-02c mesmo transmitida por fora, a transação com nonce 0 é recusada: nenhum contrato no endereço previsto',
    rejeitada && (await codigoEm(r2.enderecoPrevisto)) === '0x',
  );
  r = await implantar(
    'I-02d-bloqueia-sem-reconciliar',
    'preparar',
    '--nonce',
    '1',
    '--reservas',
    R,
    '--saida',
    reserva(3),
  );
  ok(
    'I-02d nova preparação bloqueada: nonce avançou sem recibo da reserva anterior',
    r.code === 1 && r.erro === 'reserva_anterior_nao_resolvida:nonce_avancou_sem_recibo' && !existsSync(reserva(3)),
  );
  const falsa = keccak256('0x1234');
  r = await implantar(
    'I-02e-substituta-falsa',
    'preparar',
    '--nonce',
    '1',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${falsa}`,
    '--saida',
    reserva(3),
  );
  ok(
    'I-02e substituta que não existe na rede não resolve',
    r.code === 1 && r.erro === 'substituta_nao_comprova' && !existsSync(reserva(3)),
  );

  // I-03: substituta comprovada; reserva guardada e o runner some ANTES de transmitir
  mkdirSync(path.join(R, 'r3'));
  r = await implantar(
    'I-03a-substituta-comprovada',
    'preparar',
    '--nonce',
    '1',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${bump.feito}`,
    '--saida',
    reserva(3),
  );
  const r3 = JSON.parse(readFileSync(reserva(3), 'utf8'));
  ok(
    'I-03a com a outra transação do nonce 0 comprovada na rede, reserva com nonce 1',
    r.code === 0 && r3.nonce === '1',
  );
  r = await implantar(
    'I-03b-reinicio-dentro-da-janela',
    'preparar',
    '--nonce',
    '1',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${bump.feito}`,
    '--saida',
    path.join(R, 'x.json'),
  );
  ok(
    'I-03b reinício com reserva não transmitida dentro da janela: bloqueia (pendente)',
    r.code === 1 && r.erro === 'reserva_anterior_nao_resolvida:pendente' && !existsSync(path.join(R, 'x.json')),
  );
  await esperar(3200);
  mkdirSync(path.join(R, 'r4'));
  r = await implantar(
    'I-03c-nonce-diferente-recusado',
    'preparar',
    '--nonce',
    '2',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${bump.feito}`,
    '--saida',
    reserva(4),
  );
  ok(
    'I-03c janela vencida: nonce diferente do da reserva sem recibo é recusado',
    r.code === 1 && !existsSync(reserva(4)),
    { erro: r.erro },
  );
  r = await implantar(
    'I-03d-reassina-mesmo-nonce',
    'preparar',
    '--nonce',
    '1',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${bump.feito}`,
    '--saida',
    reserva(4),
  );
  const r4 = JSON.parse(readFileSync(reserva(4), 'utf8'));
  ok(
    'I-03d reassina com o MESMO nonce e registra a que substitui',
    r.code === 0 && r4.nonce === '1' && r4.substitui.includes(r3.txHash) && r4.enderecoPrevisto === r3.enderecoPrevisto,
    { mesmaTransacao: r3.txHash === r4.txHash },
  );

  // I-04: a rede aceita o envio e a resposta se perde; o recibo é achado pelo hash, sem reenvio
  modo = { tipo: 'perder-resposta' };
  r = await rodar('I-04-aceite-e-resposta-perdida', ['operacao/implantar.mjs', 'transmitir', '--reserva', reserva(4)], {
    chaves: false,
  });
  const cand = existsSync(CANDIDATO) ? JSON.parse(readFileSync(CANDIDATO, 'utf8')) : null;
  ok(
    'I-04 envio aceito com resposta perdida: recibo pelo hash e candidato gravado',
    r.code === 0 && cand?.deploymentTx === r4.txHash && r.linhas.some(l => l.etapa === 'candidato_gravado'),
  );

  // I-05: o runner some depois de transmitir, antes de guardar o candidato
  rmSync(CANDIDATO);
  mkdirSync(path.join(R, 'r5'));
  r = await implantar(
    'I-05a-nova-execucao-bloqueada',
    'preparar',
    '--nonce',
    '2',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${bump.feito}`,
    '--saida',
    reserva(5),
  );
  ok(
    'I-05a nova execução acha a reserva confirmada e não reimplanta',
    r.code === 1 && r.erro === 'ja_implantado_rode_reconciliar' && !existsSync(reserva(5)),
  );
  r = await implantar(
    'I-05b-reconciliar',
    'reconciliar',
    '--reservas',
    R,
    '--substituidas',
    `${r2.txHash}=${bump.feito}`,
  );
  const cand2 = JSON.parse(readFileSync(CANDIDATO, 'utf8'));
  ok(
    'I-05b reconciliar (só leitura) regrava o mesmo candidato; a reserva sem recibo fica substituída pela do mesmo nonce',
    r.code === 0 &&
      JSON.stringify(cand2) === JSON.stringify(cand) &&
      r.linhas.some(
        l =>
          l.txHash === r3.txHash &&
          (l.estado === 'substituida_por_outra_reserva' || (l.estado === 'confirmada' && r3.txHash === r4.txHash)),
      ),
    { mesmaTransacao: r3.txHash === r4.txHash },
  );
  let segunda = false;
  try {
    await no('eth_sendRawTransaction', [r3.txBruta]);
  } catch {
    segunda = true;
  }
  const nonceFinal = BigInt(await no('eth_getTransactionCount', [deployer, 'latest']));
  ok(
    'I-05c a reserva sem recibo (mesmo nonce) é recusada se aparecer depois: um só contrato',
    segunda && nonceFinal === 2n,
  );
  return cand;
}

async function cenariosProva() {
  const E = path.join(SAIDA, 'prova');
  mkdirSync(E, { recursive: true });
  const estado = path.join(E, 'prova-estado.json');
  const lerE = () => JSON.parse(readFileSync(estado, 'utf8'));
  const passo = async (rotulo, extra = []) => {
    const p = await prova(`${rotulo}-preparar`, 'preparar', '--estado', estado, ...extra);
    if (p.code !== 0) return { p };
    const t = await rodar(`${rotulo}-transmitir`, ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
      chaves: false,
    });
    return { p, t };
  };

  // P-01: Filebase devolve erro com marcador: só o código e o status
  modoFilebase = 'marcador500';
  let r = await prova('P-01-filebase-marcador', 'preparar', '--estado', estado);
  ok(
    'P-01 Filebase com erro: filebase_http 500, sem transação reservada',
    r.code === 1 && r.erro === 'filebase_http' && !Object.values(lerE().etapas).some(e => e.estado === 'reservada'),
  );
  modoFilebase = 'certo';

  // P-02: saldo do fornecedor, com a resposta do envio perdida (recibo pelo hash)
  let s = await prova('P-02a-preparar', 'preparar', '--estado', estado);
  const gasSaldo = parseTransaction(lerE().etapas.saldo_fornecedor.txBruta).gas;
  ok(
    'P-02a transferência que cria a conta do fornecedor assinada com o piso de 610.000 de gás (conta oca)',
    gasSaldo >= 610_000n,
    { gas: gasSaldo.toString() },
  );
  modo = { tipo: 'perder-resposta' };
  let t = await rodar('P-02b-transmitir-resposta-perdida', ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
    chaves: false,
  });
  ok(
    'P-02 fixação ok; saldo do fornecedor com resposta perdida: confirmado pelo hash',
    s.code === 0 &&
      t.code === 0 &&
      lerE().etapas.fixar.estado === 'feita' &&
      lerE().etapas.saldo_fornecedor.estado === 'confirmada',
  );

  // P-03: OP-01, a tentativa A de "criar" entra DEPOIS de a tentativa B (preço diferente) ter sido reservada.
  s = await prova('P-03a-reserva-A', 'preparar', '--estado', estado);
  const A = lerE().etapas['a1.criar'];
  ok(
    'P-03a controle: chamada comum ao contrato continua com a estimativa, sem o piso',
    parseTransaction(A.txBruta).gas < 610_000n,
    { gas: parseTransaction(A.txBruta).gas.toString() },
  );
  modo = { tipo: 'descartar-envio' };
  t = await rodar('P-03b-transmitir-A-descartada', ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
    chaves: false,
  });
  await esperar(3200);
  modo = { tipo: 'preco-maior' };
  s = await prova('P-03c-reserva-B-mesmo-nonce', 'preparar', '--estado', estado);
  const B = lerE().etapas['a1.criar'];
  ok(
    'P-03c janela vencida: B reservada com o MESMO nonce, hash diferente, A preservada nas tentativas',
    s.code === 0 && B.nonce === A.nonce && B.txHash !== A.txHash && B.anteriores?.some(x => x.txHash === A.txHash),
  );
  modo = { tipo: 'descartar-envio' };
  t = await rodar('P-03d-transmitir-B-descartada', ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
    chaves: false,
  });
  await no('eth_sendRawTransaction', [A.txBruta]); // A (pública no artefato) entra agora, depois de B
  s = await prova('P-03e-reconcilia-A', 'preparar', '--estado', estado);
  const eA = lerE();
  let rejeitadaB = false;
  try {
    await no('eth_sendRawTransaction', [B.txBruta]);
  } catch {
    rejeitadaB = true;
  }
  ok(
    'P-03e reconciliação aplica exatamente o recibo de A; B nunca entra; uma criação só',
    s.code === 0 &&
      eA.etapas['a1.criar'].estado === 'confirmada' &&
      eA.etapas['a1.criar'].txHash === A.txHash &&
      eA.acordos.a1?.id !== undefined &&
      rejeitadaB &&
      (await criacoes()) === 1,
    { criacoes: await criacoes() },
  );

  // depósito descartado antes de chegar ao nó
  s = { code: 0 };
  const dep = lerE().etapas['a1.depositar']; // reservada na preparação P-03e
  modo = { tipo: 'descartar-envio' };
  t = await rodar('P-03c-transmitir-descartado', ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
    chaves: false,
  });
  ok(
    'P-03f envio que não chegou: resultado desconhecido (código 3), sem reenvio',
    t.code === 3 && !(await no('eth_getTransactionReceipt', [dep.txHash])),
  );
  r = await prova('P-03d-reinicio-na-janela', 'preparar', '--estado', estado);
  ok(
    'P-03g reinício dentro da janela: para (pendente), sem nova reserva',
    r.code === 1 &&
      r.erro === 'reconciliacao_inconclusiva:pendente' &&
      lerE().etapas['a1.depositar'].txHash === dep.txHash,
  );
  await esperar(3200);
  ({ p: s, t } = await passo('P-03h-apos-janela'));
  const dep2 = lerE().etapas['a1.depositar'];
  ok(
    'P-03h janela vencida: reassinado com o MESMO nonce e confirmado (mesmo preço: mesma transação)',
    t?.code === 0 &&
      dep2.estado === 'confirmada' &&
      dep2.nonce === dep.nonce &&
      (dep2.txHash === dep.txHash || dep2.anteriores?.some(x => x.txHash === dep.txHash)),
  );

  // P-04: entrega do fornecedor (identidade recuperável) e conferência da gravação
  ({ p: s, t } = await passo('P-04-entregar'));
  ok(
    'P-04 entrega pelo fornecedor confirmada',
    t?.code === 0 && lerE().etapas['a1.entregar'].de === privateKeyToAccount(K.fornecedor).address,
  );

  // P-05: porta pública travada, HTML, bytes errados, resposta grande: não aprova
  for (const m of ['travar', 'html', 'errados', 'grande', 'marcador404']) {
    modoPorta = m;
    const antes = pedidosPorta;
    r = await prova(`P-05-porta-${m}`, 'preparar', '--estado', estado);
    const e = lerE();
    ok(
      `P-05 porta "${m}": não aprova, aguarda (código 4), dentro do prazo total`,
      r.code === 4 && e.situacao === 'aguardando_porta_publica' && !e.etapas['a1.aprovar'] && r.ms < 4000 + 3000,
      {
        ms: r.ms,
        pedidos: pedidosPorta - antes,
        motivos: e.etapas['a1.porta'].tentativas.at(-1).motivos,
      },
    );
  }

  // P-06: porta recuperada: mesmo acordo e mesmo fornecedor, aprovação reservada
  modoPorta = 'certo';
  const idA1 = lerE().acordos.a1.id;
  s = await prova('P-06a-porta-recuperada', 'preparar', '--estado', estado);
  ok(
    'P-06a porta recuperada: bytes conferidos e aprovação do MESMO acordo reservada',
    s.code === 0 &&
      lerE().etapas['a1.porta'].estado === 'feita' &&
      lerE().etapas['a1.aprovar']?.estado === 'reservada' &&
      lerE().acordos.a1.id === idA1,
  );
  t = await rodar('P-06b-aprovar', ['operacao/prova.mjs', 'transmitir', '--estado', estado], { chaves: false });

  // P-07: queda depois da aprovação, antes do saque: o saque reservado não sai; a retomada saca pelo MESMO fornecedor
  s = await prova('P-07a-reserva-saque', 'preparar', '--estado', estado);
  const saque = lerE().etapas['a1.sacar'];
  // (o runner "some" aqui: nada transmitido)
  const antesDaQueda = structuredClone(lerE());
  r = await prova('P-07b-reinicio-na-janela', 'preparar', '--estado', estado);
  ok(
    'P-07b reinício dentro da janela: para, sem reassinar',
    r.code === 1 && r.erro === 'reconciliacao_inconclusiva:pendente',
  );
  await esperar(3200);
  ({ p: s, t } = await passo('P-07c-retomada-saca'));
  const e7 = lerE();
  ok(
    'P-07c retomada: saque do acordo 1 pelo mesmo fornecedor, mesmo nonce',
    antesDaQueda.etapas['a1.aprovar'].estado === 'confirmada' &&
      t?.code === 0 &&
      e7.etapas['a1.sacar'].estado === 'confirmada' &&
      e7.etapas['a1.sacar'].de === saque.de &&
      e7.etapas['a1.sacar'].nonce === saque.nonce,
  );

  // P-08: OP-02, árvore de artefatos como o GitHub baixa: <execução>/prova-estado-NN/prova-estado.json
  const T = path.join(SAIDA, 'arvore');
  const snap = (exec, nn, provaId, situacao, minuto) => {
    const d = path.join(T, exec, `prova-estado-${nn}`);
    mkdirSync(d, { recursive: true });
    writeFileSync(
      path.join(d, 'prova-estado.json'),
      JSON.stringify({
        versao: 1,
        provaId,
        situacao,
        atualizadoEm: `2026-09-28T10:${String(minuto).padStart(2, '0')}:00.000Z`,
        etapas: {},
      }),
    );
  };
  for (let k = 1; k <= 5; k++) snap('100', `0${k}`, 'L1', 'em_andamento', k); // prova L1 parou na execução 100
  for (let k = 1; k <= 3; k++) snap('200', `0${k}`, 'L1', 'em_andamento', 10 + k); // retomada na 200...
  snap('200', '99', 'L1', 'concluida', 20); // ...e concluída lá
  const escolher = (rot, exec) =>
    rodar(
      rot,
      [
        'operacao/escolher-estado.mjs',
        '--anteriores',
        T,
        '--retomar',
        exec,
        '--saida',
        path.join(E, `ret-${exec}.json`),
      ],
      { chaves: false },
    );
  r = await prova(
    'P-08a-prova-nova-apos-concluida',
    'preparar',
    '--estado',
    path.join(E, 'nova.json'),
    '--anteriores',
    T,
  );
  ok(
    'P-08a snapshots intermediários de prova que concluiu em outra execução NÃO bloqueiam prova nova',
    r.code === 0 && existsSync(path.join(E, 'nova.json')),
    { erro: r.erro },
  );
  r = await escolher('P-08b-retomar-concluida', '100');
  ok(
    'P-08b retomar a execução 100 de uma prova já concluída na 200: recusado',
    r.code === 1 && r.erro === 'prova_ja_concluida',
  );
  snap('300', '02', 'L2', 'aguardando_porta_publica', 30); // prova L2 realmente aberta
  r = await prova('P-08c-prova-nova-bloqueada', 'preparar', '--estado', path.join(E, 'nova2.json'), '--anteriores', T);
  ok(
    'P-08c prova realmente aberta continua bloqueando prova nova',
    r.code === 1 && r.erro === 'prova_anterior_nao_concluida_retome_aquela' && !existsSync(path.join(E, 'nova2.json')),
  );
  r = await escolher('P-08d-retomar-aberta', '300');
  ok(
    'P-08d retomar a prova aberta pela execução certa: copiado',
    r.code === 0 && existsSync(path.join(E, 'ret-300.json')),
  );
  snap('400', '01', 'L2', 'aguardando_porta_publica', 40); // retomada mais nova da mesma L2
  r = await escolher('P-08e-retomar-estado-antigo', '300');
  ok(
    'P-08e retomar estado antigo da mesma prova (há um mais novo na 400): recusado',
    r.code === 1 && r.erro === 'existe_estado_mais_recente_na_mesma_prova',
  );

  // P-10: OP-01, a tentativa antiga entra ENTRE a reconciliação e a nova reserva (a2.criar)
  s = await prova('P-10a-reserva-A2', 'preparar', '--estado', estado);
  const A2 = lerE().etapas['a2.criar'];
  modo = { tipo: 'descartar-envio' };
  t = await rodar('P-10b-transmitir-A2-descartada', ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
    chaves: false,
  });
  await esperar(3200);
  const inj = { tipo: 'injetar', metodo: 'eth_getTransactionCount', ocorrencia: 2, vistas: 0, bruta: A2.txBruta };
  modo = inj;
  r = await prova('P-10c-A2-entra-no-intervalo', 'preparar', '--estado', estado);
  const e10 = lerE();
  ok(
    'P-10c A2 entra entre a reconciliação e a nova reserva: para, sem reservar N+1',
    !!inj.feito &&
      r.code === 1 &&
      r.erro === 'nonce_diferente_nao_assinar_nem_transmitir' &&
      e10.etapas['a2.criar'].estado === 'pendente' &&
      (await criacoes()) === 2,
    { erro: r.erro },
  );
  s = await prova('P-10d-reconcilia-A2', 'preparar', '--estado', estado);
  ok(
    'P-10d a reconciliação aplica o recibo de A2 e segue; duas criações no total',
    s.code === 0 &&
      lerE().etapas['a2.criar'].txHash === A2.txHash &&
      lerE().etapas['a2.criar'].estado === 'confirmada' &&
      (await criacoes()) === 2,
  );
  t = await rodar('P-10e-transmitir-deposito-2', ['operacao/prova.mjs', 'transmitir', '--estado', estado], {
    chaves: false,
  });

  // P-09: acordo 2 até o fim, com erro remoto com marcador no meio
  modo = { tipo: 'marcador', metodo: 'eth_estimateGas' };
  r = await prova('P-09a-marcador-na-estimativa', 'preparar', '--estado', estado);
  ok(
    'P-09a erro remoto com marcador na estimativa: rpc_erro, nada reservado',
    r.code === 1 && r.erro === 'rpc_erro' && !Object.values(lerE().etapas).some(e => e.estado === 'reservada'),
  );
  modo = { tipo: 'html', metodo: 'eth_getTransactionCount' };
  r = await prova('P-09b-html-200-na-rpc', 'preparar', '--estado', estado);
  ok(
    'P-09b RPC devolve 200 em HTML: rpc_nao_json, nada reservado',
    r.code === 1 && r.erro === 'rpc_nao_json' && !Object.values(lerE().etapas).some(e => e.estado === 'reservada'),
  );
  for (let i = 0; i < 8 && lerE().situacao !== 'concluida'; i++) await passo(`P-09c-acordo2-${i}`);
  const fim = await prova('P-09d-final', 'preparar', '--estado', estado);
  const ef = lerE();
  ok(
    'P-09d prova concluída: acordo 2 devolvido e sacado',
    ef.situacao === 'concluida' &&
      ef.etapas['a2.sacar'].estado === 'confirmada' &&
      fim.code === 0 &&
      (await criacoes()) === 2,
    { acordos: ef.acordos, criacoes: await criacoes() },
  );
  return ef;
}

// OP-03: registro revisado contra artefatos e rede. OP-04: conferência com rede limitada e parada cedo.
async function cenariosRegistroEConferencia() {
  const { cpSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const sha = f => createHash('sha256').update(readFileSync(f)).digest('hex');
  const RA = path.join(SAIDA, 'registro-anteriores');
  // artefatos como o GitHub baixa: <execução>/<artefato>/<arquivo>
  for (const n of readdirSync(path.join(SAIDA, 'reservas')))
    if (existsSync(path.join(SAIDA, 'reservas', n, 'reserva-implantacao.json')))
      cpSync(
        path.join(SAIDA, 'reservas', n, 'reserva-implantacao.json'),
        path.join(RA, '9001', n, 'reserva-implantacao.json'),
      );
  cpSync(path.join(SAIDA, 'prova', 'prova-estado.json'), path.join(RA, '9002', 'prova-estado-99', 'prova-estado.json'));
  const velho = JSON.parse(readFileSync(path.join(RA, '9002', 'prova-estado-99', 'prova-estado.json'), 'utf8'));
  velho.situacao = 'em_andamento';
  velho.atualizadoEm = '2026-09-28T09:00:00.000Z';
  mkdirSync(path.join(RA, '9002', 'prova-estado-05'), { recursive: true });
  writeFileSync(path.join(RA, '9002', 'prova-estado-05', 'prova-estado.json'), JSON.stringify(velho));
  const arts = ex =>
    Object.fromEntries(
      readdirSync(path.join(RA, ex)).flatMap(n =>
        readdirSync(path.join(RA, ex, n)).map(f => [`${n}/${f}`, sha(path.join(RA, ex, n, f))]),
      ),
    );
  const REG = 'operacao-registro.json';
  const AMB = path.join(SAIDA, 'execucoes-ambiente.json');
  const C = privateKeyToAccount(K.comprador).address;
  const F = privateKeyToAccount(K.fornecedor).address;
  const nC = Number(BigInt(await no('eth_getTransactionCount', [C, 'latest'])));
  const nF = Number(BigInt(await no('eth_getTransactionCount', [F, 'latest'])));
  const execucoes = [
    { id: '9001', autorizacao: 'aut-1', artefatos: arts('9001') },
    { id: '9002', autorizacao: 'aut-2', artefatos: arts('9002') },
  ];
  const base = () => ({
    versao: 2,
    contas: { comprador: C, fornecedor: F },
    nonceRevisado: { [C]: 1, [F]: 0 },
    execucoes: structuredClone(execucoes),
    autorizacao: { id: 'aut-3', nonces: { [C]: nC, [F]: nF } },
  });
  const grava = r => writeFileSync(REG, JSON.stringify(r));
  const conf = (rot, { aut = 'aut-3', amb = ['9001', '9002'] } = {}) => {
    writeFileSync(AMB, JSON.stringify(amb));
    return rodar(
      rot,
      [
        'operacao/conferir-registro.mjs',
        '--registro',
        REG,
        '--anteriores',
        RA,
        '--autorizacao',
        aut,
        '--execucoes-ambiente',
        AMB,
      ],
      { chaves: false },
    );
  };
  const caso = async (rot, prep, esperado, opc) => {
    const r0 = base();
    prep?.(r0);
    grava(r0);
    const r = await conf(rot, opc);
    ok(
      `${rot}: ${esperado ?? 'confere'}`,
      esperado
        ? r.code === 1 && r.erro === esperado
        : r.code === 0 && r.linhas.some(l => l.etapa === 'registro_conferido'),
      { erro: r.erro },
    );
  };
  rmSync(REG, { force: true });
  let r = await conf('R-01-sem-registro');
  ok('R-01-sem-registro: registro_ausente', r.code === 1 && r.erro === 'registro_ausente');
  await caso('R-02-contas-vazias', x => (x.contas = {}), 'registro_contas_ausentes');
  await caso('R-03-registro-valido');
  await caso('R-04-nonce-sem-tentativa', x => (x.nonceRevisado[C] = 0), 'nonce_sem_reserva_conhecida');
  // o último estado some e fica só um anterior da mesma execução, sem nonce consumido
  const ultimo = path.join(RA, '9002', 'prova-estado-99', 'prova-estado.json');
  const guardado = readFileSync(ultimo);
  rmSync(path.join(RA, '9002', 'prova-estado-99'), { recursive: true });
  await caso('R-05a-ultimo-estado-sumiu', null, 'artefato_registrado_ausente');
  mkdirSync(path.join(RA, '9002', 'prova-estado-99'));
  writeFileSync(ultimo, guardado.toString().replace('"concluida"', '"em_andamento"'));
  await caso('R-05b-ultimo-estado-alterado', null, 'artefato_registrado_alterado');
  writeFileSync(ultimo, guardado);
  mkdirSync(path.join(RA, '9003', 'r9'), { recursive: true });
  cpSync(
    path.join(RA, '9001', readdirSync(path.join(RA, '9001'))[0], 'reserva-implantacao.json'),
    path.join(RA, '9003', 'r9', 'reserva-implantacao.json'),
  );
  await caso('R-06-artefato-de-execucao-nao-revisada', null, 'execucao_nao_revisada');
  rmSync(path.join(RA, '9003'), { recursive: true });
  // execução que entrou no ambiente, assinou e sumiu sem consumir nonce (só a implantação do GitHub a revela)
  await caso('R-07a-execucao-do-ambiente-sem-registro', null, 'execucao_no_ambiente_sem_registro', {
    amb: ['9001', '9002', '9004'],
  });
  await caso(
    'R-07b-perdida-revisada-com-a-mesma-autorizacao',
    x =>
      x.execucoes.push({
        id: '9004',
        autorizacao: 'aut-3',
        perdida: true,
        revisao: 'artefatos apagados; nonces conferidos iguais',
      }),
    'autorizacao_ja_usada',
    { amb: ['9001', '9002', '9004'] },
  );
  await caso(
    'R-07c-perdida-revisada-e-nova-autorizacao',
    x => (
      x.execucoes.push({
        id: '9004',
        autorizacao: 'aut-3',
        perdida: true,
        revisao: 'artefatos apagados; nonces conferidos iguais',
      }),
      (x.autorizacao.id = 'aut-4')
    ),
    null,
    { amb: ['9001', '9002', '9004'], aut: 'aut-4' },
  );
  await caso('R-08a-autorizacao-diferente', null, 'autorizacao_diferente_da_vigente', { aut: 'aut-9' });
  await caso(
    'R-08b-nonce-mudou-depois-da-autorizacao',
    x => (x.autorizacao.nonces[C] = nC - 1),
    'autorizacao_desatualizada',
  );
  const comAut = JSON.parse(guardado);
  Object.values(comAut.etapas).find(e => e.txHash).autorizacao = 'aut-3';
  writeFileSync(ultimo, JSON.stringify(comAut));
  await caso(
    'R-08c-artefato-ja-carrega-a-autorizacao-vigente',
    x => (x.execucoes[1].artefatos = arts('9002')),
    'autorizacao_ja_usada',
  );
  writeFileSync(ultimo, guardado);
  // identidade da chave presa ao papel registrado, antes de assinar
  const outro = privateKeyToAccount(generatePrivateKey()).address;
  grava({
    ...base(),
    contas: { comprador: C, fornecedor: outro },
    nonceRevisado: { [C]: 1, [outro]: 0 },
    autorizacao: { id: 'aut-3', nonces: { [C]: nC, [outro]: 0 } },
  });
  r = await prova(
    'R-09a-fornecedor-diferente-do-registro',
    'preparar',
    '--estado',
    path.join(SAIDA, 'prova', 'r09.json'),
    '--registro',
    REG,
    '--autorizacao',
    'aut-3',
  );
  ok(
    'R-09a chave do fornecedor diferente do papel registrado: para antes de assinar',
    r.code === 1 &&
      r.erro === 'conta_diferente_do_registro:fornecedor' &&
      !existsSync(path.join(SAIDA, 'prova', 'r09.json')),
  );
  grava({
    ...base(),
    contas: { comprador: outro, fornecedor: F },
    nonceRevisado: { [outro]: 0, [F]: 0 },
    autorizacao: { id: 'aut-3', nonces: { [outro]: 0, [F]: nF } },
  });
  mkdirSync(path.join(SAIDA, 'r09'), { recursive: true });
  r = await implantar(
    'R-09b-comprador-diferente-do-registro',
    'preparar',
    '--nonce',
    String(nC),
    '--reservas',
    path.join(SAIDA, 'r09'),
    '--registro',
    REG,
    '--autorizacao',
    'aut-3',
    '--saida',
    path.join(SAIDA, 'r09', 'x.json'),
  );
  ok(
    'R-09b chave de implantação diferente do comprador registrado: para antes de assinar',
    r.code === 1 &&
      r.erro === 'conta_diferente_do_registro:comprador' &&
      !existsSync(path.join(SAIDA, 'r09', 'x.json')),
  );
  grava(base());
  r = await prova(
    'R-09c-autorizacao-errada-na-preparacao',
    'preparar',
    '--estado',
    path.join(SAIDA, 'prova', 'r09.json'),
    '--registro',
    REG,
    '--autorizacao',
    'aut-1',
  );
  ok(
    'R-09c preparação com autorização que não é a vigente: para',
    r.code === 1 && r.erro === 'autorizacao_diferente_da_vigente',
  );
  r = await rodar(
    'R-10-registrar-execucao',
    ['operacao/registrar-execucao.mjs', '--anteriores', RA, '--execucao', '9002', '--autorizacao', 'aut-2'],
    { chaves: false },
  );
  ok(
    'R-10 ajuda de revisão imprime os artefatos da execução com sha256 (sem escrever no repositório)',
    r.code === 0 && JSON.parse(r.out).artefatos['prova-estado-99/prova-estado.json'] === sha(ultimo),
  );
  // Re-execução do mesmo run (tentativa 2): o histórico dele ficaria de fora; para antes de coletar ou assinar.
  grava(base());
  const re = { GITHUB_RUN_ID: '300', GITHUB_RUN_ATTEMPT: '2' };
  writeFileSync(AMB, JSON.stringify(['9001', '9002']));
  r = await rodar(
    'R-11a-registro-na-tentativa-2',
    [
      'operacao/conferir-registro.mjs',
      '--registro',
      REG,
      '--anteriores',
      RA,
      '--autorizacao',
      'aut-3',
      '--execucoes-ambiente',
      AMB,
    ],
    { chaves: false, env: re },
  );
  ok(
    'R-11a tentativa 2 do run 300: conferência do registro recusa',
    r.code === 1 && r.erro === 'reexecucao_proibida_use_novo_disparo',
  );
  r = await rodar(
    'R-11b-registro-na-tentativa-1',
    [
      'operacao/conferir-registro.mjs',
      '--registro',
      REG,
      '--anteriores',
      RA,
      '--autorizacao',
      'aut-3',
      '--execucoes-ambiente',
      AMB,
    ],
    { chaves: false, env: { GITHUB_RUN_ID: '301', GITHUB_RUN_ATTEMPT: '1' } },
  );
  ok(
    'R-11b controle: novo disparo (tentativa 1) confere',
    r.code === 0 && r.linhas.some(l => l.etapa === 'registro_conferido'),
  );
  mkdirSync(path.join(SAIDA, 'r11'), { recursive: true });
  r = await rodar(
    'R-11c-implantar-na-tentativa-2',
    [
      'operacao/implantar.mjs',
      'preparar',
      '--nonce',
      String(nC),
      '--reservas',
      path.join(SAIDA, 'r11'),
      '--registro',
      REG,
      '--autorizacao',
      'aut-3',
      '--saida',
      path.join(SAIDA, 'r11', 'x.json'),
    ],
    { env: re },
  );
  ok(
    'R-11c tentativa 2: implantação para antes de assinar',
    r.code === 1 && r.erro === 'reexecucao_proibida_use_novo_disparo' && !existsSync(path.join(SAIDA, 'r11', 'x.json')),
  );
  r = await rodar(
    'R-11d-prova-na-tentativa-2',
    [
      'operacao/prova.mjs',
      'preparar',
      '--estado',
      path.join(SAIDA, 'r11', 'p.json'),
      '--registro',
      REG,
      '--autorizacao',
      'aut-3',
    ],
    { env: re },
  );
  ok(
    'R-11d tentativa 2: prova para antes de assinar',
    r.code === 1 && r.erro === 'reexecucao_proibida_use_novo_disparo' && !existsSync(path.join(SAIDA, 'r11', 'p.json')),
  );
  rmSync(REG, { force: true });

  // OP-04: conferir.ts pelo proxy
  const art = 'packages/hardhat/artifacts/contracts/DeliverProof.sol/DeliverProof.json';
  const conferir = (rot, manifesto, extra = {}) =>
    rodar(
      rot,
      ['node_modules/.bin/vite-node', 'operacao/conferir.ts', manifesto, art, '--acordos', '1,2', '--controle', '999'],
      { chaves: false, env: { DELIVERPROOF_RPC_LOCAL: 'http://127.0.0.1:8600', ...extra } },
    );
  const saidaDe = x => x.linhas.find(l => l.etapa === 'erro' || l.etapa === 'parada')?.codigo;
  for (const [rot, m, esperado] of [
    ['C-01-marcador-no-recibo', { tipo: 'marcador', metodo: 'eth_getTransactionReceipt' }, 'rpc_erro'],
    ['C-02-resposta-grande', { tipo: 'grande', metodo: 'eth_getTransactionReceipt' }, 'resposta_grande_demais'],
    ['C-03-redirecionamento', { tipo: 'redirecionar', metodo: 'eth_getTransactionReceipt' }, 'rpc_transporte'],
  ]) {
    modo = { ...m, persistente: true };
    r = await conferir(rot, DEPLOYMENT);
    modo = { tipo: 'normal' };
    ok(`${rot} conferência: só o código (${esperado}), sem corpo remoto`, r.code === 1 && saidaDe(r) === esperado, {
      codigo: saidaDe(r),
    });
  }
  const invalido = path.join(SAIDA, 'manifesto-invalido.json');
  writeFileSync(
    invalido,
    JSON.stringify({ ...JSON.parse(readFileSync(DEPLOYMENT, 'utf8')), runtimeCodeHash: '0x1234' }),
  );
  let antes = pedidosProxy;
  r = await conferir('C-04-manifesto-invalido', invalido);
  ok(
    'C-04 manifesto inválido: para antes de qualquer leitura de rede',
    r.code === 1 && saidaDe(r) === 'manifesto_invalido' && pedidosProxy === antes,
    { pedidos: pedidosProxy - antes },
  );
  modo = { tipo: 'chain-errada' };
  antes = pedidosProxy;
  r = await conferir('C-05-chain-errada', DEPLOYMENT);
  ok(
    'C-05 chain da RPC diferente: para depois de 1 leitura (eth_chainId)',
    r.code === 1 && saidaDe(r) === 'chain_da_rpc_diferente_do_manifesto' && pedidosProxy - antes === 1,
    { pedidos: pedidosProxy - antes },
  );
  modo = { tipo: 'normal' };
  r = await conferir('C-06-controle-feliz', DEPLOYMENT);
  ok(
    'C-06 controle feliz pelo proxy: TUDO OK; 999 inconclusive: unknown_agreement (revert decodificado, não falha de rede)',
    r.code === 0 && /TUDO OK/.test(r.out) && /inconclusive: unknown_agreement \(esperado\)/.test(r.out),
  );
}

async function ensaioFeliz() {
  await preparar();
  const R = path.join(SAIDA, 'feliz', 'reservas');
  mkdirSync(path.join(R, 'r1'), { recursive: true });
  let r = await implantar(
    'F-01-preparar',
    'preparar',
    '--nonce',
    '0',
    '--reservas',
    R,
    '--saida',
    path.join(R, 'r1', 'reserva-implantacao.json'),
  );
  const t = await rodar(
    'F-02-transmitir',
    ['operacao/implantar.mjs', 'transmitir', '--reserva', path.join(R, 'r1', 'reserva-implantacao.json')],
    { chaves: false },
  );
  ok(
    'F-01 implantação: reserva, transmissão sem chave e candidato',
    r.code === 0 && t.code === 0 && existsSync(CANDIDATO),
  );
  copyFileSync(CANDIDATO, DEPLOYMENT); // revisão do candidato pelo operador
  const estado = path.join(SAIDA, 'feliz', 'prova-estado.json');
  r = await prova('F-03-executar', 'executar', '--estado', estado);
  const e = JSON.parse(readFileSync(estado, 'utf8'));
  ok(
    'F-03 prova completa sem falhas: 10 transações confirmadas',
    r.code === 0 &&
      e.situacao === 'concluida' &&
      Object.values(e.etapas).filter(x => x.estado === 'confirmada').length === 10,
    { acordos: e.acordos },
  );
  const c = await rodar(
    'F-04-conferir',
    [
      'node_modules/.bin/vite-node',
      'operacao/conferir.ts',
      DEPLOYMENT,
      'packages/hardhat/artifacts/contracts/DeliverProof.sol/DeliverProof.json',
      '--acordos',
      `${e.acordos.a1.id},${e.acordos.a2.id}`,
      '--controle',
      '999',
    ].slice(0),
    { chaves: false, env: { DELIVERPROOF_RPC_LOCAL: NO } },
  );
  ok(
    'F-04 conferência independente: dois acordos verified, 999 inconclusive como controle, sem links públicos',
    c.code === 0 && /TUDO OK/.test(c.out) && /sem tabela pública/.test(c.out) && !/hashscan/i.test(c.out),
  );
}

// ============ execução ============
const hh = spawn(path.resolve('node_modules/.bin/hardhat'), ['node'], { cwd: 'packages/hardhat', stdio: 'ignore' }); // saída descartada: contém chaves de desenvolvimento
try {
  for (let i = 0; i < 60; i++) {
    try {
      await no('eth_chainId');
      break;
    } catch {
      await esperar(500);
    }
  }
  await new Promise(r => proxy.listen(8600, '127.0.0.1', r));
  await new Promise(r => porta.listen(8601, '127.0.0.1', r));
  await new Promise(r => filebase.listen(8602, '127.0.0.1', r));
  const texto = 'DeliverProof: entrega sintética pública para a prova na local-31337. Sem dados de clientes.\n';
  const ent = await montarEntrega(texto);
  entregaCerta = { cid: ent.cid, bytesTexto: texto };

  await preparar();
  const cand = await cenariosImplantacao();
  copyFileSync(CANDIDATO, DEPLOYMENT); // revisão do candidato pelo operador
  await cenariosProva();
  await cenariosRegistroEConferencia();
  await ensaioFeliz();

  // Nenhum log, reserva ou estado pode conter o marcador ou as chaves.
  const segredos = [MARCADOR, K.comprador.slice(2).toLowerCase(), K.fornecedor.slice(2).toLowerCase()];
  const vazou = [];
  const andar = d => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) andar(p);
      else {
        const t = readFileSync(p).toString('latin1').toLowerCase();
        segredos.forEach(
          (s, i) =>
            t.includes(s.toLowerCase()) &&
            vazou.push({ arquivo: path.relative(SAIDA, p), segredo: i === 0 ? 'marcador' : 'chave' }),
        );
      }
    }
  };
  andar(SAIDA);
  ok('Z-01 nenhum log, reserva ou estado contém o marcador sintético nem as chaves', vazou.length === 0, {
    vazou: vazou.slice(0, 5),
  });
} finally {
  hh.kill();
  proxy.close();
  porta.closeAllConnections?.();
  porta.close();
  filebase.close();
  const f = resultados.filter(r => !r.ok).length;
  writeFileSync(path.join(SAIDA, 'resultado.json'), JSON.stringify(resultados, null, 1));
  console.log(`FIM: ${resultados.length - f} ok, ${f} falha(s)`);
  process.exitCode = f ? 1 : 0;
  setTimeout(() => process.exit(), 500);
}
