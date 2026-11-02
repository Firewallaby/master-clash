#!/bin/zsh
# Master A/B Tournament Launcher
DIR="$(cd "$(dirname "$0")" && pwd)"
python3 "$DIR/master_ab.py" "$@"
