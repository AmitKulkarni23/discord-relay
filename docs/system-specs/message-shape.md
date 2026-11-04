# Message shape

What a browser receives on `GET /events`, and what each field means. IDs and names below are made up; the structure matches a real event captured from the test channel.

## A real event (anonymized)

```
id: 1566588496691400001
data: {"id":"1566588496691400001","channelId":"1566584977829900002","author":{"id":"961675715634400003","name":"relay_tester","avatarUrl":"https://cdn.discordapp.com/embed/avatars/0.png","bot":false},"content":"Hello from Relay Channel","createdAt":"2026-11-01T23:03:23.418Z","editedAt":null,"attachments":[]}

```

The `data:` line is one JSON object, shown formatted:

```json
{
  "id": "1566588496691400001",
  "channelId": "1566584977829900002",
  "author": {
    "id": "961675715634400003",
    "name": "relay_tester",
    "avatarUrl": "https://cdn.discordapp.com/embed/avatars/0.png",
    "bot": false
  },
  "content": "Hello from Relay Channel",
  "createdAt": "2026-11-01T23:03:23.418Z",
  "editedAt": null,
  "attachments": []
}
```

## Fields

| Field | Type | Meaning | Comes from (discord.js) |
|---|---|---|---|
| `id` | string | Discord message ID. Unique, and also the SSE `id:` line. The hub and browser dedupe on it. | `message.id` |
| `channelId` | string | Channel the message was posted in. The hub keys buffers and subscribers by it. | `message.channelId` |
| `author.id` | string | Discord user ID of the sender. | `message.author.id` |
| `author.name` | string | Display name: the user's global name if they set one, otherwise their username. | `author.globalName ?? author.username` |
| `author.avatarUrl` | string \| null | Avatar image URL. Users without an avatar get Discord's default (`/embed/avatars/<n>.png`). | `author.displayAvatarURL()` |
| `author.bot` | boolean | True for bots and webhooks. | `author.bot` |
| `content` | string | Message text with mentions and custom emoji resolved to names; other Discord formatting stays as typed, and the page renders it. Empty when the message has only attachments, or when the MessageContent intent is off. | `message.cleanContent` |
| `createdAt` | string | When the message was posted, ISO 8601 in UTC. | `message.createdAt` |
| `editedAt` | string \| null | When it was last edited, or `null` if never edited. | `message.editedAt` |
| `attachments` | array | Files attached to the message. Empty array when there are none. | `message.attachments` |
| `attachments[].url` | string | Discord CDN URL for the file. Signed, and expires after about 24 hours. | `attachment.url` |
| `attachments[].name` | string | File name, e.g. `build-log.png`. | `attachment.name` |
| `attachments[].contentType` | string \| null | MIME type, e.g. `image/png`. `null` when Discord does not know it. | `attachment.contentType` |
| `attachments[].size` | number | File size in bytes. | `attachment.size` |
| `attachments[].width` | number \| null | Pixel width for images and videos, `null` for other files. The page uses it with `height` to reserve space before the media loads. | `attachment.width` |
| `attachments[].height` | number \| null | Pixel height, same rules as `width`. | `attachment.height` |

The conversion lives in `toMsg` in the Discord source. The TypeScript type is `Msg` in `backend/types.ts`.

## Notes on the values

IDs are strings because Discord IDs are 64-bit "snowflakes", larger than the biggest integer JavaScript numbers hold exactly (2^53). Parsed as numbers, two different IDs could round to the same value.

A snowflake also encodes its creation time: `(BigInt(id) >> 22n) + 1420070400000n` is milliseconds since the Unix epoch. That is why sorting by ID sorts by time.

`content` comes from discord.js `message.cleanContent`, so `<@961675715634400003>` arrives as `@name`, `<#1566584977829900002>` as `#name` and `<:party:123>` as `:party:`. A mention of a user or channel the bot has not cached stays in its raw form.

## Other lines on the stream

| Line | When | Meaning |
|---|---|---|
| `: connected` | First line of every stream | A comment. Sent at once so headers reach the browser even when the buffer is empty. `EventSource` ignores it. |
| `: ping` | Every 25 seconds | A comment that keeps Railway's proxy from closing an idle stream. `EventSource` ignores it. |
| `event: delete` | Only with the `edits-deletes` flag (not built yet) | `data:` holds `{"id", "channelId"}` of a deleted message. |

Each event ends with a blank line, which is how SSE separates events.
