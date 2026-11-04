import type { MessageLike } from '../../sources/discord-message.ts'

/** Builds a realistic discord.js-shaped message; override any field per test. */
export function makeDiscordMessage(overrides: Partial<MessageLike> = {}): MessageLike {
  return {
    id: '1302000000000000001',
    channelId: '1301000000000000001',
    content: 'deploy finished for build 482',
    cleanContent: 'deploy finished for build 482',
    createdAt: new Date('2026-11-01T17:00:00.000Z'),
    editedAt: null,
    author: {
      id: '1290000000000000042',
      username: 'amit_k',
      globalName: 'Amit',
      bot: false,
      displayAvatarURL: () => 'https://cdn.discordapp.com/avatars/1290000000000000042/abc.png',
    },
    attachments: new Map(),
    system: false,
    stickers: new Map(),
    embeds: [],
    poll: null,
    messageSnapshots: { first: () => undefined },
    ...overrides,
  }
}
