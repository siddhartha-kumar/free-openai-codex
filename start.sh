#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname "$0")" && pwd)
. "$SCRIPT_DIR/scripts/ensure-node.sh"

APP_NAME=free-openai-codex
PID_FILE="${FREE_OPENAI_CODEX_PID_FILE:-$SCRIPT_DIR/free-openai-codex.pid}"
LOG_FILE="${FREE_OPENAI_CODEX_LOG_FILE:-$SCRIPT_DIR/free-openai-codex.log}"
STARTUP_WAIT_SECONDS="${FREE_OPENAI_CODEX_STARTUP_WAIT_SECONDS:-1}"
STOP_TIMEOUT_SECONDS="${FREE_OPENAI_CODEX_STOP_TIMEOUT_SECONDS:-10}"
COMMAND="${1:-start}"

case "$STARTUP_WAIT_SECONDS" in
  ''|*[!0-9]*)
    STARTUP_WAIT_SECONDS=1
    ;;
esac

case "$STOP_TIMEOUT_SECONDS" in
  ''|*[!0-9]*)
    STOP_TIMEOUT_SECONDS=10
    ;;
esac

if [ "${FREE_OPENAI_CODEX_FOREGROUND:-0}" = "1" ] && [ "$COMMAND" = "start" ]; then
  COMMAND=foreground
fi

usage() {
  cat <<EOF
Usage: $0 [start|stop|restart|status|foreground]

Environment:
  FREE_OPENAI_CODEX_PID_FILE             PID file path (default: $PID_FILE)
  FREE_OPENAI_CODEX_LOG_FILE             Log file path (default: $LOG_FILE)
  FREE_OPENAI_CODEX_FOREGROUND=1         Run in foreground when no command is given
  FREE_OPENAI_CODEX_STARTUP_WAIT_SECONDS Seconds to check for immediate startup failure
  FREE_OPENAI_CODEX_STOP_TIMEOUT_SECONDS Seconds to wait for graceful stop
EOF
}

ensure_runtime_dirs() {
  PID_DIR=$(dirname "$PID_FILE")
  LOG_DIR=$(dirname "$LOG_FILE")
  if [ ! -d "$PID_DIR" ]; then
    mkdir -p "$PID_DIR"
  fi
  if [ ! -d "$LOG_DIR" ]; then
    mkdir -p "$LOG_DIR"
  fi
}

read_pid_file() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  PID=$(sed -n '1p' "$PID_FILE" 2>/dev/null || true)
  case "$PID" in
    ''|*[!0-9]*)
      return 1
      ;;
  esac

  printf '%s\n' "$PID"
}

process_exists() {
  [ -n "${1:-}" ] && kill -0 "$1" 2>/dev/null
}

process_matches_proxy() {
  COMMAND_LINE=$(ps -p "$1" -o command= 2>/dev/null || true)
  if [ -z "$COMMAND_LINE" ]; then
    return 0
  fi

  case "$COMMAND_LINE" in
    *"$SCRIPT_DIR/proxy.mjs"*)
      return 0
      ;;
  esac
  return 1
}

get_running_pid() {
  PID=$(read_pid_file) || return 1
  if process_exists "$PID" && process_matches_proxy "$PID"; then
    printf '%s\n' "$PID"
    return 0
  fi
  return 1
}

remove_stale_pid_file() {
  if [ ! -f "$PID_FILE" ]; then
    return 0
  fi

  PID=$(read_pid_file) || {
    echo "removing invalid pid file: $PID_FILE"
    rm -f "$PID_FILE"
    return 0
  }

  if ! process_exists "$PID"; then
    echo "removing stale pid file: $PID_FILE"
    rm -f "$PID_FILE"
    return 0
  fi

  if ! process_matches_proxy "$PID"; then
    echo "removing stale pid file: pid $PID is not $APP_NAME"
    rm -f "$PID_FILE"
  fi
}

start_daemon() {
  ensure_runtime_dirs

  if RUNNING_PID=$(get_running_pid); then
    echo "$APP_NAME is already running: pid $RUNNING_PID"
    echo "log: $LOG_FILE"
    return 0
  fi

  remove_stale_pid_file

  NODE_BIN=$(ensure_node)
  nohup "$NODE_BIN" "$SCRIPT_DIR/proxy.mjs" </dev/null >>"$LOG_FILE" 2>&1 &
  PID=$!
  printf '%s\n' "$PID" >"$PID_FILE"

  if [ "$STARTUP_WAIT_SECONDS" -gt 0 ]; then
    sleep "$STARTUP_WAIT_SECONDS"
  fi

  if ! process_exists "$PID"; then
    rm -f "$PID_FILE"
    echo "$APP_NAME failed to stay running. Check log: $LOG_FILE" >&2
    return 1
  fi

  echo "started $APP_NAME: pid $PID"
  echo "pid file: $PID_FILE"
  echo "log: $LOG_FILE"
}

stop_daemon() {
  if ! RUNNING_PID=$(get_running_pid); then
    remove_stale_pid_file
    echo "$APP_NAME is not running"
    return 0
  fi

  echo "stopping $APP_NAME: pid $RUNNING_PID"
  if ! kill "$RUNNING_PID" 2>/dev/null; then
    if ! process_exists "$RUNNING_PID"; then
      rm -f "$PID_FILE"
      echo "stopped $APP_NAME"
      return 0
    fi
    echo "$APP_NAME could not be signaled: pid $RUNNING_PID" >&2
    return 1
  fi

  ELAPSED=0
  while process_exists "$RUNNING_PID"; do
    if [ "$ELAPSED" -ge "$STOP_TIMEOUT_SECONDS" ]; then
      echo "$APP_NAME did not stop within ${STOP_TIMEOUT_SECONDS}s: pid $RUNNING_PID" >&2
      return 1
    fi
    sleep 1
    ELAPSED=$((ELAPSED + 1))
  done

  rm -f "$PID_FILE"
  echo "stopped $APP_NAME"
}

status_daemon() {
  if RUNNING_PID=$(get_running_pid); then
    echo "$APP_NAME is running: pid $RUNNING_PID"
    echo "pid file: $PID_FILE"
    echo "log: $LOG_FILE"
    return 0
  fi

  remove_stale_pid_file
  echo "$APP_NAME is not running"
  return 3
}

run_foreground() {
  NODE_BIN=$(ensure_node)
  exec "$NODE_BIN" "$SCRIPT_DIR/proxy.mjs"
}

case "$COMMAND" in
  start)
    start_daemon
    ;;
  stop)
    stop_daemon
    ;;
  restart)
    stop_daemon
    start_daemon
    ;;
  status)
    status_daemon
    ;;
  foreground|--foreground)
    run_foreground
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    echo "unknown command: $COMMAND" >&2
    usage >&2
    exit 64
    ;;
esac
