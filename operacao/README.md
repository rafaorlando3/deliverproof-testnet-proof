# DeliverProof: pacote operacional da prova na testnet

Este pacote fica **fora do template distribuído**. O template continua sem orquestração própria e com `deployment.json` null. A prova roda numa **cópia de prova**, gerada a partir de dois SHAs aprovados:

```sh
bash gerar-copia.sh <repo do template> <SHA do template> <repo deste pacote> <SHA deste pacote> <destino>
```

A cópia recebe:

- `operacao/`, com este pacote;
- `.github/workflows/`, com os dois workflows;
- `ORIGEM-PROVA.json`, com os dois SHAs.

O `deployment.json` revisado entra só na cópia, por commit revisado, depois da implantação.

## Como cada transação sai

Toda transação passa por três passos, em ordem:

1. **Preparar.** Reconcilia só por leitura o que ficou pendente. Confere a chain e o nonce da conta (latest e pending). Assina **fora da rede, com o nonce explícito**, calcula o hash da própria transação assinada e grava uma **reserva pública**: conta, nonce, hash e a transação assinada, que é pública e não é chave.
2. **Guardar.** No GitHub, a reserva sobe como artefato **antes** da transmissão.
3. **Transmitir.** Não usa chave. Confere a reserva e o nonce de novo e transmite exatamente aquela transação.
   - Se o envio falhar, o resultado é **desconhecido**, porque a rede pode ter aceitado. Não há reenvio: o recibo é procurado pelo hash até o prazo.

Toda execução nova começa baixando as reservas e os estados das execuções anteriores (token só leitura, `actions: read`), listando as execuções que já entraram no ambiente protegido (implantações do GitHub, `deployments: read`) e conferindo o **registro revisado** (`operacao-registro.json`, versão 2, commitado na cópia; formato em `lib/registro.mjs`). Nada é assinado se qualquer um destes falhar:

- **Papéis:** o registro precisa ter `comprador` e `fornecedor`, e cada preparação confere que a chave usada é a do papel registrado, **antes de assinar**.
- **Autorização única:** a execução recebe `autorizacao`, que precisa ser a vigente no registro. A vigente não pode aparecer em nenhuma execução registrada nem em artefato baixado, e os nonces da rede precisam ser exatamente os da autorização. Se alguém consumiu nonce depois da revisão, para.
- **Artefatos com hash:** cada execução registrada lista os seus artefatos com sha256 (`registrar-execucao.mjs` imprime o trecho, sem escrever no repositório). Se sumiu ou mudou, inclusive o último estado, para. Artefato de execução que não está no registro também para.
- **Ambiente:** toda execução que entrou no ambiente `testnet` precisa estar no registro. Uma execução que assinou e sumiu antes de consumir nonce aparece aqui, mesmo sem artefatos. A revisão pode marcá-la `perdida` (com o motivo), e então é obrigatória uma **nova** autorização: a antiga fica invalidada, porque já aparece como usada.
- **Nonces:** de `nonceRevisado` até o nonce atual, cada um precisa de tentativa conhecida com recibo.
- **Coleta sem falha silenciosa:** cada chamada ao `gh` tem o código conferido antes de o resultado ser usado. Falha, inclusive depois de uma página parcial, nunca vira lista válida nem histórico vazio.
- **Sem re-execução:** o "Re-run" do GitHub mantém o id da execução e esconderia o histórico dela, por isso a tentativa 2 ou mais para no primeiro passo e também nos scripts, antes de coletar ou assinar. Retomar é sempre um **novo disparo**, com o registro revisto e uma autorização nova.

**Bootstrap único:** o primeiro registro tem as duas contas, `execucoes: []`, `nonceRevisado` igual aos nonces da autorização e a autorização `aut-1`. Depois de **cada** execução, qualquer que seja o resultado, quem revisa acrescenta a execução (artefatos com hash, ou `perdida` com o motivo), atualiza os nonces e emite uma autorização nova num commit revisado. Sem isso, a próxima execução não assina. A retenção de 90 dias não é garantia de recuperação. Se uma assinatura perdida (sem artefato) entrar depois, a transação dela tem o mesmo nonce da próxima tentativa: no máximo uma entra, e a reconciliação para em "nonce avançou sem recibo".

