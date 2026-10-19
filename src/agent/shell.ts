import { defaultCommandTimeoutSeconds } from "../shared/config";
import { quoteShell } from "../shared/strings";
import { scriptUsage } from "../site/pages";

export function shellAgentScript(baseUrl: string): string {
  return `#!/bin/sh
${scriptUsage(baseUrl, "#")}
set -u
BASE_URL=${quoteShell(baseUrl)}

copy_text() {
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$1" | pbcopy
  elif command -v wl-copy >/dev/null 2>&1; then
    printf '%s' "$1" | wl-copy
  elif command -v xclip >/dev/null 2>&1; then
    printf '%s' "$1" | xclip -selection clipboard
  elif command -v xsel >/dev/null 2>&1; then
    printf '%s' "$1" | xsel --clipboard --input
  elif command -v clip.exe >/dev/null 2>&1; then
    printf '%s' "$1" | clip.exe
  else
    return 1
  fi
}

decode_b64() {
  if command -v base64 >/dev/null 2>&1; then
    printf '%s' "$1" | base64 -d 2>/dev/null || printf '%s' "$1" | base64 -D 2>/dev/null || printf ''
  else
    printf ''
  fi
}

header_value() {
  awk -F': ' -v name="$1" 'tolower($1) == tolower(name) { sub("\\r$", "", $2); print $2; exit }' "$2"
}

end_session() {
  if [ "\${REACH_NO_END_ON_EXIT:-}" = "1" ]; then
    return 0
  fi
  curl -fsS --connect-timeout 5 --max-time 10 -X DELETE "$BASE_URL/$CODE" >/dev/null 2>&1 || true
}

cleanup() {
  rm -f "\${headers_file:-}" "\${body_file:-}" "\${stdout_file:-}" "\${stderr_file:-}"
  end_session
}

run_shell() {
  command_body=$1
  cwd=$2
  timeout_seconds=$3
  stdout_file=$4
  stderr_file=$5
  if [ -n "$cwd" ]; then
    if [ ! -d "$cwd" ]; then
      printf 'Working directory does not exist: %s\\n' "$cwd" > "$stderr_file"
      return 1
    fi
    cd "$cwd" || return 1
  fi
  if command -v timeout >/dev/null 2>&1; then
    timeout "$timeout_seconds" sh -c "$command_body" > "$stdout_file" 2> "$stderr_file"
    exit_code=$?
  else
    sh -c "$command_body" > "$stdout_file" 2> "$stderr_file" &
    command_pid=$!
    ( sleep "$timeout_seconds"; kill "$command_pid" 2>/dev/null ) &
    timeout_pid=$!
    wait "$command_pid"
    exit_code=$?
    kill "$timeout_pid" 2>/dev/null || true
    wait "$timeout_pid" 2>/dev/null || true
    [ "$exit_code" = "143" ] && exit_code=124
  fi
  if [ "$exit_code" = "124" ]; then
    printf 'Command timed out after %s seconds\\n' "$timeout_seconds" >> "$stderr_file"
  fi
  return "$exit_code"
}

CODE=$(curl -fsS --connect-timeout 5 --max-time 15 -X POST -H "X-Agent-Shell: sh" -H "X-Agent-Platform: $(uname -s)" "$BASE_URL/") || exit 1

if copy_text "$CODE"; then
  CLIPBOARD='copied to clipboard'
else
  CLIPBOARD='clipboard copy unavailable'
fi

printf 'Session: %s (%s)\\nStop anytime: Ctrl+C\\n' "$CODE" "$CLIPBOARD"
trap 'exit 0' INT TERM
trap cleanup EXIT

while true; do
  headers_file=$(mktemp)
  body_file=$(mktemp)
  status_code=$(curl -sS --connect-timeout 5 --max-time 35 -D "$headers_file" -o "$body_file" -w "%{http_code}" "$BASE_URL/$CODE/next" || printf '000')
  if [ "$status_code" = "204" ]; then
    rm -f "$headers_file" "$body_file"
    continue
  fi
  if [ "$status_code" = "410" ] || [ "$status_code" = "404" ]; then
    rm -f "$headers_file" "$body_file"
    exit 0
  fi
  if [ "$status_code" != "200" ]; then
    cat "$body_file"
    printf '\\n'
    rm -f "$headers_file" "$body_file"
    sleep 1
    continue
  fi
  command_id=$(header_value X-Command-Id "$headers_file")
  cwd=$(decode_b64 "$(header_value X-Command-Cwd-Base64 "$headers_file")")
  timeout_seconds=$(header_value X-Command-Timeout "$headers_file")
  [ -n "$timeout_seconds" ] || timeout_seconds=${defaultCommandTimeoutSeconds}
  stdout_file=$(mktemp)
  stderr_file=$(mktemp)
  command_body=$(cat "$body_file")
  (run_shell "$command_body" "$cwd" "$timeout_seconds" "$stdout_file" "$stderr_file")
  exit_code=$?
  stdout_bytes=$(wc -c < "$stdout_file")
  cat "$stdout_file" "$stderr_file" > "$body_file"
  curl -fsS --connect-timeout 5 --max-time 30 -X POST -H "X-Stdout-Bytes: $stdout_bytes" --data-binary "@$body_file" "$BASE_URL/$CODE/result/$command_id?exit=$exit_code" >/dev/null || true
  rm -f "$headers_file" "$body_file" "$stdout_file" "$stderr_file"
done
`;
}
