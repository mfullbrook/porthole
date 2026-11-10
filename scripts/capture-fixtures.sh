#!/bin/sh
# Capture porthole resolver fixtures from the current context.
#
# Run it from an interactive shell AND from a LaunchAgent: the differences
# (PATH, lsof attribution, tailscale/docker CLI access, TCC, hairpin) are what
# the daemon will actually live with. Every binary is an absolute path on
# purpose; launchd's PATH is /usr/bin:/bin:/usr/sbin:/sbin.
#
# Usage: scripts/capture-fixtures.sh <out-dir>
#
# Output (one file per source, plus <name>.err and an exit code in _exits.txt):
#   _context.txt          who/where/PATH this ran as
#   lsof-listen.txt       lsof -F output for every TCP LISTEN socket
#   processes.jsonl       per listener pid: start time, ppid, command, cwd, git
#   serve-status.json     tailscale serve status --json
#   tailscale-self.json   tailscale status --json reduced to Self (no peers)
#   docker-ps.jsonl       docker ps, one JSON object per container
#   launchctl-list.txt    launchctl list (pid -> job label)
#   hairpin.tsv           url, http code, TLS verify result, seconds
#   _done                 written last
#
# Privacy: the output describes your machine in detail: tailnet name, Tailscale
# IPs, owner login and display name, user name, PATH, home paths, project and
# branch names, and full command lines (which can carry tokens or secrets).
# Scrub it before you share it or commit it to a public repo.

set -u
OUT=${1:?usage: capture-fixtures.sh <out-dir>}
mkdir -p "$OUT"

LSOF=/usr/sbin/lsof
PS=/bin/ps
GIT=/usr/bin/git
LAUNCHCTL=/bin/launchctl
JQ=/usr/bin/jq
CURL=/usr/bin/curl
TAILSCALE=/Applications/Tailscale.app/Contents/MacOS/Tailscale
DOCKER=/usr/local/bin/docker

rm -f "$OUT/_done"
: >"$OUT/_exits.txt"

run() {
  name=$1; shift
  "$@" >"$OUT/$name" 2>"$OUT/$name.err"
  echo "$name exit=$?" >>"$OUT/_exits.txt"
}

{
  echo "user=$(/usr/bin/id -un) uid=$(/usr/bin/id -u)"
  echo "PATH=${PATH:-}"
  echo "date=$(/bin/date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "ppid_command=$($PS -o command= -p "$PPID" 2>/dev/null)"
} >"$OUT/_context.txt"

# p=pid c=command L=login P=protocol t=type (IPv4/IPv6) n=name (address:port)
run lsof-listen.txt "$LSOF" -nP -iTCP -sTCP:LISTEN -F pcLPtn

run serve-status.json "$TAILSCALE" serve status --json

# Peers are dropped: porthole only needs this node's identity and owner.
"$TAILSCALE" status --json 2>"$OUT/tailscale-self.json.err" | "$JQ" '{
  MagicDNSSuffix,
  Self: (.Self | {HostName, DNSName, TailscaleIPs, UserID, Tags}),
  Owner: (.User[(.Self.UserID | tostring)] | {LoginName, DisplayName})
}' >"$OUT/tailscale-self.json" 2>>"$OUT/tailscale-self.json.err"
echo "tailscale-self.json exit=$?" >>"$OUT/_exits.txt"

run docker-ps.jsonl "$DOCKER" ps --format '{{json .}}'
run launchctl-list.txt "$LAUNCHCTL" list

# Per listener pid: process facts, cwd and git context.
: >"$OUT/processes.jsonl"
for pid in $(/usr/bin/sed -n 's/^p//p' "$OUT/lsof-listen.txt" | /usr/bin/sort -un); do
  line=$($PS -o lstart=,ppid=,command= -p "$pid" 2>/dev/null) || continue
  # lstart is a fixed 24-char field ("Thu Oct  8 10:32:01 2026").
  lstart=$(printf '%s' "$line" | /usr/bin/cut -c1-24)
  rest=$(printf '%s' "$line" | /usr/bin/cut -c25- | /usr/bin/sed 's/^ *//')
  ppid=${rest%% *}
  cmd=${rest#* }
  cwd=$("$LSOF" -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' | /usr/bin/head -1)
  top="" branch="" common=""
  if [ -n "$cwd" ]; then
    top=$("$GIT" -C "$cwd" rev-parse --show-toplevel 2>/dev/null)
    branch=$("$GIT" -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)
    common=$("$GIT" -C "$cwd" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)
  fi
  "$JQ" -cn --arg pid "$pid" --arg lstart "$lstart" --arg ppid "$ppid" --arg cmd "$cmd" \
    --arg cwd "$cwd" --arg top "$top" --arg branch "$branch" --arg common "$common" \
    '{pid: ($pid|tonumber), lstart: $lstart, ppid: ($ppid|tonumber), command: $cmd,
      cwd: $cwd, git: (if $top == "" then null else {toplevel: $top, branch: $branch, commonDir: $common} end)}' \
    >>"$OUT/processes.jsonl"
done
echo "processes.jsonl done" >>"$OUT/_exits.txt"

# Hairpin: fetch every serve URL and every direct (wildcard / Tailscale-IP) bind
# from this machine. Known non-HTTP ports and system daemons are never probed.
host=$("$JQ" -r '.Self.HostName' "$OUT/tailscale-self.json" 2>/dev/null)
# Serve URLs: :443 -> https FQDN; plain-HTTP serve port -> short name (plain
# http never uses the FQDN, see the design's HSTS rule); else https FQDN:port.
urls=$("$JQ" -r --arg short "$host" '
  . as $s | ($s.Web // {}) | to_entries[] | .key as $hp |
  ($hp | split(":")) as [$h, $p] |
  .value.Handlers | keys[] as $path |
  if $p == "443" then "https://\($h)\($path)"
  elif ($s.TCP[$p].HTTP // false) then "http://\($short):\($p)\($path)"
  else "https://\($h):\($p)\($path)" end' \
  "$OUT/serve-status.json" 2>/dev/null)
direct=$(/usr/bin/awk '
  /^p/ { pid = substr($0, 2) } /^c/ { cmd = substr($0, 2) }
  /^n/ { addr = substr($0, 2); port = addr; sub(/.*:/, "", port)
         if (cmd ~ /^(rapportd|ControlCe)/ || port == 1025 || port == 22000) next
         if (addr ~ /^\*:/ || addr ~ /^100\./ || addr ~ /^\[fd7a/) print port }' \
  "$OUT/lsof-listen.txt" | /usr/bin/sort -un)
for p in $direct; do urls="$urls
http://$host:$p/"; done

# Columns: url, http code (000 = no HTTP response), TLS verify result, seconds, curl exit.
: >"$OUT/hairpin.tsv"
printf '%s\n' "$urls" | /usr/bin/sed '/^$/d' | LC_ALL=C /usr/bin/sort -u | while read -r u; do
  r=$("$CURL" -s -m 4 -o /dev/null -w '%{http_code}\t%{ssl_verify_result}\t%{time_total}' "$u" 2>/dev/null)
  printf '%s\t%s\t%s\n' "$u" "$r" "$?" >>"$OUT/hairpin.tsv"
done
echo "hairpin.tsv done" >>"$OUT/_exits.txt"

/bin/date -u +%Y-%m-%dT%H:%M:%SZ >"$OUT/_done"