Depois, cada reserva ou etapa em aberto é reconciliada pelo hash de **todas** as suas tentativas e pelo nonce:

| Situação                        | O que significa                                                | O que acontece                                                                                                                                                                                                                |
| ------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `confirmada` / `revertida`      | Uma das tentativas tem recibo                                  | Aplica **exatamente esse** recibo                                                                                                                                                                                             |
| `pendente`                      | Sem recibo, nonce parado, dentro da janela (10 min na testnet) | **Para**                                                                                                                                                                                                                      |
| `sem_recibo_janela_vencida`     | Sem recibo, nonce parado, janela vencida                       | Nova tentativa **só com o mesmo nonce**. A tentativa antiga NÃO fica impedida de entrar (a transação assinada não expira e é pública); o nonce igual é o que as exclui. Com o mesmo preço, a reassinatura é a mesma transação |
| `nonce_avancou_sem_recibo`      | Outra transação usou o nonce, ou o recibo atrasou              | **Para**. Só segue com `substituidas=reserva=outra`, com a outra transação daquele nonce conferida na rede (mesma conta, mesmo nonce, hash diferente, com recibo). Aí o nonce é liberado para a etapa                         |
| `substituida_por_outra_reserva` | Outra reserva do mesmo nonce tem recibo                        | Resolvida                                                                                                                                                                                                                     |
| Artefato anterior expirado      | A reserva sumiu                                                | **Para**                                                                                                                                                                                                                      |

Uma etapa guarda conta, nonce e todas as tentativas. A nova tentativa confere o nonce na rede antes de assinar: se uma tentativa antiga entrou nesse intervalo, o nonce mudou, e ela para, sem nunca assinar N+1 para a mesma etapa. A reconciliação seguinte aplica o recibo da que entrou.

Na implantação, as duas reservas de um mesmo nonce criam o mesmo contrato, no mesmo endereço (conta + nonce). Contrato já implantado bloqueia nova implantação. `implantar.mjs reconciliar` (só leitura) grava o candidato com as mesmas conferências do `deploy.cjs` do template.

## Prova (dois acordos)

É uma máquina de estados retomável (`prova.mjs`). Cada transação tem o seu trio preparar, guardar e transmitir no workflow. As etapas:

- **Fixar:** Filebase `dag/import`, com a raiz conferida.
- **Saldo do fornecedor:** só se faltar. Quando o fornecedor ainda não tem conta no Hedera, a transferência cria a conta oca e leva o piso de **610.000 de gás** do relay oficial (`MIN_TX_HOLLOW_ACCOUNT_CREATION_GAS`), porque a estimativa do hashio não inclui essa criação (22.828 medidos em 28/09).
- **Acordo 1:** criar, depositar, entregar e conferir a gravação. Depois, **conferir os bytes pela porta pública**: prazo por pedido, prazo total medido e limite de bytes; HTML, tamanho ou bytes errados não conferem, e **sem isso não aprova**. Então aprovar e sacar (fornecedor).
- **Acordo 2:** criar, depositar, esperar o prazo de revisão, devolver e sacar (comprador).

Porta pública sem os bytes: o estado fica `aguardando_porta_publica` (código 4). A retomada usa o **mesmo acordo e o mesmo fornecedor**.

O fornecedor de teste é uma **identidade recuperável** (`DELIVERPROOF_FORNECEDOR_PRIVATE_KEY`, segredo protegido). Queda depois da aprovação ou gateway atrasado não prendem o saque.

Cada prova tem um `provaId`; as retomadas mantêm o mesmo id. Só conta o estado **mais recente de cada prova**, entre todos os artefatos de todas as execuções. Snapshots intermediários de uma prova que depois concluiu não bloqueiam; prova realmente aberta bloqueia prova nova. Retomar é informar `retomar=<id da execução>`. É recusado retomar uma prova já concluída ou um estado mais velho que outro da mesma prova.

## Trilha HCS suplementar (`hcs-testnet`)

