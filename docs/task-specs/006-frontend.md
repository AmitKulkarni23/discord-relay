# TASK-006: React + MUI live feed page

Depends on: 003

## Goal

Replace the plain-text `GET /` with the live feed: a top bar (DiscordRelay, `# channel`, connection chip) over a centred transcript of avatar-led message groups, newest at the bottom. Base text feed only; the feature flags come later.

## Steps

1. Expose the channel name on `GET /config` (`channelName`, null until the bot loads the channel).
2. `frontend/feed.ts`: pure message logic (dedupe by ID, 500 cap, snowflake ordering, author groups within 5 minutes, day dividers, `Msg` narrowing, Discord CDN host check), tested in `feed.test.ts`.
3. `frontend/theme.ts`, `frontend/index.html`, `frontend/app.tsx`; serve `index.html` from `/` via Bun's HTML import.
4. Set `NODE_ENV=production` in `.railway/railway.ts`; `railway config plan`, then `railway config apply` (**requires user approval**).

## Acceptance criteria

- Opening the page shows the buffered messages, then new ones without a refresh.
- The chip reads Connecting, Live or Reconnecting truthfully; a redeploy turns it amber, then green, with no duplicates.
- A reader scrolled up is not moved; a "N new messages" pill jumps to the newest.
- Empty buffer, empty content and long unbroken text are handled; avatars load only from Discord's CDN.
- Typecheck and `bun test` pass; the user has checked the UI locally and on Railway.
