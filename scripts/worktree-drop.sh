#!/usr/bin/env bash
# Закрытие рабочего дерева: снять с отслеживания в графе Gortex, по требованию — удалить.
#
# Снимать обязательно: запись живёт в глобальном конфиге Gortex, а каждое отслеженное
# дерево — ПОЛНЫЙ второй граф репозитория (замер 2026-08-18: 11 552 узла против 11 943
# у control-center), то есть оплаченная память демона. Протечка видна лишним
# `<имя>@<workspace>` в `gortex repos`.
#
#   scripts/worktree-drop.sh <путь>            # только untrack, дерево на месте
#   scripts/worktree-drop.sh <путь> --remove   # + git worktree remove
#
# Agent Deck зовёт первый вариант через .agent-deck/worktree-destruction.sh: дерево она
# удаляет сама, наша часть — только граф.
set -euo pipefail

REMOVE=0
TREE=""
for arg in "$@"; do
  case "$arg" in
    --remove) REMOVE=1 ;;
    -*) printf 'worktree-drop: неизвестный флаг %s\n' "$arg" >&2; exit 2 ;;
    *) TREE="$arg" ;;
  esac
done
TREE="$(cd "${TREE:-$PWD}" && pwd)"

git_dir="$(git -C "$TREE" rev-parse --absolute-git-dir)"
common_dir="$(cd "$TREE" && cd "$(git rev-parse --git-common-dir)" && pwd)"
if [ "$git_dir" = "$common_dir" ]; then
  printf 'worktree-drop: %s — главный чекаут, а не связанное дерево; выхожу\n' "$TREE" >&2
  exit 1
fi
branch="$(git -C "$TREE" rev-parse --abbrev-ref HEAD)"

# Проверки ДО любого действия. Если удаление отказано, не снимаем и отслеживание: иначе
# под работающей сессией граф вернётся к коду главного чекаута — тихо и незаметно.
if [ "$REMOVE" = 1 ]; then
  blockers=()
  if [ -n "$(git -C "$TREE" status --porcelain)" ]; then
    blockers+=('незакоммиченные правки')
  fi
  # Мерка — не «отстал от upstream», а то, что удаление действительно потеряет: коммиты,
  # не достижимые ни с одного remote-рефа, ни из локальной main. Отправленная ветка
  # блокером не будет; влитая в main — тоже; дерево, стоящее на неотправленной main, —
  # тоже, её коммиты живут в главном чекауте. «Не отправлено» само по себе не потеря.
  excludes=(--remotes)
  if git -C "$TREE" show-ref --verify --quiet refs/heads/main; then
    excludes+=(refs/heads/main)
  fi
  lost="$(git -C "$TREE" rev-list --count HEAD --not "${excludes[@]}")"
  if [ "$lost" -gt 0 ]; then
    blockers+=("$lost коммит(ов) нет ни на origin, ни в main — удаление их потеряет")
  fi
  if [ "${#blockers[@]}" -gt 0 ]; then
    printf 'worktree-drop: удаление ОТКАЗАНО, ничего не изменено:\n' >&2
    printf '  - %s\n' "${blockers[@]}" >&2
    exit 3
  fi
fi

if command -v gortex >/dev/null 2>&1 \
  && gortex repos --json 2>/dev/null | grep -qF "\"path\": \"$TREE\""; then
  gortex untrack "$TREE"
  printf 'worktree-drop: снято с отслеживания\n'
else
  printf 'worktree-drop: в графе не числится, снимать нечего\n'
fi

if [ "$REMOVE" = 1 ]; then
  # Изнутри удаляемого дерева git работать не даст — уходим в главный чекаут.
  main_root="$(cd "$common_dir/.." && pwd)"
  cd "$main_root"
  git worktree remove "$TREE"
  if [ "$branch" = HEAD ]; then
    printf 'worktree-drop: дерево удалено (отсоединённый HEAD, ветки не было)\n'
  else
    printf 'worktree-drop: дерево удалено, ветка %s осталась\n' "$branch"
  fi
fi
