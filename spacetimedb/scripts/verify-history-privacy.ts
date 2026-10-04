// Test an actual non-destructive migration of an answer stored before sanitization.
// Only dedicated test databases are accepted. Never run while another test owns this DB.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import { connect, subscribe, eventually, readWorkerToken, DB } from './lib.js';

if (!DB.endsWith('-test')) throw new Error('Historical privacy verification requires a dedicated test database');
const server = process.env.STDB_SERVER ?? 'local';
const root = resolve('.');
const legacy = mkdtempSync(join(tmpdir(), 'proxiprompt-legacy-'));
const cli = promisify(execFile);
const publish = (path: string) => cli('spacetime', ['publish','--server',server,'--module-path',path,DB,'-y'], {timeout:120000});
let user: Awaited<ReturnType<typeof connect>> | undefined;
let worker: Awaited<ReturnType<typeof connect>> | undefined;
let restore = false;
try {
  cpSync(join(root,'src'),join(legacy,'src'),{recursive:true});
  cpSync(join(root,'package.json'),join(legacy,'package.json'));
  cpSync(join(root,'tsconfig.json'),join(legacy,'tsconfig.json'));
  symlinkSync(join(root,'node_modules'),join(legacy,'node_modules'));
  const workerPath=join(legacy,'src','worker.ts');
  const beforeWorker=readFileSync(workerPath,'utf8');
  const oldWorker=beforeWorker.replace('const safeAnswer = requesterAnswer(answer_json)!;', 'const safeAnswer = answer_json;');
  assert.notEqual(oldWorker,beforeWorker);
  writeFileSync(workerPath,oldWorker);
  const viewPath=join(legacy,'src','views.ts');
  const beforeView=readFileSync(viewPath,'utf8');
  const oldView=beforeView.replace('answer_json: requesterAnswer(q.answer_json)', 'answer_json: q.answer_json');
  assert.notEqual(oldView,beforeView);
  writeFileSync(viewPath,oldView);
  restore=true;
  await publish(legacy);
  worker=await connect(readWorkerToken());
  await subscribe(worker,['SELECT * FROM svc_query']);
  user=await connect();
  await subscribe(user,['SELECT * FROM my_queries']);
  const outsider=await connect();
  const privateIdentity=outsider.hex;
  outsider.close();
  await user.conn.reducers.setProfile({username:`history_${Date.now().toString(36)}`,defaultAttribution:'anonymous',avatarSeed:'history'});
  await user.conn.reducers.upsertPlace({id:'history-test',name:'History test',category:'library',lat:42.28,lng:-83.74,address:'Test',community:'test'});
  const requestId=`history-${Date.now()}`;
  await user.conn.reducers.submitQuery({clientRequestId:requestId,placeId:'history-test',text:'Is there seating?'});
  const q=await eventually(()=>[...worker!.conn.db.svcQuery.iter()].find(q=>q.clientRequestId===requestId));
  await worker.conn.reducers.workerSetQueryStatus({queryId:q.id,status:'synthesizing'});
  await worker.conn.reducers.workerSetAnswer({queryId:q.id,status:'answered',answerJson:JSON.stringify({
    headline:'Seats available',sourceCount:1,factors:{contributorIds:[privateIdentity],observations:[{id:'legacy-source',weight:1,contributorId:privateIdentity}]}})});
  const unsafe=await eventually(()=>[...user!.conn.db.myQueries.iter()].find(q=>q.clientRequestId===requestId)?.answerJson);
  assert.ok(unsafe.includes(privateIdentity));
  const token=user.token;
  user.close();user=undefined;
  worker.close();worker=undefined;
  await publish(root);
  restore=false;
  user=await connect(token);
  await subscribe(user,['SELECT * FROM my_queries']);
  const safe=await eventually(()=>[...user!.conn.db.myQueries.iter()].find(q=>q.clientRequestId===requestId)?.answerJson);
  assert.ok(!safe.includes(privateIdentity));
  assert.equal(JSON.parse(safe).headline,'Seats available');
  assert.equal(JSON.parse(safe).sourceCount,1);
  assert.equal(JSON.parse(safe).factors.observations[0].id,'legacy-source');
  worker=await connect(readWorkerToken());
  await subscribe(worker,['SELECT * FROM svc_query']);
  const stored=[...worker.conn.db.svcQuery.iter()].find(row=>row.clientRequestId===requestId)!.answerJson!;
  assert.ok(stored.includes(privateIdentity),'must test view sanitization of unchanged historical storage');
  console.log('PASS historical answer survives migration; ordinary requester gets no responder identity, while headline, count and source details remain');
} finally {
  user?.close();worker?.close();
  try { if (restore) await publish(root); }
  finally {rmSync(legacy,{recursive:true,force:true});}
}
