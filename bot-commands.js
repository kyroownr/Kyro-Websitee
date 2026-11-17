/* Slash-command definitions for the Kyro Staff Bot.

   The interactions worker (applications-worker.js) already HANDLES these
   commands, but Discord only shows commands that have been REGISTERED with the
   application. Nothing registered them, so /setup verification, /mod, /role and
   the rest never appeared in any server — which is why verification and the
   command features "did not work". This module is the single source of truth for
   the command shapes; the dashboard registers them per-guild (instant, works in
   every server the bot is in) and the schema is validated by tools/commands.test.cjs.

   Option types: 1 SUB_COMMAND, 3 STRING, 4 INTEGER, 6 USER, 7 CHANNEL, 8 ROLE. */

const SUB_COMMAND = 1;
const STRING = 3;
const INTEGER = 4;
const USER = 6;
const CHANNEL = 7;
const ROLE = 8;

const user = (description, required = true) => ({ type: USER, name: 'user', description, required });
const role = (description, required = true) => ({ type: ROLE, name: 'role', description, required });
const reason = { type: STRING, name: 'reason', description: 'Reason shown in the audit log and DM.', required: false };
const channel = (description) => ({ type: CHANNEL, name: 'channel', description, required: false, channel_types: [0] });
const integer = (name, description, min, max) => ({ type: INTEGER, name, description, required: false, min_value: min, max_value: max });

export const COMMANDS_VERSION = '1';

export const KYRO_COMMANDS = [
  { name: 'invite', description: 'Get the official Kyro Discord invite and website.' },
  { name: 'stats', description: 'Show Kyro community and vault stats.' },
  { name: 'sync', description: 'Sync your profile with the Kyro database.' },
  { name: 'start-kyro', description: 'Launch the Kyro Bot Control Center (server owner/admin only).' },
  {
    name: 'role',
    description: 'Add or remove a member role (Mod+).',
    options: [
      { type: SUB_COMMAND, name: 'add', description: 'Give a role to a member.', options: [user('Member to receive the role.'), role('Role to add.')] },
      { type: SUB_COMMAND, name: 'remove', description: 'Remove a role from a member.', options: [user('Member to lose the role.'), role('Role to remove.')] }
    ]
  },
  {
    name: 'mod',
    description: 'Moderation actions (Mod+; ban/unban/lockdown are owner/admin only).',
    options: [
      { type: SUB_COMMAND, name: 'timeout', description: 'Temporarily mute a member.', options: [user('Member to time out.'), integer('minutes', 'Duration in minutes (default 60).', 1, 2419200), reason] },
      { type: SUB_COMMAND, name: 'untimeout', description: 'Remove a member timeout.', options: [user('Member to untimed out.'), reason] },
      { type: SUB_COMMAND, name: 'kick', description: 'Kick a member.', options: [user('Member to kick.'), reason] },
      { type: SUB_COMMAND, name: 'ban', description: 'Ban a member (owner/admin).', options: [user('Member to ban.'), integer('delete_days', 'Days of their messages to delete (0-7).', 0, 7), reason] },
      { type: SUB_COMMAND, name: 'unban', description: 'Unban a member (owner/admin).', options: [user('User ID to unban.'), reason] },
      { type: SUB_COMMAND, name: 'purge', description: 'Bulk-delete recent messages.', options: [integer('amount', 'How many messages (1-100, default 10).', 1, 100), channel('Channel to purge (defaults to this one).'), reason] },
      { type: SUB_COMMAND, name: 'slowmode', description: 'Set channel slowmode.', options: [integer('seconds', 'Slowmode seconds (0-21600, 0 removes it).', 0, 21600), channel('Channel to slow (defaults to this one).'), reason] },
      { type: SUB_COMMAND, name: 'lockdown', description: 'Lock or unlock a channel (owner/admin).', options: [{ type: STRING, name: 'state', description: 'Lock or unlock.', required: false, choices: [{ name: 'on', value: 'on' }, { name: 'off', value: 'off' }] }, channel('Channel to lock (defaults to this one).'), reason] }
    ]
  },
  {
    name: 'whois',
    description: "Look up a member's profile (Mod+).",
    options: [
      { type: SUB_COMMAND, name: 'lookup', description: 'By user pick or username search.', options: [{ type: USER, name: 'user', description: 'Member to look up.', required: false }, { type: STRING, name: 'query', description: 'Username to search for.', required: false }] }
    ]
  },
  {
    name: 'setup',
    description: 'Server setup tools (Mod+).',
    options: [
      { type: SUB_COMMAND, name: 'permissions', description: 'Auto-apply permission presets to matching roles.' },
      { type: SUB_COMMAND, name: 'verification', description: 'Create a Verified role + verify channel with a working button.', options: [channel('Channel for the verify message (defaults to this one).')] }
    ]
  }
];

/* Register the full command set for one guild. PUT bulk-overwrites, so it is
   idempotent — safe to call on every startup and whenever a new guild appears. */
export async function registerGuildCommands(discordFetch, applicationId, guildId) {
  return discordFetch(`/applications/${applicationId}/guilds/${guildId}/commands`, {
    method: 'PUT',
    body: JSON.stringify(KYRO_COMMANDS)
  });
}

export async function registerAllCommands(discordFetch, applicationId, guildIds) {
  const results = [];
  for (const guildId of guildIds) {
    try {
      await registerGuildCommands(discordFetch, applicationId, guildId);
      results.push({ guildId, ok: true });
    } catch (e) {
      results.push({ guildId, ok: false, error: e.message || String(e) });
    }
  }
  return results;
}