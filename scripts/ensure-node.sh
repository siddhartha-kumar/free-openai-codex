#!/bin/sh
set -eu

find_brew() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi

  if [ -x /opt/homebrew/bin/brew ]; then
    printf '%s\n' /opt/homebrew/bin/brew
    return 0
  fi

  if [ -x /usr/local/bin/brew ]; then
    printf '%s\n' /usr/local/bin/brew
    return 0
  fi

  return 1
}

node_is_supported() {
  "$1" -e 'const major = Number(process.versions.node.split(".")[0]); process.exit(major >= 18 ? 0 : 1)' >/dev/null 2>&1
}

find_supported_node() {
  if command -v node >/dev/null 2>&1; then
    NODE_CANDIDATE=$(command -v node)
    if node_is_supported "$NODE_CANDIDATE"; then
      printf '%s\n' "$NODE_CANDIDATE"
      return 0
    fi
  fi

  return 1
}

install_node() {
  if [ "${FREE_OPENAI_CODEX_AUTO_INSTALL_NODE:-1}" = "0" ]; then
    return 1
  fi

  if [ "$(uname -s)" != "Darwin" ]; then
    return 1
  fi

  if ! BREW_BIN=$(find_brew); then
    return 1
  fi

  echo "Node.js 18+ was not found. Installing Node.js with Homebrew..." >&2
  "$BREW_BIN" install node >&2
}

ensure_node() {
  if NODE_BIN=$(find_supported_node); then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi

  if install_node && NODE_BIN=$(find_supported_node); then
    printf '%s\n' "$NODE_BIN"
    return 0
  fi

  echo "Node.js 18+ was not found." >&2
  echo "Install Node.js 18+ or Homebrew, then retry." >&2
  echo "Set FREE_OPENAI_CODEX_AUTO_INSTALL_NODE=0 to disable automatic Homebrew install attempts." >&2
  return 127
}