Roda **depois** da prova dos dois acordos concluída e do `deployment.json` revisado. Usa o publicador do template (a partir de `398a0b3`: `buildCreateTopic`, `buildSubmit`, `verifyHcsTrail`, `hcsPending`, `parseHcsMessage`, `mirrorTopicReader`), mas envia pelo runner deste pacote, porque o `sdkTopicWriter` do template deixa o SDK gerar o id da transação.

O id de uma transação Hedera é `conta@validStart`. Por isso cada envio passa por três passos:

1. **Preparar, sem chave** (`hcs.ts preparar`). Resolve pelo mirror toda intenção aberta dos diários anteriores, decide o que falta e fixa cada intenção nova no diário: ação, texto canônico exato, chave pública esperada e o `transactionId` (validStart = agora - 10 s, validade de 120 s). Só usa o id `0.0.N` público da conta.
2. **Guardar.** O diário (`hcs-diario.json`) sobe como artefato `hcs-diario-NN` **antes** de transmitir.
3. **Transmitir, com a chave** (`hcs.ts transmitir`), único passo que recebe `DELIVERPROOF_TESTNET_PRIVATE_KEY`. Confere que a chave do segredo é a chave do diário, monta a transação com o id do diário (`setRegenerateTransactionId(false)`), só envia se faltarem 30 s ou mais de validade, chama `execute` uma vez e grava o desfecho. Não grava bytes assinados. O id é fixo e nunca regenerado, mas isso **não garante uma única chamada de rede**: o SDK pode reenviar a mesma transação a outros nós (até 5 tentativas); a rede deduplica pelo id.

Só o recibo decide `confirmada` ou `falhou` (status da lista fechada do template, sem os ambíguos: `BUSY`, `UNKNOWN`, `RECEIPT_NOT_FOUND`, `DUPLICATE_TRANSACTION`, `TRANSACTION_EXPIRED`, `PLATFORM_NOT_ACTIVE`, `PLATFORM_TRANSACTION_NOT_CREATED`). Qualquer outro desfecho é `desconhecida`, e a preparação seguinte resolve pelo mirror, pelo id:

| No mirror (registros do id, fora `DUPLICATE_TRANSACTION`)                                                 | Situação                          |
| --------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Um registro SUCCESS da operação e do tópico do diário                                                     | `confirmada`                      |
| Um registro de falha reconhecida e não ambígua, da mesma operação (e do mesmo tópico, se informado)       | `falhou`                          |
| Nenhum registro, lido **depois** de um frescor além da validade + 30 s, duas vezes com 5 s de intervalo    | `expirada`                        |
| Nenhum registro dentro da janela                                                                          | espera até 6 min; depois **para** |
| Status desconhecido ou ambíguo, outra operação, outro tópico, dois originais, só duplicatas, frescor que volta atrás | **para** (a intenção fica aberta) |

`expirada` é definitiva: a rede recusa o id depois da validade, e o mesmo id nunca executa duas vezes. Uma mensagem que precisa ir de novo recebe id novo. **Consistência assumida do mirror:** o que tem consenso até o instante que ele já ingeriu aparece nas leituras seguintes. Por isso a leitura vazia só conta se vier depois do frescor que a justifica; uma leitura vazia anterior ao avanço do mirror nunca vira `expirada`, e o frescor nunca pode voltar atrás dentro da execução.

**Um tópico só:** `acao=criar-topico` para se `hcs-topico.json` já existe, se o diário já tem uma criação confirmada, ou se o mirror (em dia, até 60 s atrás) mostra qualquer `CONSENSUSCREATETOPIC` paga pela conta. A criação confirmada imprime o conteúdo de `hcs-topico.json` (`topicId`, `submitKey`, `criacao`), que entra na cópia **só por commit revisado**, como o `deployment.json`.

**Mensagens** (`acao=publicar`): exige `hcs-topico.json` com a mesma chave da conta no mirror, cada acordo `verified` pelo `verifyAgreement` e o tópico `consistent` ou `incomplete` (divergência ou leitura inconclusiva param sem reservar). Mensagem já confirmada por recibo não volta à fila, mesmo com a lista do mirror atrasada. Até 6 por lote e 16 por execução; o resto fica para a execução seguinte. No fim, `concluir` (sem chave) relê a trilha até ficar consistente.

