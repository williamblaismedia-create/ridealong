#!/usr/bin/env bash
# Ancien nom — Ridealong s'appelait Scry. Redirige vers le nouveau lanceur.
exec "$(dirname "${BASH_SOURCE[0]}")/ridealong-local.sh" "$@"
