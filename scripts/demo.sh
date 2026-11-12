#!/usr/bin/env sh
# Posts sample messages to Discord channels through their webhooks, so the relay has live traffic to show.
# Never commit a webhook URL: anyone who has one can post to its channel. Pass them in the environment.
#
# Usage:
#   export DEMO_WEBHOOK_URLS="https://discord.com/api/webhooks/... https://discord.com/api/webhooks/..."
#   sh scripts/demo.sh             # one message per channel every 2 s, until Ctrl+C
#   INTERVAL=1 COUNT=20 sh scripts/demo.sh
#
# INTERVAL: seconds between rounds (default 2). COUNT: rounds before stopping (default 0, meaning forever).
# Discord rate-limits webhooks, so stay at about one message a second per channel or slower.
set -eu

: "${DEMO_WEBHOOK_URLS:?set DEMO_WEBHOOK_URLS to one or more webhook URLs, separated by spaces}"
INTERVAL="${INTERVAL:-2}"
COUNT="${COUNT:-0}"

# Sample texts that exercise the page's formatting. No double quotes or backslashes: they go into JSON as is.
set -- \
  "Deploy finished on **production**, all checks green." \
  "Has anyone tried the new \`BUFFER_SIZE\` setting yet?" \
  "Release notes are up: https://github.com/AmitKulkarni23/discord-relay" \
  "Lunch order closes in 10 minutes 🍕" \
  "_Reminder:_ standup moves to 10:30 tomorrow." \
  "Spoiler for the retro: ||we shipped it on time||" \
  "~~Bug~~ feature: the page reconnects on its own after a deploy." \
  "Load test at 10 msg/s held 16,300 viewers 🚀"
SAMPLES=$#

# Sends one message. Returns non-zero when Discord refuses it, after one retry if it was rate-limited.
post() {
  url=$1 text=$2
  # allowed_mentions with no types: a sample can never ping @everyone or a user.
  body="{\"username\":\"Relay demo\",\"content\":\"$text\",\"allowed_mentions\":{\"parse\":[]}}"
  for attempt in 1 2; do
    response=$(curl -sS -w '\n%{http_code}' -H 'Content-Type: application/json' -d "$body" "$url") || return 1
    status=$(printf '%s' "$response" | tail -n 1)
    case $status in
      2??) return 0 ;;
      429)
        # Discord says how long to wait, in seconds, in retry_after.
        wait=$(printf '%s' "$response" | sed -n 's/.*"retry_after": *\([0-9.]*\).*/\1/p')
        echo "rate limited, waiting ${wait:-2} s" >&2
        sleep "${wait:-2}"
        ;;
      *)
        echo "Discord answered $status: $(printf '%s' "$response" | sed '$d')" >&2
        return 1
        ;;
    esac
  done
  return 1
}

round=1
while [ "$COUNT" -eq 0 ] || [ "$round" -le "$COUNT" ]; do
  # Picks this round's sample: the ((round - 1) mod SAMPLES + 1)th positional argument.
  index=$(( (round - 1) % SAMPLES + 1 ))
  eval "text=\${$index}"
  for url in $DEMO_WEBHOOK_URLS; do
    post "$url" "$text" && echo "#$round sent" || echo "#$round failed" >&2
  done
  round=$((round + 1))
  sleep "$INTERVAL"
done
