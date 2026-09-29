#!/usr/bin/env bash
# Baixa, só leitura, os artefatos de execuções ANTERIORES deste repositório cujo nome começa com o prefixo.
# Usa o token do job com permissão actions: read. Artefato expirado: para, porque uma reserva sumiu
# e só a reconciliação pela conta e pelo nonce pode dizer o que aconteceu.
set -euo pipefail
prefixo="$1"
destino="$2"
[[ "$prefixo" =~ ^[a-z0-9-]+$ ]] || { echo '{"etapa":"erro","codigo":"prefixo_invalido"}' >&2; exit 2; }
# Re-execução (tentativa > 1) mantém o mesmo id de execução e esconderia o histórico dela: proibida.
[ "${GITHUB_RUN_ATTEMPT:-1}" = 1 ] || { echo '{"etapa":"erro","codigo":"reexecucao_proibida_use_novo_disparo"}' >&2; exit 1; }
mkdir -p "$destino"
if ! gh api -X GET "repos/$GITHUB_REPOSITORY/actions/artifacts" -f per_page=100 --paginate \
  --jq ".artifacts[] | select(.name | startswith(\"$prefixo\")) | [.id, .name, .expired, .workflow_run.id] | @tsv" \
  > "$destino/.lista.tsv" 2> /dev/null; then
  rm -f "$destino/.lista.tsv"
  echo '{"etapa":"erro","codigo":"listagem_de_artefatos_falhou"}' >&2
  exit 1
fi
n=0
while IFS=$'\t' read -r id nome expirado execucao; do
  [ -n "$id" ] || continue
  [ "$execucao" != "${GITHUB_RUN_ID:-}" ] || continue
  if [ "$expirado" != "false" ]; then
    echo '{"etapa":"erro","codigo":"artefato_anterior_expirado"}' >&2
    exit 1
  fi
  [[ "$id" =~ ^[0-9]+$ && "$execucao" =~ ^[0-9]+$ && "$nome" =~ ^[a-z0-9-]+$ ]] || { echo '{"etapa":"erro","codigo":"listagem_inesperada"}' >&2; exit 1; }
  pasta="$destino/$execucao/$nome"
  mkdir -p "$pasta"
  gh api "repos/$GITHUB_REPOSITORY/actions/artifacts/$id/zip" > "$pasta.zip" 2> /dev/null ||
    { echo '{"etapa":"erro","codigo":"download_de_artefato_falhou"}' >&2; exit 1; }
  unzip -q -o "$pasta.zip" -d "$pasta"
  rm -f "$pasta.zip"
  n=$((n + 1))
done < "$destino/.lista.tsv"
echo "{\"etapa\":\"anteriores\",\"prefixo\":\"$prefixo\",\"baixados\":$n}"
