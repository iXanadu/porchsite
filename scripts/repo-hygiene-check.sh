#!/usr/bin/env bash
# repo-hygiene-check.sh: scan tracked files for things a public repo must
# never contain: key material, private network addresses, phone numbers,
# personal emails, and any name on a local denylist (people, assistants,
# internal systems, hosts, account identifiers).
#
# Usage:
#   scripts/repo-hygiene-check.sh [repo-root]       # exit 1 on findings
#   scripts/repo-hygiene-check.sh --message FILE    # scan a commit message
#
# Denylist (NEVER tracked; .gitignore has it):
#   <repo>/.hygiene-denylist  and/or  ~/.config/repo-hygiene/denylist
#   One case-insensitive extended regex per line; '#' starts a comment.
set -euo pipefail

ALLOW_NO_DENYLIST=0
args=()
for a in "$@"; do
  case "$a" in
    --no-denylist) ALLOW_NO_DENYLIST=1 ;;
    *) args+=("$a") ;;
  esac
done
set -- "${args[@]+"${args[@]}"}"

MESSAGE=""
if [ "${1:-}" = "--message" ]; then MESSAGE="$2"; set -- "."; fi
ROOT="${1:-.}"
cd "$ROOT"
command -v git >/dev/null || { echo "not a git checkout"; exit 2; }
git rev-parse --git-dir >/dev/null 2>&1 || { echo "not a git checkout"; exit 2; }

fail=0
# Lines matching this are placeholders, not leaks: localhost targets, doc
# example domains (RFC 2606), format-string/template braces, <angle> stubs.
# The denylist scan ignores it (STRICT=1): a private name is a leak on any line.
ALLOW='placeholder|555[-. ]?01[0-9]{2}|@(localhost|127\.0\.0\.1|test\.)|example\.(com|org|net)|users\.noreply\.github\.com|\{[A-Za-z_. ]+\}|<[^>]*>'
scan() { # scan <label> <extended-regex> [extra grep args...]
  local label="$1" pattern="$2"; shift 2
  local hits n allow="$ALLOW"
  [ -n "${STRICT:-}" ] && allow='$^'
  if [ -n "$MESSAGE" ]; then
    hits=$(grep -nE "$@" -- "$pattern" "$MESSAGE" 2>/dev/null | grep -vE '^[0-9]+:#' | grep -vE "$allow" || true)
  else
  hits=$(git ls-files -z \
    | xargs -0 grep -InE "$@" -- "$pattern" 2>/dev/null \
    | grep -vE '(^|/)repo-hygiene-check\.sh:' \
    | grep -vE "$allow" || true)
  fi
  if [ -n "$hits" ]; then
    fail=1
    echo "✗ $label"
    echo "$hits" | head -20 | sed 's/^/    /'
    n=$(echo "$hits" | wc -l | tr -d ' ')
    if [ "$n" -gt 20 ]; then echo "    ... and $((n - 20)) more"; fi
  fi
}

# --- key material / credentials -------------------------------------------
scan "private key material"        '-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY'
scan "credential-looking token"    '\b(ghp|gho|github_pat|sk-(live|test|proj|ant))_[A-Za-z0-9_-]{16,}'
scan "AWS access key id"           '\bAKIA[0-9A-Z]{16}\b'
scan "bearer/credential in URL"    '[a-z]+://[^ /@"]+:[^ /@"]{6,}@'
scan "inline password assignment"  '\b(password|passwd|secret)[ ]*[:=][ ]*["'\''][^"'\'' ]{6,}' -i

# --- network topology -------------------------------------------------------
# Private/CGNAT/overlay ranges. 127.x, 0.0.0.0, and doc-standard 192.0.2.x /
# 198.51.100.x / 203.0.113.x (RFC 5737) are allowed — use those in examples.
scan "private/LAN address (192.168/10.x/172.16-31)" \
  '\b(192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}|172\.(1[6-9]|2[0-9]|3[01])\.[0-9]{1,3}\.[0-9]{1,3})\b'
scan "CGNAT/tailnet address (100.64-127.x)" \
  '\b100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.[0-9]{1,3}\.[0-9]{1,3}\b'
scan "tailscale MagicDNS hostname"  '\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b'

# --- PII ---------------------------------------------------------------------
scan "US-format phone number" \
  '(\+1[-. ]?)?\(?[2-9][0-9]{2}\)?[-. ][0-9]{3}[-. ][0-9]{4}\b'
# Emails: flag real-looking ones; allow example/test/noreply domains.
# Doc/test domains are excluded by ALLOW instead of a lookahead (no grep -P).
scan "personal email address" \
  '\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b'

# --- local denylist ----------------------------------------------------------
# A missing denylist is reported as a failure, not a pass: without it, names
# are never checked.
denylist_found=0
for DL in ".hygiene-denylist" "$HOME/.config/repo-hygiene/denylist"; do
  if [ -f "$DL" ]; then
    denylist_found=1
    while IFS= read -r pat; do
      case "$pat" in ''|\#*) continue;; esac
      # \b at either end means "the whole token"; ERE's \b counts '_' as a
      # word character, so translate it to alphanumeric-only boundaries.
      pat="$(printf '%s' "$pat" | sed -E 's/^\\b/(^|[^A-Za-z0-9])/; s/\\b$/([^A-Za-z0-9]|$)/')"
      STRICT=1 scan "denylist: $pat" "$pat" -i
    done < "$DL"
  fi
done

if [ "$denylist_found" -eq 0 ] && [ "$ALLOW_NO_DENYLIST" -eq 0 ]; then
  fail=1
  echo "✗ NO DENYLIST — the people / clients / internal-hosts scan DID NOT RUN"
  echo "    This is not a pass. Key material, private IPs, phone numbers and"
  echo "    emails were checked; NAMES were not looked at even once."
  echo "    Create one (never tracked; already in .gitignore):"
  echo "      .hygiene-denylist   or   \$HOME/.config/repo-hygiene/denylist"
  echo "    One case-insensitive extended-regex per line, '#' for comments."
  echo "    To deliberately run without one, pass --no-denylist."
  echo
fi

if [ "$fail" -eq 0 ]; then
  if [ "$denylist_found" -eq 1 ]; then
    echo "✓ repo-hygiene: clean (denylist enforced)"
  else
    # Say what was NOT checked. "clean" with a skipped scan behind it is the
    # exact thing this script was changed to stop doing.
    echo "✓ repo-hygiene: clean — BUT NO DENYLIST: names were not checked"
  fi
else
  echo
  echo "Findings above must not be committed. Genericize the text, or move it"
  echo "out of the repo entirely (notes and reports never belong here)."
fi
exit "$fail"
