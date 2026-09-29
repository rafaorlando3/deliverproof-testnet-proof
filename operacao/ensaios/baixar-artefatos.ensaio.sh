#!/usr/bin/env bash
# shellcheck disable=SC2319  # o $? de cada "ok" é, de propósito, o da condição logo acima
# Ensaio de baixar-artefatos.sh com um gh falso (sem rede): filtro por prefixo, execução atual ignorada,
# artefato expirado para tudo, nome fora do padrão para tudo.
set -uo pipefail
aqui="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
export PATH="$aqui/gh-falso:$PATH" FAKE_GH="$tmp/gh" GITHUB_REPOSITORY="dono/repo" GITHUB_RUN_ID="300"
mkdir -p "$FAKE_GH"
falhas=0
ok() { if [ "$2" = 0 ]; then echo "OK    $1"; else echo "FALHA $1"; falhas=$((falhas + 1)); fi; }
zipar() { (d="$tmp/z$1"; mkdir -p "$d"; echo "{\"id\":$1}" > "$d/reserva-implantacao.json"; cd "$d" && zip -q "$FAKE_GH/$1.zip" reserva-implantacao.json); }
for i in 11 12 13 14; do zipar $i; done
lista() { printf '%s' "$1" > "$FAKE_GH/lista.json"; }
art() { printf '{"id":%s,"name":"%s","expired":%s,"workflow_run":{"id":%s}}' "$1" "$2" "$3" "$4"; }

lista "{\"artifacts\":[$(art 11 reserva-implantacao false 100),$(art 12 reserva-implantacao false 200),$(art 13 outra-coisa false 200),$(art 14 reserva-implantacao false 300)]}"
out="$(bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/a1" 2>&1)"; c=$?
[ $c = 0 ] && [ -f "$tmp/a1/100/reserva-implantacao/reserva-implantacao.json" ] && [ -f "$tmp/a1/200/reserva-implantacao/reserva-implantacao.json" ] && [ ! -e "$tmp/a1/300" ] && [[ "$out" == *'"baixados":2'* ]]
ok "baixa só o prefixo pedido, de execuções anteriores (2 de 4; a atual e outro nome ficam fora)" $?

lista "{\"artifacts\":[$(art 11 reserva-implantacao false 100),$(art 12 reserva-implantacao true 200)]}"
out="$(bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/a2" 2>&1)"; c=$?
[ $c = 1 ] && [[ "$out" == *artefato_anterior_expirado* ]]
ok "artefato anterior expirado: para com código" $?

lista "{\"artifacts\":[$(art 11 'reserva-implantacao/../../x' false 100)]}"
out="$(bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/a3" 2>&1)"; c=$?
[ $c = 1 ] && [[ "$out" == *listagem_inesperada* ]] && [ ! -e "$tmp/x" ]
ok "nome fora do padrão (caminho) na listagem: para sem baixar" $?

lista '{"artifacts":[]}'
out="$(bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/a4" 2>&1)"; c=$?
[ $c = 0 ] && [[ "$out" == *'"baixados":0'* ]]
ok "sem anteriores: segue com zero" $?

out="$(bash "$aqui/../baixar-artefatos.sh" 'x;rm' "$tmp/a5" 2>&1)"; c=$?
[ $c = 2 ] && [[ "$out" == *prefixo_invalido* ]]
ok "prefixo inválido recusado" $?
# Sumiço do esperado: o registro revisado lista a execução 100, mas a listagem não traz mais o artefato dela.
lista "{\"artifacts\":[$(art 12 reserva-implantacao false 200)]}"
bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/a6" > /dev/null 2>&1
h200="$(sha256sum "$tmp/a6/200/reserva-implantacao/reserva-implantacao.json" | cut -d' ' -f1)"
c1=0x1111111111111111111111111111111111111111; c2=0x2222222222222222222222222222222222222222
printf '{"versao":2,"contas":{"comprador":"%s","fornecedor":"%s"},"nonceRevisado":{"%s":0,"%s":0},"execucoes":[{"id":"100","autorizacao":"a1","artefatos":{"reserva-implantacao/reserva-implantacao.json":"%s"}},{"id":"200","autorizacao":"a2","artefatos":{"reserva-implantacao/reserva-implantacao.json":"%s"}}],"autorizacao":{"id":"a3","nonces":{"%s":0,"%s":0}}}' \
  "$c1" "$c2" "$c1" "$c2" "$h200" "$h200" "$c1" "$c2" > "$tmp/registro.json"
out="$(DELIVERPROOF_REDE=local node "$aqui/../conferir-registro.mjs" --registro "$tmp/registro.json" --anteriores "$tmp/a6" --autorizacao a3 2>&1)"; c=$?
[ $c = 1 ] && [[ "$out" == *artefato_registrado_ausente* ]] && [ -d "$tmp/a6/200" ] && [ ! -e "$tmp/a6/100" ]
ok "execução registrada que sumiu da listagem (apagada): o registro para, sem rede" $?

