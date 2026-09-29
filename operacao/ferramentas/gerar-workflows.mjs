// Gera workflows/deploy-testnet.yml e workflows/prova-testnet.yml. `--conferir` falha se os arquivos diferem.
// Ações fixadas por SHA completo, conferido com `git ls-remote` nos repositórios oficiais em 2026-09-28:
//   actions/checkout        refs/tags/v7.0.1 -> 3d3c42e5aac5ba805825da76410c181273ba90b1
//   actions/setup-node      refs/tags/v7.0.0 -> 820762786026740c76f36085b0efc47a31fe5020
//   actions/upload-artifact refs/tags/v7.0.1 -> 043fb46d1a93c77aae656e7c1c64a875d1fc6a0a
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHECKOUT = 'actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1';
const SETUP_NODE = 'actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0';
const UPLOAD = 'actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a # v7.0.1';
const TRANSACOES = 10; // saldo do fornecedor, 5 do acordo 1 e 4 do acordo 2

const comum = `    steps:
      - name: Recusar re-execução (use um novo disparo, com registro revisto e autorização nova)
        run: |
          if [ "$GITHUB_RUN_ATTEMPT" != "1" ]; then
            echo '{"etapa":"erro","codigo":"reexecucao_proibida_use_novo_disparo"}'
            exit 1
          fi
      - uses: ${CHECKOUT}
        with:
          persist-credentials: false
      - uses: ${SETUP_NODE}
        with:
          node-version: 22.22.2
          package-manager-cache: false
      - run: npm ci --ignore-scripts
      - run: npm run hardhat:compile
      - name: Conferir a origem da cópia de prova
        run: node -e 'const o=require("./ORIGEM-PROVA.json"); if(!/^[0-9a-f]{40}$/.test(o.template)||!/^[0-9a-f]{40}$/.test(o.operacao)) process.exit(1); console.log(JSON.stringify(o))'
`;

const deploy = `# Gerado por operacao/ferramentas/gerar-workflows.mjs. Não editar à mão.
# Implantação na testnet com reserva pública ANTES da transmissão. A chave só existe no passo "Preparar".
name: deploy-testnet
on:
  workflow_dispatch:
    inputs:
      confirmar:
        description: Digite DEPLOY-TESTNET
        required: true
      nonce_esperado:
        description: Nonce atual da conta que implanta (conta nova = 0)
        required: true
      autorizacao:
        description: Id da autorização vigente no operacao-registro.json revisado
        required: true
      substituidas:
        description: Só depois de conferir a conta e o nonce. Pares reserva=transação que usou aquele nonce (0x..=0x..)
        required: false
        default: ''
permissions:
  contents: read
  actions: read
  deployments: read
concurrency:
  group: deliverproof-testnet
  cancel-in-progress: false
jobs:
  implantar:
    if: inputs.confirmar == 'DEPLOY-TESTNET'
    runs-on: ubuntu-24.04
    environment: testnet
    timeout-minutes: 30
    env:
      DELIVERPROOF_REDE: testnet
${comum}      - name: Baixar reservas e estados de execuções anteriores (só leitura)
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          bash operacao/baixar-artefatos.sh reserva-implantacao anteriores
          bash operacao/baixar-artefatos.sh prova-estado- anteriores
      - name: Listar as execuções que já entraram no ambiente (só leitura)
        env:
          GH_TOKEN: \${{ github.token }}
        run: bash operacao/listar-execucoes-ambiente.sh testnet execucoes-ambiente.json
      - name: Conferir o registro revisado contra artefatos, ambiente e rede (só leitura)
        env:
          AUTORIZACAO: \${{ inputs.autorizacao }}
        run: node operacao/conferir-registro.mjs --registro operacao-registro.json --anteriores anteriores --autorizacao "$AUTORIZACAO" --execucoes-ambiente execucoes-ambiente.json
      - name: Preparar (reconcilia, confere o nonce, assina; não transmite)
        env:
          DELIVERPROOF_TESTNET_AUTHORIZED: 'yes'
          DELIVERPROOF_TESTNET_PRIVATE_KEY: \${{ secrets.DELIVERPROOF_TESTNET_PRIVATE_KEY }}
          NONCE_ESPERADO: \${{ inputs.nonce_esperado }}
          SUBSTITUIDAS: \${{ inputs.substituidas }}
          AUTORIZACAO: \${{ inputs.autorizacao }}
        run: |
          mkdir -p saida
          node operacao/implantar.mjs preparar --nonce "$NONCE_ESPERADO" --reservas anteriores --substituidas "$SUBSTITUIDAS" --registro operacao-registro.json --autorizacao "$AUTORIZACAO" --saida saida/reserva-implantacao.json
      - name: Guardar a reserva antes de transmitir
        uses: ${UPLOAD}
        with:
          name: reserva-implantacao
          path: saida/reserva-implantacao.json
          if-no-files-found: error
          retention-days: 90
      - name: Transmitir a transação reservada (sem chave)
        env:
          DELIVERPROOF_TESTNET_AUTHORIZED: 'yes'
        run: node operacao/implantar.mjs transmitir --reserva saida/reserva-implantacao.json
      - name: Guardar o candidato
        if: always()
        uses: ${UPLOAD}
        with:
          name: candidato-implantacao
          path: packages/nextjs/lib/deployment.candidate.json
          if-no-files-found: ignore
          retention-days: 90
`;

