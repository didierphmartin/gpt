#!/usr/bin/env bash
env | grep '^FAKE_' | sort
exec python3 -u -m http.server "$FAKE_PORT" --bind "$FAKE_HOST"
