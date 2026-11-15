/* Registers the Kyro bot slash commands (idempotent merge, existing commands kept).
   Run:  node tools/register-bot-commands.cjs            (global, ~1h to propagate)
         node tools/register-bot-commands.cjs --guild <guildId>   (instant, per server)
   Token comes from .env / DISCORD_BOT_TOKEN. */
'use strict';
const fs = require('fs');
const path = require('path');

const API = 'https://discord.com/api/v10';

function readToken() {
  if (process.env.DISCORD_BOT_TOKEN) return process.env.DISCORD_BOT_TOKEN;
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
      const m = /^\s*DISCORD_BOT_TOKEN\s*=\s*(.+)\s*$/.exec(line);
      if (m) return m[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  throw new Error('DISCORD_BOT_TOKEN not set (env or .env).');
}

const modCommand = {
  name: 'mod',
  description: 'Moderation actions — the member always gets a DM with the reason.',
  options: [
    {
      name: 'timeout', description: 'Timeout a member (mods+)', type: 1,
      options: [
        { name: 'user', description: 'Member to timeout', type: 6, required: true },
        { name: 'minutes', description: 'Duration in minutes (max 40320 = 28 days)', type: 4, required: true, min_value: 1, max_value: 40320 },
        { name: 'reason', description: 'Reason, DM\u2019d to the member', type: 3, required: true, max_length: 400 }
      ]
    },
    {
      name: 'untimeout', description: 'Remove a timeout (mods+)', type: 1,
      options: [{ name: 'user', description: 'Member to release', type: 6, required: true }]
    },
    {
      name: 'kick', description: 'Kick a member (mods+)', type: 1,
      options: [
        { name: 'user', description: 'Member to kick', type: 6, required: true },
        { name: 'reason', description: 'Reason, DM\u2019d to the member', type: 3, required: true, max_length: 400 }
      ]
    },
    {
      name: 'ban', description: 'Ban a member (owner/admin) — DM includes an unban-request button', type: 1,
      options: [
        { name: 'user', description: 'Member to ban', type: 6, required: true },
        { name: 'reason', description: 'Reason, DM\u2019d to the member', type: 3, required: true, max_length: 400 },
        { name: 'delete_days', description: 'Days of messages to delete (0-7)', type: 4, required: false, min_value: 0, max_value: 7 }
      ]
    },
    {
      name: 'unban', description: 'Unban a member (owner/admin)', type: 1,
      options: [
        { name: 'user', description: 'User to unban', type: 6, required: true },
        { name: 'reason', description: 'Optional note for the log', type: 3, required: false, max_length: 400 }
      ]
    },
    {
      name: 'purge', description: 'Delete recent messages in a channel (mods+)', type: 1,
      options: [
        { name: 'channel', description: 'Channel to clean', type: 7, required: true },
        { name: 'amount', description: 'Messages to delete (1-100)', type: 4, required: true, min_value: 1, max_value: 100 }
      ]
    },
    {
      name: 'slowmode', description: 'Set channel slowmode (mods+)', type: 1,
      options: [
        { name: 'channel', description: 'Channel', type: 7, required: true },
        { name: 'seconds', description: '0 to disable (max 21600)', type: 4, required: true, min_value: 0, max_value: 21600 }
      ]
    },
    {
      name: 'lockdown', description: 'Lock/unlock a channel against @everyone (owner/admin)', type: 1,
      options: [
        { name: 'channel', description: 'Channel (defaults to the current one)', type: 7, required: false },
        { name: 'state', description: 'on = lock, off = unlock', type: 3, required: false, choices: [
          { name: 'on (lock)', value: 'on' }, { name: 'off (unlock)', value: 'off' }
        ] }
      ]
    }
  ]
};

const whoisCommand = {
  name: 'whois',
  description: 'Profile picture and info for a member — works with ID or username.',
  options: [
    { name: 'user', description: 'Pick a member/user', type: 6, required: false },
    { name: 'query', description: 'Username to search in this server', type: 3, required: false, max_length: 32 }
  ]
};

const COMMANDS = [
  {
    name: 'invite', description: 'Kyro invite links and website', type: 1, options: []
  },
  {
    name: 'stats', description: 'Kyro Community and Vault stats', type: 1, options: []
  },
  {
    name: 'sync', description: 'Sync your Kyro profile', type: 1, options: []
  },
  {
    name: 'start-kyro', description: 'Open the Kyro Staff Bot dashboard on localhost', type: 1, options: []
  },
  {
    name: 'role',
    description: 'Add or remove a role from a member (mods+)',
    type: 1,
    options: [
      {
        name: 'add', description: 'Add a role', type: 1, options: [
          { name: 'user', description: 'Target member', type: 6, required: true },
          { name: 'role', description: 'Role to add', type: 8, required: true }
        ]
      },
      {
        name: 'remove', description: 'Remove a role', type: 1, options: [
          { name: 'user', description: 'Target member', type: 6, required: true },
          { name: 'role', description: 'Role to remove', type: 8, required: true }
        ]
      }
    ]
  },
  modCommand,
  whoisCommand
];

async function main() {
  const token = readToken();
  const headers = { authorization: 'Bot ' + token, 'content-type': 'application/json' };
  // The application id is the first dot-separated chunk of the bot token (base64 snowflake).
  const appId = Buffer.from(token.split('.')[0], 'base64').toString();
  if (!/^\d{17,20}$/.test(appId)) throw new Error('Could not derive application id from the token.');

  const guildIndex = process.argv.indexOf('--guild');
  const guildId = guildIndex >= 0 ? process.argv[guildIndex + 1] : '';
  const route = guildId ? `/applications/${appId}/guilds/${guildId}/commands` : `/applications/${appId}/commands`;

  // Merge: keep any commands we don't own a definition for, replace the rest.
  let existing = [];
  try {
    const res = await fetch(API + route, { headers });
    if (res.ok) existing = await res.json();
  } catch {}
  const ours = new Set(COMMANDS.map(c => c.name));
  const merged = [...existing.filter(c => !ours.has(c.name)), ...COMMANDS];

  const res = await fetch(API + route, { method: 'PUT', headers, body: JSON.stringify(merged) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Registration failed (${res.status}): ${JSON.stringify(body)}`);
  console.log(`✅ Registered ${merged.length} commands (${merged.map(c => '/' + c.name).join(', ')})`);
  console.log(guildId ? `Scope: guild ${guildId} — usable immediately.` : 'Scope: global — can take up to an hour to appear.');
}

main().catch(err => { console.error(err.message || err); process.exit(1); });
