// Subscription proof: connect, subscribe to `place`, call upsert_place, and print the row arriving via the
// subscription callback.   Run: pnpm --filter @proxiprompt/spacetimedb smoke   (server + publish first)
import { connect, subscribe, DB, URI, errMessage } from './lib.js';

const slug = `smoke-${Date.now().toString(36)}`;

const c = await connect();
console.log(`connected to ${URI}/${DB} as ${c.hex.slice(0, 12)}…`);

let arrived: any;
const arrivedP = new Promise<void>((resolve) => {
  c.conn.db.place.onInsert((_ctx, row) => {
    if (row.id !== slug) return;
    arrived = row;
    console.log('onInsert callback ->', JSON.stringify(row));
    resolve();
  });
});

await subscribe(c, ['SELECT * FROM place']);
console.log(`subscription applied; place rows so far: ${[...c.conn.db.place.iter()].length}`);

await c.conn.reducers.upsertPlace({
  id: slug,
  name: 'Smoke Test Library',
  category: 'library',
  lat: 42.2753,
  lng: -83.7378,
  address: '919 S University Ave, Ann Arbor, MI',
  community: 'umich-annarbor',
});

const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('row did not arrive via subscription')), 5000));
try {
  await Promise.race([arrivedP, timeout]);
  console.log('SMOKE OK: row delivered through subscription:', arrived.id, '/', arrived.name);
  c.close();
  process.exit(0);
} catch (e) {
  console.error('SMOKE FAILED:', errMessage(e));
  c.close();
  process.exit(1);
}
