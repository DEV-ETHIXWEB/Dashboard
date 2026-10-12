'use strict';

/**
 * Work out the ClickUp settings this dashboard needs, from a token.
 *
 * `CLICKUP_TEAM_ID` is a number nobody knows by heart and ClickUp does not
 * print anywhere obvious -- the only way to learn it is to ask the API which
 * workspaces a token can see. That is also the call that fails first when a
 * token has lost its access, so this doubles as the diagnosis: it tells you
 * whether the token authenticates, which workspaces it can reach, and whether
 * the list ids already in .env belong to one of them.
 *
 * Nothing is written. It prints the lines to paste, because a script that
 * edits a file full of live credentials is a worse idea than ten seconds of
 * copying.
 *
 * Run:
 *   node scripts/clickup-setup.js pk_your_new_token
 *
 * or, to check the token already in .env:
 *   node --env-file-if-exists=.env scripts/clickup-setup.js
 */

const BASE = 'https://api.clickup.com/api/v2';

const token = (process.argv[2] || process.env.CLICKUP_API_TOKEN || '').trim();

function die(message, hint) {
  console.error(`\n  ${message}`);
  if (hint) console.error(`  ${hint}`);
  console.error('');
  process.exit(1);
}

async function call(path) {
  const res = await fetch(BASE + path, {
    headers: { Authorization: token, Accept: 'application/json' },
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function main() {
  if (!token) {
    die(
      'No token given.',
      'Usage: node scripts/clickup-setup.js pk_your_new_token',
    );
  }
  if (!token.startsWith('pk_')) {
    console.warn('\n  Note: a personal ClickUp token normally starts with "pk_". Carrying on anyway.');
  }

  console.log('\n=== 1. Does the token authenticate? ===');
  const me = await call('/user');
  if (me.status !== 200) {
    die(
      `ClickUp rejected the token (${me.status} ${me.body.ECODE || ''}).`,
      'Generate a fresh one: ClickUp -> your avatar -> Settings -> Apps -> API Token.',
    );
  }
  const user = me.body.user || {};
  console.log(`  yes -- ${user.username || 'unknown'} <${user.email || 'no email'}>`);

  console.log('\n=== 2. Which workspaces can it see? ===');
  const teams = await call('/team');
  if (teams.status !== 200) {
    die(
      `The token authenticates but can see no workspace (${teams.status} ${teams.body.ECODE || ''}).`,
      'That account is not a member of any ClickUp workspace. Add it to the workspace in '
      + 'ClickUp -> People, or generate the token from an account that is already a member.',
    );
  }

  const list = teams.body.teams || [];
  if (list.length === 0) {
    die(
      'ClickUp answered, but this account belongs to no workspace.',
      'Add it to the workspace in ClickUp -> People, then run this again.',
    );
  }

  for (const t of list) {
    console.log(`  ${String(t.id).padEnd(12)} ${t.name}${list.length > 1 ? '' : '   <- the only one'}`);
  }

  const chosen = list[0];
  if (list.length > 1) {
    console.log('\n  More than one. Pick the one this dashboard should mirror into,');
    console.log('  and use its id below instead of the first.');
  }

  console.log('\n=== 3. Do the configured lists belong to it? ===');
  const configured = [
    ['CLICKUP_TICKETS_LIST_ID', process.env.CLICKUP_TICKETS_LIST_ID],
    ['CLICKUP_TASKS_LIST_ID', process.env.CLICKUP_TASKS_LIST_ID],
  ];

  let anyBadList = false;
  for (const [name, id] of configured) {
    if (!id) {
      console.log(`  ${name.padEnd(26)} not set${name.includes('TASKS') ? ' (optional -- tasks stay in this dashboard)' : ' -- tickets will not mirror'}`);
      continue;
    }
    const res = await call(`/list/${encodeURIComponent(id)}`);
    if (res.status === 200) {
      console.log(`  ${name.padEnd(26)} ok -- "${res.body.name}"`);
    } else {
      anyBadList = true;
      console.log(`  ${name.padEnd(26)} UNREACHABLE (${res.status} ${res.body.ECODE || ''}) -- id ${id}`);
    }
  }

  if (anyBadList) {
    console.log('\n  A list the token cannot reach is usually a list in a different workspace,');
    console.log('  or one the token\'s user is not a member of. Open the list in ClickUp and');
    console.log('  take the id from the URL: /v/li/<this part>');
  }

  console.log('\n=== 4. Put these in .env ===\n');
  console.log(`CLICKUP_API_TOKEN=${token.slice(0, 6)}...   <- the token you just tested, in full`);
  console.log(`CLICKUP_TEAM_ID=${chosen.id}`);
  console.log('');
  console.log('  Then restart the app. Setting CLICKUP_TEAM_ID matters: without it the');
  console.log('  dashboard mirrors into whichever workspace the token happens to list');
  console.log('  first, which is a guess that changes when somebody joins another one.');
  console.log('');
}

main().catch((err) => {
  console.error(`\n  Could not reach ClickUp: ${err.message}\n`);
  process.exit(1);
});
