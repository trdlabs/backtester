#!/usr/bin/env bash
# Обёртка Agent Deck над scripts/worktree-drop.sh — см. worktree-setup.sh о том, почему
# логика лежит в репозитории, а не здесь.
#
# Без --remove: дерево удаляет сама дека, наша часть — только снять отслеживание в графе.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
exec "$root/scripts/worktree-drop.sh" "$PWD"