# Execuções que entraram no ambiente protegido (implantações do GitHub), a atual fora da lista.
printf '[{"id":501},{"id":502},{"id":503}]' > "$FAKE_GH/deployments.json"
printf '[{"log_url":"https://github.com/dono/repo/actions/runs/100/job/9","target_url":""}]' > "$FAKE_GH/statuses-501.json"
printf '[{"log_url":"https://github.com/dono/repo/actions/runs/200/job/8","target_url":"https://github.com/dono/repo/actions/runs/200"}]' > "$FAKE_GH/statuses-502.json"
printf '[{"log_url":"https://github.com/dono/repo/actions/runs/300/job/7","target_url":""}]' > "$FAKE_GH/statuses-503.json"
out="$(bash "$aqui/../listar-execucoes-ambiente.sh" testnet "$tmp/amb.json" 2>&1)"; c=$?
[ $c = 0 ] && [ "$(jq -c . "$tmp/amb.json")" = '["100","200"]' ] && [[ "$out" == *'"quantidade":2'* ]]
ok "ambiente: execuções 100 e 200 listadas; a atual (300) fica fora" $?
printf '[{"log_url":"","target_url":"https://exemplo.com/x"}]' > "$FAKE_GH/statuses-502.json"
out="$(bash "$aqui/../listar-execucoes-ambiente.sh" testnet "$tmp/amb2.json" 2>&1)"; c=$?
[ $c = 1 ] && [[ "$out" == *implantacao_sem_execucao_identificavel* ]]
ok "ambiente: implantação sem execução identificável para tudo" $?

# Falhas de verdade do gh (código diferente de zero): nunca viram lista válida, e nada do corpo remoto aparece.
printf '[{"log_url":"https://github.com/dono/repo/actions/runs/200/job/8","target_url":""}]' > "$FAKE_GH/statuses-502.json"
for f in implantacoes-sem-saida implantacoes-parcial status; do
  out="$(FAKE_GH_FALHA=$f bash "$aqui/../listar-execucoes-ambiente.sh" testnet "$tmp/amb-$f.json" 2>&1)"; c=$?
  [ $c = 1 ] && [ ! -e "$tmp/amb-$f.json" ] && [[ "$out" == *'"codigo":"'* ]] && [[ "$out" != *"corpo remoto"* ]] && [[ "$out" != *"HTTP"* ]]
  ok "ambiente: gh falha ($f): para, sem lista e sem corpo remoto" $?
done
printf '[]' > "$FAKE_GH/deployments.json"
out="$(bash "$aqui/../listar-execucoes-ambiente.sh" testnet "$tmp/amb-vazio.json" 2>&1)"; c=$?
[ $c = 0 ] && [ "$(jq -c . "$tmp/amb-vazio.json")" = '[]' ]
ok "ambiente: vazio legítimo (primeira execução): lista vazia com sucesso" $?
lista "{\"artifacts\":[$(art 11 reserva-implantacao false 100),$(art 12 reserva-implantacao false 200)]}"
for f in artefatos-parcial zip; do
  out="$(FAKE_GH_FALHA=$f bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/b-$f" 2>&1)"; c=$?
  [ $c = 1 ] && [[ "$out" != *"corpo remoto"* ]] && [[ "$out" != *'"baixados"'* ]]
  ok "artefatos: gh falha ($f): para, sem resumo de sucesso e sem corpo remoto" $?
done
# Re-execução: a tentativa 2 da mesma execução não coleta histórico
out="$(GITHUB_RUN_ATTEMPT=2 bash "$aqui/../listar-execucoes-ambiente.sh" testnet "$tmp/amb-re.json" 2>&1)"; c=$?
[ $c = 1 ] && [[ "$out" == *reexecucao_proibida_use_novo_disparo* ]] && [ ! -e "$tmp/amb-re.json" ]
ok "re-execução (tentativa 2): listagem do ambiente recusada" $?
out="$(GITHUB_RUN_ATTEMPT=2 bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/b-re" 2>&1)"; c=$?
[ $c = 1 ] && [[ "$out" == *reexecucao_proibida_use_novo_disparo* ]]
ok "re-execução (tentativa 2): download de artefatos recusado" $?
out="$(GITHUB_RUN_ATTEMPT=1 bash "$aqui/../baixar-artefatos.sh" reserva-implantacao "$tmp/b-1" 2>&1)"; c=$?
[ $c = 0 ] && [[ "$out" == *'"baixados":2'* ]]
ok "controle: tentativa 1 segue" $?

rm -rf "$tmp"
echo "FIM: falhas=$falhas"
exit $falhas
