#!/usr/bin/env bash
# Gera a cópia de prova a partir de dois SHAs aprovados: o template distribuído e este pacote operacional.
# O template continua sem orquestração própria e com deployment.json null; a cópia recebe operacao/,
# os workflows em .github/workflows e ORIGEM-PROVA.json com os dois SHAs. Não usa rede.
# uso: gerar-copia.sh <repo do template> <SHA do template> <repo da operação> <SHA da operação> <destino>
set -euo pipefail
[ $# -eq 5 ] || { echo "uso: gerar-copia.sh <repo template> <SHA template> <repo operação> <SHA operação> <destino>" >&2; exit 2; }
tr="$1"; ts="$2"; orp="$3"; os="$4"; destino="$5"
[[ "$ts" =~ ^[0-9a-f]{40}$ && "$os" =~ ^[0-9a-f]{40}$ ]] || { echo "SHA completo (40 caracteres) obrigatório" >&2; exit 2; }
[ ! -e "$destino" ] || { echo "destino já existe" >&2; exit 2; }
git -C "$tr" cat-file -e "$ts^{commit}"
git -C "$orp" cat-file -e "$os^{commit}"
mkdir -p "$destino"
git -C "$tr" archive "$ts" | tar -x -C "$destino"
[ ! -e "$destino/operacao" ] || { echo "o template já tem operacao/" >&2; exit 1; }
mkdir "$destino/operacao"
git -C "$orp" archive "$os" | tar -x -C "$destino/operacao"
mkdir -p "$destino/.github/workflows"
for w in "$destino"/operacao/workflows/*.yml; do
  alvo="$destino/.github/workflows/$(basename "$w")"
  [ ! -e "$alvo" ] || { echo "workflow com o mesmo nome no template: $(basename "$w")" >&2; exit 1; }
  cp "$w" "$alvo"
done
node -e 'const f=process.argv[1]; if (JSON.parse(require("fs").readFileSync(f,"utf8")) !== null) { console.error("deployment.json do template não é null"); process.exit(1) }' \
  "$destino/packages/nextjs/lib/deployment.json"
printf '{\n  "template": "%s",\n  "operacao": "%s"\n}\n' "$ts" "$os" > "$destino/ORIGEM-PROVA.json"
echo "{\"etapa\":\"copia_gerada\",\"template\":\"$ts\",\"operacao\":\"$os\"}"
