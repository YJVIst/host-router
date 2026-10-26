#!/usr/bin/env bash
# Stable entry point: download and verify a real script file, so menu subcommands also work with bash <(curl ...).
set -Eeuo pipefail
umask 077
VERSION=0.2.0
HOSTIP_SHA=6d0e71b7bf140b88ea8e42585b9dea3a9d6d954cfacc11a69fb28528a90021da
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
curl --proto '=https' --tlsv1.2 -fL --retry 2 --connect-timeout 10 --max-time 180 \
  "https://github.com/YJVIst/host-router/releases/download/v$VERSION/hostip.sh" -o "$work/hostip.sh"
[[ "$(sha256sum "$work/hostip.sh" | awk '{print $1}')" == "$HOSTIP_SHA" ]] || { echo '管理脚本校验失败' >&2; exit 1; }
bash "$work/hostip.sh" "$@"