**Diário entre execuções:** cada execução baixa os `hcs-diario-*` das anteriores (`baixar-artefatos.sh`, só leitura), valida o formato exato (campo a mais, na raiz, na origem ou na intenção, faz parar) e junta pelo id. Situação terminal vence aberta; duas terminais diferentes para o mesmo id fazem parar.

**Histórico revisado (`hcs-registro.json`):** a lista de artefatos baixada nunca prova, sozinha, que o histórico está completo. Antes de qualquer reserva, `preparar` e `concluir` cruzam três fontes:

- o inventário independente do ambiente (`listar-execucoes-ambiente.sh testnet`, implantações do GitHub, permissão `deployments: read`);
- `hcs-registro.json`, revisado e commitado na cópia: toda execução do `hcs-testnet` que entrou no ambiente, com o sha256 de cada diário (saída de `registrar-execucao.mjs --anteriores anteriores-hcs`), ou `perdida` com `revisao` e `encerradaEm`;
- `operacao-registro.json`: as execuções EVM (deploy e prova) do mesmo ambiente.

Para se: uma execução do ambiente não está em nenhum dos dois registros; uma execução do registro HCS não está no ambiente; um diário registrado sumiu (listagem sem o artefato, ou ZIP sem o arquivo) ou mudou; há pasta baixada de execução não revisada como HCS; o registro não existe. **Primeiro uso** é explícito: `{"versao": 1, "operador": "0.0.N", "execucoes": []}`, com todas as execuções do ambiente já no `operacao-registro.json` (inclusive a última da prova). **Perda revisada:** `perdida` exige o horário em que a execução terminou, e nada novo é reservado até o mirror passar desse horário + validade + 30 s; assim a consulta de criações e a leitura do tópico já mostram tudo o que ela possa ter enviado. Cada disparo novo exige o registro atualizado com a execução anterior, no mesmo commit revisado do `hcs-topico.json` quando houver.

**Ambiente:** o job usa `environment: testnet` e o mesmo grupo de concorrência. Por isso cada execução do `hcs-testnet` também aparece em `listar-execucoes-ambiente.sh`: se depois for preciso outra execução de `deploy-testnet` ou `prova-testnet`, o registro revisado precisa listá-la. Transação nativa não muda o nonce EVM da conta segundo o nosso entendimento, mas isso **não foi conferido na rede**: rode o HCS só depois da prova.

**Ensaio:** `vite-node operacao/ensaios/hcs.ensaio.ts <saída>` na raiz da cópia, com rede e mirror falsos (validade, deduplicação, recibo, atraso do mirror, índice que só avança no frescor), registro revisado simulado e relógio simulado, mais um teste offline do montador real do SDK (id, validade, `regenerate=false`, freeze). Prova a lógica do runner contra essas regras, não a rede real nem o envio pelo SDK.

**Passo a passo (só com autorização; nada disso foi feito):** depois da prova, commit revisado do `operacao-registro.json` com todas as execuções EVM e do `hcs-registro.json` de primeiro uso; `hcs-testnet` com `HCS-TESTNET`, `acao=criar-topico` e o id `0.0.N` da conta; revisão e commit de `hcs-topico.json` e da execução no `hcs-registro.json`; depois `hcs-testnet` com `acao=publicar` e `acordos=1,2`. O titular aprova cada execução no ambiente.

## Logs

A saída pública é uma linha JSON por evento: hashes, nonces, endereços, CID. Os erros saem **só como código fixo e número** (status HTTP ou código JSON-RPC). Nunca saem mensagem de biblioteca, corpo remoto ou dado assinado. As chaves só existem nos passos "Preparar", e os passos "Transmitir" não as recebem.

A conferência (`conferir.ts`) usa o mesmo cliente limitado: prazo, limite de bytes e nenhum redirecionamento, para a RPC (transporte do viem sem novas tentativas) e para o mirror. Ela para no manifesto inválido antes de ler a rede, e na chain diferente depois de uma leitura. O dado de revert (hexadecimal) segue para o viem, para "acordo inexistente" não virar "rede indisponível".