const chaves = `          DELIVERPROOF_TESTNET_AUTHORIZED: 'yes'
          DELIVERPROOF_TESTNET_PRIVATE_KEY: \${{ secrets.DELIVERPROOF_TESTNET_PRIVATE_KEY }}
          DELIVERPROOF_FORNECEDOR_PRIVATE_KEY: \${{ secrets.DELIVERPROOF_FORNECEDOR_PRIVATE_KEY }}
          FILEBASE_TOKEN: \${{ secrets.FILEBASE_TOKEN }}
          SUBSTITUIDAS: \${{ inputs.substituidas }}
          AUTORIZACAO: \${{ inputs.autorizacao }}
`;
const n2 = i => String(i).padStart(2, '0');
let passos = '';
for (let i = 1; i <= TRANSACOES; i++)
  passos += `      - name: Preparar ${n2(i)} (reconcilia, ações sem transação, reserva a próxima)
        env:
${chaves}        run: node operacao/prova.mjs preparar --estado saida/prova-estado.json --anteriores anteriores --substituidas "$SUBSTITUIDAS" --registro operacao-registro.json --autorizacao "$AUTORIZACAO"
      - name: Guardar o estado ${n2(i)} antes de transmitir
        uses: ${UPLOAD}
        with:
          name: prova-estado-${n2(i)}
          path: saida/
          if-no-files-found: error
          retention-days: 90
      - name: Transmitir ${n2(i)} (sem chave)
        env:
          DELIVERPROOF_TESTNET_AUTHORIZED: 'yes'
        run: node operacao/prova.mjs transmitir --estado saida/prova-estado.json
`;

const prova = `# Gerado por operacao/ferramentas/gerar-workflows.mjs. Não editar à mão.
# Prova com dois acordos. Cada transação: preparar (reserva) -> guardar o estado -> transmitir.
# Para retomar uma prova parada, informe o id da execução em "retomar".
name: prova-testnet
on:
  workflow_dispatch:
    inputs:
      confirmar:
        description: Digite PROVA-TESTNET
        required: true
      autorizacao:
        description: Id da autorização vigente no operacao-registro.json revisado
        required: true
      retomar:
        description: Id da execução a retomar (vazio = prova nova)
        required: false
        default: ''
      substituidas:
        description: Só depois de conferir a conta e o nonce. Pares reserva=transação que usou aquele nonce (0x..=0x..)
        required: false
        default: ''
permissions:
  contents: read
  actions: read
  deployments: read
concurrency:
  group: deliverproof-testnet
  cancel-in-progress: false
jobs:
  provar:
    if: inputs.confirmar == 'PROVA-TESTNET'
    runs-on: ubuntu-24.04
    environment: testnet
    timeout-minutes: 60
    env:
      DELIVERPROOF_REDE: testnet
${comum}      - name: Baixar reservas e estados de execuções anteriores (só leitura)
        env:
          GH_TOKEN: \${{ github.token }}
        run: |
          bash operacao/baixar-artefatos.sh reserva-implantacao anteriores
          bash operacao/baixar-artefatos.sh prova-estado- anteriores
      - name: Listar as execuções que já entraram no ambiente (só leitura)
        env:
          GH_TOKEN: \${{ github.token }}
        run: bash operacao/listar-execucoes-ambiente.sh testnet execucoes-ambiente.json
      - name: Conferir o registro revisado contra artefatos, ambiente e rede (só leitura)
        env:
          AUTORIZACAO: \${{ inputs.autorizacao }}
        run: node operacao/conferir-registro.mjs --registro operacao-registro.json --anteriores anteriores --autorizacao "$AUTORIZACAO" --execucoes-ambiente execucoes-ambiente.json
      - name: Escolher o estado a retomar
        env:
          RETOMAR: \${{ inputs.retomar }}
        run: |
          mkdir -p saida
          node operacao/escolher-estado.mjs --anteriores anteriores --retomar "$RETOMAR" --saida saida/prova-estado.json
${passos}      - name: Preparar final (marca a prova como concluída)
        env:
${chaves}        run: node operacao/prova.mjs preparar --estado saida/prova-estado.json --anteriores anteriores --substituidas "$SUBSTITUIDAS" --registro operacao-registro.json --autorizacao "$AUTORIZACAO"
      - name: Guardar o estado final
        if: always()
        uses: ${UPLOAD}
        with:
          name: prova-estado-99
          path: saida/
          if-no-files-found: ignore
          retention-days: 90
`;

const pasta = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../workflows');
const saidas = { 'deploy-testnet.yml': deploy, 'prova-testnet.yml': prova };
let diferente = false;
for (const [n, t] of Object.entries(saidas)) {
  const f = path.join(pasta, n);
  if (process.argv[2] === '--conferir') {
    let atual = '';
    try {
      atual = readFileSync(f, 'utf8');
    } catch {}
    if (atual !== t) ((diferente = true), console.error(`${n} difere do gerador`));
  } else writeFileSync(f, t);
}
if (diferente) process.exit(1);
