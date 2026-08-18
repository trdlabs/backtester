#!/usr/bin/env bash
# Бутстрап рабочего дерева: зависимости + отслеживание в графе Gortex.
#
# Свежее `git worktree add` неработоспособно дважды: в дереве нет node_modules, а Gortex
# про дерево не знает — и тогда граф молча отвечает кодом ГЛАВНОГО чекаута
# (см. CLAUDE.md, «Рабочие деревья и граф»).
#
# Скрипт самодостаточен и не принадлежит менеджеру сессий:
#   scripts/worktree-init.sh            # текущий каталог
#   scripts/worktree-init.sh <путь>     # заданное дерево
# Agent Deck зовёт его через .agent-deck/worktree-setup.sh.
#
# Обратная операция — scripts/worktree-drop.sh.
set -euo pipefail

TREE="$(cd "${1:-$PWD}" && pwd)"

# 1. Связанное дерево, а не главный чекаут ------------------------------------
# У дерева .git — файл со ссылкой на общий каталог, поэтому --absolute-git-dir и
# --git-common-dir расходятся; у главного чекаута они совпадают. Проверка не
# косметическая: на главном чекауте `track --as-worktree` завёл бы второй граф уже
# отслеженного репозитория.
git_dir="$(git -C "$TREE" rev-parse --absolute-git-dir)"
common_dir="$(cd "$TREE" && cd "$(git rev-parse --git-common-dir)" && pwd)"
if [ "$git_dir" = "$common_dir" ]; then
  printf 'worktree-init: %s — главный чекаут, а не связанное дерево; выхожу\n' "$TREE" >&2
  exit 1
fi
branch="$(git -C "$TREE" rev-parse --abbrev-ref HEAD)"
printf 'worktree-init: дерево %s, ветка %s\n' "$TREE" "$branch"

# 2. Зависимости --------------------------------------------------------------
# Именно install, НЕ симлинк на node_modules главного чекаута. В .gitignore стоит
# `node_modules/` — со слешем, то есть паттерн каталога; симлинк для git каталогом не
# является, под игнор не попадает и уезжает в коммит первым же `git add -A`. Так уже
# было. Менеджеры раскладывают из общего кеша, копия дешёвая.
#
# Менеджер выбирается по локфайлу, а не «у нас pnpm»: в экосистеме и pnpm
# (control-center, backtester, engine, lab, mock-platform), и npm (platform, sdk,
# office). Скрипт из-за этого переносим в любой репозиторий как есть.
if [ ! -f "$TREE/package.json" ]; then
  printf 'worktree-init: package.json нет, установку пропускаю\n'
elif [ -d "$TREE/node_modules" ]; then
  printf 'worktree-init: node_modules на месте, установку пропускаю\n'
elif [ -f "$TREE/pnpm-lock.yaml" ]; then
  ( cd "$TREE" && pnpm install --frozen-lockfile )
elif [ -f "$TREE/package-lock.json" ]; then
  ( cd "$TREE" && npm ci )
else
  printf 'worktree-init: локфайл не распознан — зависимости поставь сам\n' >&2
fi

# 3. Отслеживание в графе -----------------------------------------------------
if ! command -v gortex >/dev/null 2>&1; then
  printf 'worktree-init: gortex не на PATH — дерево останется вне графа\n' >&2
elif gortex repos --json 2>/dev/null | grep -qF "\"path\": \"$TREE\""; then
  printf 'worktree-init: дерево уже отслеживается\n'
else
  # --as-worktree обязателен: без него дерево уже отслеженного репозитория отдельным
  # инстансом не встаёт. Таймаут — чтобы медленная индексация не валила бутстрап:
  # запись в конфиге уже сделана, граф догонит сам.
  gortex track "$TREE" --as-worktree --wait --wait-timeout 5m \
    || printf 'worktree-init: индексация не уложилась в 5 минут; запись есть, граф догонит\n' >&2
fi

printf 'worktree-init: готово. Закрыть: scripts/worktree-drop.sh %s\n' "$TREE"