`txBruta` não é chave, mas permite a qualquer um que a leia transmiti-la enquanto o nonce estiver livre. Decidir a visibilidade da cópia antes de publicar os artefatos.

## Ensaios (na nuvem, nunca no Mac)

- `ensaios/ensaio.mjs <saída>`: nó Hardhat local, com proxy de falhas, porta pública falsa e Filebase falso.
  - Cobre: nonce que muda entre checagem e assinatura; runner que some antes e depois de transmitir; aceite com resposta perdida; reinício com tentativa não resolvida; porta travada, HTML, bytes errados, resposta grande e 404; porta recuperada com o mesmo fornecedor e acordo; queda entre aprovar e sacar; marcador sintético em erros remotos; ensaio feliz com conferência independente.
  - Cobre também: tentativa antiga que entra depois da nova, ou no intervalo antes da nova reserva (uma criação só); a árvore real de artefatos de uma prova retomada; o registro revisado (sem registro, sem papéis, nonce sem tentativa, último estado sumido ou alterado, artefato de execução não revisada, execução do ambiente sem registro e a perdida com autorização nova, autorização diferente, já usada ou desatualizada, chave diferente do papel); e a conferência com marcador, resposta grande, redirecionamento, manifesto inválido e chain diferente.
  - Confere no fim que nenhum arquivo gerado contém o marcador nem as chaves.
- `ensaios/baixar-artefatos.ensaio.sh`: listagem e download de artefatos com `gh` falso.
- `node ferramentas/gerar-workflows.mjs --conferir`: os workflows batem com o gerador. As ações são fixadas por SHA completo, conferido com `git ls-remote` nos repositórios oficiais.

## Passo a passo (só com autorização do titular; nada disso foi feito)

1. Conta no portal Hedera (ECDSA), para comprador e implantação. Exportar a chave **em HEX** pelo portal e validar o formato (0x + 64 hexadecimais). Não converter DER recortando caracteres.
2. Identidade de teste do fornecedor: uma segunda chave ECDSA, gerada e colada **direto** no segredo, sem passar por arquivo, canal ou Mac. O método de geração ainda precisa ser decidido. Ela recebe o saldo pela própria prova.
3. Filebase: conta gratuita, bucket IPFS e token da RPC do bucket. Conferir os limites do plano efetivo na conta: as páginas oficiais divergem. **Parar se pedir cartão.**
4. Gerar a cópia de prova a partir dos SHAs aprovados e criar o repositório (público ou privado: decisão do titular).
5. Registro `operacao-registro.json` na cópia (bootstrap acima): as duas contas por papel, nonces revisados e a autorização `aut-1`. Cada disparo de workflow informa a autorização vigente; depois de cada execução, revisão e autorização nova.
6. Environment `testnet`:
   - revisor obrigatório: o titular;
   - branch permitida: só a principal;
   - sem bypass para administradores;
   - os **três** segredos: `DELIVERPROOF_TESTNET_PRIVATE_KEY`, `DELIVERPROOF_FORNECEDOR_PRIVATE_KEY` e `FILEBASE_TOKEN`.

   `environment: testnet` no workflow só referencia o ambiente: a proteção precisa ser **conferida na tela** antes dos segredos. Com uma única identidade no GitHub, "Prevent self-review" impediria o titular de aprovar a própria execução. Documentamos a limitação, sem inventar outra conta.

7. Escopo `workflow` do token de push, aprovado pelo titular.
8. `deploy-testnet` com `DEPLOY-TESTNET` e o nonce da conta. O titular aprova a execução. A conferência do candidato é só leitura; depois vem o commit revisado do `deployment.json` na cópia.
9. `prova-testnet` com `PROVA-TESTNET`. O titular aprova. Retomadas, se houver, precisam de nova aprovação cada uma. Por fim, a conferência (`conferir.ts`), só leitura, na chain 296, com a tabela pública.

## Não validado

GitHub Actions real, Environment real, Filebase real, porta pública real e a conta oca do fornecedor no Hedera. Isso só se prova na primeira execução autorizada.

Trilha HCS: criação do tópico e envio de mensagens pelo SDK na testnet real, o mirror real respondendo às consultas por id e por conta, e o efeito de transações nativas no nonce EVM da conta.
