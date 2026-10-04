// Run immediately after publish, using the same logged-in CLI publishing identity.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { connect, readWorkerToken, writeWorkerToken, DB } from './lib.js';

const server = process.env.STDB_SERVER ?? 'local';
const cli = promisify(execFile);
async function migrateLegacyOwner() {
  // SQL reads of private tables and SQL writes require the database publishing owner.
  // Updates do not rerun init, so databases created before module_owner need this step.
  const { stdout } = await cli('spacetime', ['sql','--server',server,'--format','json',DB,
    'SELECT * FROM module_owner','-y'], {timeout:20000});
  const tables = JSON.parse(stdout) as Array<{rows:unknown[]}>;
  if (tables.some(table => table.rows.length > 0)) return;
  const login = await cli('spacetime', ['login','show'], {timeout:20000});
  const identity = /You are logged in as ([0-9a-f]{64})\b/i.exec(login.stdout)?.[1];
  if (!identity) throw new Error('Cannot identify the publishing CLI owner for the legacy database migration');
  await cli('spacetime', ['sql','--server',server,DB,
    `INSERT INTO module_owner (id, identity) VALUES (0, 0x${identity})`,'-y'], {timeout:20000});
  console.log(`Recorded the publishing owner for legacy database ${DB}`);
}
const client = await connect(process.env.SPACETIMEDB_TOKEN?.trim() || readWorkerToken());
try {
  // Preserve working legacy deployments. Do not rotate or overwrite their authorized identity.
  writeWorkerToken(client.token);
  try {
    await client.conn.reducers.workerEnsureGc({});
    console.log(`Worker for ${DB} is already authorized`);
  } catch (error) {
    if (!/Only the service/.test(String(error))) throw error;
    await migrateLegacyOwner();
    await cli('spacetime', ['call','--server',server,DB,'grant_service_role',JSON.stringify(client.hex),'-y'], {timeout:20000});
    await client.conn.reducers.workerEnsureGc({});
    console.log(`Module owner provisioned the worker for ${DB}`);
  }
} finally { client.close(); }
