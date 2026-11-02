# TASK-009: Attachments (images, video, audio, files)

Depends on: 006

## Goal

Render attachments behind `FEATURE_ATTACHMENTS`: images inline, video and audio with controls, anything else as a file link.

## Requirements

1. `Attachment` MUST add `size` (bytes), `width` and `height` (number or null), filled by `toMsg`.
2. The attachment component MUST render only when `/config` says `attachments: true`. (Bun's HTML bundler does not code-split, so its few KB ship in the main bundle; see the `ponytail:` note in `app.tsx`.)
3. `src`/`href` MUST only be set for `https` URLs on `cdn.discordapp.com` or `media.discordapp.net`; anything else shows the file name without a link.
4. Images: `loading="lazy"`, sized from width and height so the feed does not jump, capped in size, open the full file in a new tab. Video and audio: controls, `preload="metadata"`, never autoplay.
5. Files whose name starts with `SPOILER_` stay blurred until clicked.
6. A failed load (Discord URLs expire after about 24 hours) shows "No longer available" instead of a broken image.
7. With the flag off, the page behaves as before ("Attachment" note on attachment-only messages).

## Acceptance criteria

- [x] `toMsg` tests cover size, width and height.
- [ ] `message-shape.md` updated with the new fields.
- [x] Typecheck and `bun test` pass.
- [ ] Turning the flag on in Railway (**requires user approval**) and checking a posted image, video and file.
