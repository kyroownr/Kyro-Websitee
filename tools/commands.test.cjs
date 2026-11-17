/* Validates bot-commands.js: Discord schema rules, registration helpers, and
   coverage of every command/subcommand the interactions worker actually handles.
   Run: node tools/commands.test.cjs */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };

const NAME_RE = /^[a-z0-9_-]{1,32}$/;
const VALID_TYPES = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);

function validateOption(opt, trail) {
  ok(NAME_RE.test(opt.name), `${trail}: bad option name "${opt.name}"`);
  ok(typeof opt.description === 'string' && opt.description.length >= 1 && opt.description.length <= 100, `${trail}: description 1-100 chars`);
  ok(VALID_TYPES.has(opt.type), `${trail}: valid option type ${opt.type}`);
  if (opt.type === 1 || opt.type === 2) {
    ok(opt.required === undefined, `${trail}: subcommand/group must not set required`);
    const subs = opt.options || [];
    ok(subs.length <= 25, `${trail}: <=25 sub-options`);
    let seenOptional = false;
    for (const s of subs) {
      if (s.required) ok(!seenOptional, `${trail}: required option "${s.name}" after an optional one`);
      else seenOptional = true;
      validateOption(s, `${trail}.${opt.name}`);
    }
  } else {
    if (opt.choices) {
      ok(Array.isArray(opt.choices) && opt.choices.length <= 25, `${trail}: <=25 choices`);
      for (const c of opt.choices) {
        ok(typeof c.name === 'string' && c.name.length <= 100, `${trail}: choice name <=100`);
        ok(c.value !== undefined, `${trail}: choice has value`);
      }
    }
    if (opt.type === 4 && opt.min_value !== undefined && opt.max_value !== undefined) {
      ok(opt.min_value <= opt.max_value, `${trail}: min<=max`);
    }
    if (opt.channel_types) ok(opt.channel_types.every((t) => Number.isInteger(t)), `${trail}: channel_types integers`);
  }
}

(async () => {
  const { KYRO_COMMANDS, COMMANDS_VERSION, registerGuildCommands, registerAllCommands } = await import('../bot-commands.js');

  ok(Array.isArray(KYRO_COMMANDS) && KYRO_COMMANDS.length > 0, 'commands array non-empty');
  ok(typeof COMMANDS_VERSION === 'string' && COMMANDS_VERSION.length > 0, 'version string');
  ok(KYRO_COMMANDS.length <= 100, 'global command limit <=100');

  const names = KYRO_COMMANDS.map((c) => c.name);
  ok(new Set(names).size === names.length, 'no duplicate command names');

  for (const cmd of KYRO_COMMANDS) {
    ok(NAME_RE.test(cmd.name), `command name "${cmd.name}" lowercase/valid`);
    ok(typeof cmd.description === 'string' && cmd.description.length >= 1 && cmd.description.length <= 100, `${cmd.name}: description 1-100 chars`);
    const opts = cmd.options || [];
    ok(opts.length <= 25, `${cmd.name}: <=25 options`);
    let seenOptional = false;
    for (const o of opts) {
      if (o.type === 1 || o.type === 2) {
        // subcommands are mutually exclusive; required flag not used at top level
      } else if (o.required) {
        ok(!seenOptional, `${cmd.name}: required "${o.name}" after optional`);
      } else {
        seenOptional = true;
      }
      validateOption(o, cmd.name);
    }
  }

  // Coverage: every command the worker handles must be registered.
  const workerSrc = fs.readFileSync(path.join(ROOT, 'applications-worker.js'), 'utf8');
  const handled = [...workerSrc.matchAll(/cmdName === '([a-z0-9_-]+)'/g)].map((m) => m[1]);
  ok(handled.length >= 8, `worker handles >=8 commands (found ${handled.length})`);
  for (const h of new Set(handled)) {
    ok(names.includes(h), `registered command covers worker handler "/${h}"`);
  }

  // mod subcommands must cover MOD_ACTIONS exactly.
  const modActionsMatch = workerSrc.match(/MOD_ACTIONS\s*=\s*\[([^\]]+)\]/);
  ok(modActionsMatch, 'MOD_ACTIONS found in worker');
  const modActions = [...modActionsMatch[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
  const modCmd = KYRO_COMMANDS.find((c) => c.name === 'mod');
  const modSubs = (modCmd.options || []).map((o) => o.name);
  for (const a of modActions) ok(modSubs.includes(a), `mod subcommand "${a}" registered`);
  ok(modSubs.length === modActions.length, `mod has exactly ${modActions.length} subcommands`);

  // role add/remove, setup permissions/verification, whois lookup present.
  const roleCmd = KYRO_COMMANDS.find((c) => c.name === 'role');
  ok(roleCmd.options.map((o) => o.name).sort().join(',') === 'add,remove', 'role add/remove');
  for (const sub of roleCmd.options) {
    ok(sub.options.some((o) => o.name === 'user' && o.type === 6 && o.required), `role ${sub.name}: required user`);
    ok(sub.options.some((o) => o.name === 'role' && o.type === 8 && o.required), `role ${sub.name}: required role`);
  }
  const setupCmd = KYRO_COMMANDS.find((c) => c.name === 'setup');
  ok(setupCmd.options.map((o) => o.name).sort().join(',') === 'permissions,verification', 'setup permissions/verification');
  const verif = setupCmd.options.find((o) => o.name === 'verification');
  ok(verif.options.some((o) => o.name === 'channel' && o.type === 7), 'setup verification: channel option');
  const whoisCmd = KYRO_COMMANDS.find((c) => c.name === 'whois');
  ok(whoisCmd.options[0].type === 1, 'whois uses a subcommand layer (handler reads options[0].options)');
  ok(whoisCmd.options[0].options.some((o) => o.name === 'user') && whoisCmd.options[0].options.some((o) => o.name === 'query'), 'whois lookup: user + query');

  // Registration helpers issue a PUT bulk-overwrite per guild with the full schema.
  const calls = [];
  const mockFetch = async (endpoint, options) => { calls.push({ endpoint, options }); return KYRO_COMMANDS; };
  await registerGuildCommands(mockFetch, '1571036271839682601', '111111111111111111');
  ok(calls.length === 1, 'registerGuildCommands issues one call');
  ok(calls[0].endpoint === '/applications/1571036271839682601/guilds/111111111111111111/commands', 'correct per-guild commands endpoint');
  ok(calls[0].options.method === 'PUT', 'uses PUT bulk-overwrite');
  ok(JSON.parse(calls[0].options.body).length === KYRO_COMMANDS.length, 'body carries full command set');

  calls.length = 0;
  const failFetch = async (endpoint) => { if (endpoint.includes('222222222222222222')) throw new Error('Missing Access'); return KYRO_COMMANDS; };
  const results = await registerAllCommands(failFetch, 'app', ['111111111111111111', '222222222222222222', '333333333333333333']);
  ok(results.length === 3, 'registerAllCommands returns one result per guild');
  ok(results[0].ok === true && results[2].ok === true, 'successful guilds marked ok');
  ok(results[1].ok === false && /Missing Access/.test(results[1].error), 'failed guild captured, not fatal');

  console.log(`commands.test: ${checks} checks passed`);
})().catch((e) => { console.error('commands.test FAILED:', e.message); process.exit(1); });