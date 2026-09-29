#!/usr/bin/env bash
# Lista, só leitura, as execuções do GitHub Actions que já entraram no ambiente protegido (cada job com
# `environment:` cria uma implantação no repositório). Registro durável independente dos artefatos:
# toda execução desta lista precisa estar no registro revisado. Id não identificável: para.
# Cada chamada ao gh tem o código conferido ANTES de o resultado ser usado: falha (inclusive depois de uma
# página parcial) nunca vira lista válida. Re-execução (tentativa > 1) é proibida: use um novo disparo.
# uso: listar-execucoes-ambiente.sh <ambiente> <saida.json>   (GH_TOKEN com deployments: read)
set -euo pipefail
ambiente="$1"
saida="$2"
erro() { echo "{\"etapa\":\"erro\",\"codigo\":\"$1\"}" >&2; rm -f "$saida"; exit "${2:-1}"; }
[[ "$ambiente" =~ ^[a-z0-9-]+$ ]] || erro ambiente_invalido 2
[ "${GITHUB_RUN_ATTEMPT:-1}" = 1 ] || erro reexecucao_proibida_use_novo_disparo
rm -f "$saida"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if ! gh api -X GET "repos/$GITHUB_REPOSITORY/deployments" -f environment="$ambiente" -f per_page=100 --paginate \
  --jq '.[].id' > "$tmp/implantacoes" 2> /dev/null; then
  erro listagem_do_ambiente_falhou
fi
ids=()
while IFS= read -r dep; do
  [ -n "$dep" ] || continue
  [[ "$dep" =~ ^[0-9]+$ ]] || erro listagem_inesperada
  if ! gh api "repos/$GITHUB_REPOSITORY/deployments/$dep/statuses" --paginate \
    --jq '.[] | (.log_url // ""), (.target_url // "")' > "$tmp/status" 2> /dev/null; then
    erro status_da_implantacao_falhou
  fi
  run="$(sed -nE 's#.*/actions/runs/([0-9]+).*#\1#p' "$tmp/status" | sort -u)"
  [ "$(printf '%s\n' "$run" | grep -c .)" = 1 ] || erro implantacao_sem_execucao_identificavel
  [ "$run" = "${GITHUB_RUN_ID:-}" ] || ids+=("$run")
done < "$tmp/implantacoes"
if [ ${#ids[@]} -eq 0 ]; then echo '[]' > "$tmp/saida"; else printf '%s\n' "${ids[@]}" | sort -u | jq -R . | jq -s . > "$tmp/saida"; fi
mv "$tmp/saida" "$saida"
echo "{\"etapa\":\"execucoes_do_ambiente\",\"quantidade\":$(jq length "$saida")}"
