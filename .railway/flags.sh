#!/usr/bin/env sh
# Creates DiscordRelay's Railway Feature Flags. Railway IaC (railway.ts) cannot declare
# flags yet, so this script is their source of truth. Read at runtime by backend/platform/flags.ts.
#
# Run from the repo root after `railway link`:  sh .railway/flags.sh
# Re-running resets each flag's default to the value below (targeting rules are kept).
set -e

railway flag set attachments true      # render images, video, audio and file links
railway flag set edits-deletes false   # remove messages deleted in Discord from the page; live edits are not built yet
railway flag set debug-panel false     # show connection status, client count, last event (not built yet)

railway flag list
