#!/usr/bin/env bash
# Netlify build step: put the Apps Script URL into index.html.
#
# The URL is not committed — this repo is public — so it lives in Netlify as
# the APPS_SCRIPT_URL environment variable and gets substituted at build time.
#
# Note this is not real secrecy: the browser has to call that URL, so it is
# visible in the deployed page's source either way. What it buys is keeping the
# URL out of a public git history where scrapers find it. Actual abuse
# protection belongs in the Apps Script itself.

set -euo pipefail

TARGET="Deploy Front End HTML/index.html"
PLACEHOLDER="__APPS_SCRIPT_URL__"

if [ ! -f "$TARGET" ]; then
  echo "inject-config: cannot find $TARGET" >&2
  exit 1
fi

if [ -z "${APPS_SCRIPT_URL:-}" ]; then
  echo "inject-config: APPS_SCRIPT_URL is not set." >&2
  echo "  Netlify > Site configuration > Environment variables > Add a variable" >&2
  echo "  Key: APPS_SCRIPT_URL   Value: your Apps Script /exec URL" >&2
  exit 1
fi

case "$APPS_SCRIPT_URL" in
  https://*/exec) ;;
  *) echo "inject-config: APPS_SCRIPT_URL should be an https:// URL ending in /exec" >&2
     echo "  got: $APPS_SCRIPT_URL" >&2
     exit 1 ;;
esac

# '|' as the delimiter, since the value is a URL full of slashes.
sed -i "s|${PLACEHOLDER}|${APPS_SCRIPT_URL}|g" "$TARGET"

# Fail loudly rather than shipping a site that silently can't reach its backend.
if grep -q "$PLACEHOLDER" "$TARGET"; then
  echo "inject-config: placeholder still present after substitution" >&2
  exit 1
fi

echo "inject-config: API URL injected into $TARGET"
