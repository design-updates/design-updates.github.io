#!/bin/sh
# The morning job. macOS (launchd) starts it every hour from 07:00 to 23:00, and when the Mac logs in.
# Collects today's changes with the company Claude, then uploads data/ to GitHub, which republishes the page.
# Runs once per day: the first hour the Mac is awake and online does the work, later hours do nothing. If the
# news was collected but the upload failed, a later hour only uploads, so it doesn't spend credits again.
# Log: .cache/daily.log   Installed by: scripts/install-mac.sh

cd "$(dirname "$0")/.." || exit 1
. scripts/upload.sh
mkdir -p .cache
LOG=.cache/daily.log
STAMP=.cache/last-success
COLLECTED=.cache/last-collected
NODE="${RADAR_NODE:-node}"
TODAY=$(date +%F)

# Each message is shown at most once a day, so a Mac that is offline all day isn't nagged every hour.
NOTIFIED=.cache/notified
notify() {
  key="$TODAY $1"
  grep -qxF "$key" "$NOTIFIED" 2>/dev/null && return 0
  echo "$key" >>"$NOTIFIED"
  ${RADAR_NOTIFY:-/usr/bin/osascript} -e "display notification \"$1\" with title \"Pixel Post\"" >/dev/null 2>&1
}

exec >>"$LOG" 2>&1
echo
echo "=== $(date '+%F %T') daily run"

if [ "$(cat "$STAMP" 2>/dev/null)" = "$TODAY" ] && [ -z "$RADAR_FORCE" ]; then
  echo "Already ran successfully today. Nothing to do."
  exit 0
fi

# Logging in at 03:00 starts the job too; today's edition waits for 07:00.
if [ "$(date +%H)" -lt 7 ] && [ -z "$RADAR_FORCE" ]; then
  echo "Before 07:00. Waiting for the 07:00 run."
  exit 0
fi

if [ "$(cat "$COLLECTED" 2>/dev/null)" = "$TODAY" ]; then
  echo "Already collected today; only the upload is left."
else
  # Pick up any edits made on GitHub (for example to watchlist.yaml). Not fatal if offline.
  git pull --ff-only -q || echo "git pull failed (offline?). Continuing with the local copy."

  "$NODE" src/collect.ts >.cache/last-run.txt 2>&1
  code=$?
  cat .cache/last-run.txt
  if [ $code -ne 0 ]; then
    echo "Collect failed with exit $code. The next hour will try again."
    if grep -q "company login has expired" .cache/last-run.txt; then
      notify "The company login has expired. Open Terminal and run: ada refresh"
    else
      notify "Today's run failed (see .cache/daily.log). It will try again every hour."
    fi
    exit $code
  fi

  # AI workflows (trial): add today's posts to the pool; on the first run of a week, pick that week's posts.
  # A failure here never stops the news; tomorrow's run tries again.
  if grep -q "^enabled: true" workflows.yaml 2>/dev/null; then
    "$NODE" src/workflows-cli.ts >.cache/workflows-run.txt 2>&1 || echo "AI workflows step failed (see .cache/workflows-run.txt). The news is unaffected."
    tail -n 3 .cache/workflows-run.txt
  fi

  # Case studies: the same, for case studies of shipped work from well-known companies.
  if grep -q "^enabled: true" casestudies.yaml 2>/dev/null; then
    "$NODE" src/cases-cli.ts >.cache/cases-run.txt 2>&1 || echo "Case studies step failed (see .cache/cases-run.txt). The news is unaffected."
    tail -n 3 .cache/cases-run.txt
  fi

  git add data/
  if git diff --cached --quiet; then
    echo "No changes to upload."
  else
    git commit -qm "radar: $TODAY" && echo "Committed."
  fi
  echo "$TODAY" >"$COLLECTED"
fi

upload
up=$?
if [ $up -eq 0 ]; then
  echo "Uploaded. GitHub will republish the page in a minute or two."
elif [ $up -eq 2 ]; then
  echo "GitHub rejected the login. The token has probably expired."
  notify "GitHub rejected the upload: the token has probably expired. Make a new one and run git push once in Terminal."
  exit 1
else
  echo "Could not reach GitHub after 5 tries. The next hour will upload it without collecting again."
  notify "Collected today's news but could not reach GitHub. It will try the upload again every hour."
  exit 1
fi

echo "$TODAY" >"$STAMP"
tail -n 200 "$NOTIFIED" >"$NOTIFIED.tmp" 2>/dev/null && mv "$NOTIFIED.tmp" "$NOTIFIED"
tail -n 3000 "$LOG" >"$LOG.tmp" && mv "$LOG.tmp" "$LOG"
