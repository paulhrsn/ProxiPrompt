import { DbConnection } from "../spacetimedb/bindings";
import { readFileSync } from "node:fs";
import { enterDemo, expect, test } from "./fixtures";

test("a dropped database connection recovers with the same account", async ({ page }) => {
  await page.addInitScript(() => {
    const original = window.WebSocket;
    const sockets: WebSocket[] = [];
    Object.assign(window, {auditFailures:0});
    Object.assign(window, { auditSockets: sockets });
    window.WebSocket = class extends original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols); sockets.push(this);
        const state = window as unknown as {auditFailures:number};
        if (String(url).includes("/v1/database/") && state.auditFailures > 0) {
          --state.auditFailures;
          this.addEventListener("open", () => this.close());
        }
      }
    };
  });
  await page.goto("/"); await enterDemo(page);
  const username = `recovery_${Date.now().toString(36)}`;
  await page.getByLabel("Name", {exact:true}).fill(username);
  await page.getByRole("button", {name:"Continue",exact:true}).click();
  await expect(page.getByRole("navigation", {name:"Primary"})).toBeVisible();
  const token = await page.evaluate(() => localStorage.getItem("pp.token:proxiprompt-test"));
  const socketsBefore = await page.evaluate(() =>
    (window as unknown as {auditSockets:WebSocket[]}).auditSockets.filter(s=>s.url.includes("/v1/database/")).length);
  await page.evaluate(() => {
    (window as unknown as {auditFailures:number}).auditFailures = 2;
    (window as unknown as {auditSockets:WebSocket[]}).auditSockets.filter(s=>s.url.includes("/v1/database/")).forEach(s => s.close());
  });
  await expect(page.getByRole("navigation", {name:"Primary"})).toBeVisible({timeout:15000});
  await expect.poll(() => page.evaluate(() =>
    (window as unknown as {auditSockets:WebSocket[]}).auditSockets.filter(s=>s.url.includes("/v1/database/")).length)).toBeGreaterThan(socketsBefore + 2);
  await page.getByRole("navigation").getByRole("button", {name:"You",exact:true}).click();
  await expect(page.getByText(username, {exact:true})).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("pp.token:proxiprompt-test"))).toBe(token);
});

test("demo location stays fresh after leaving You", async ({page}) => {
  await page.clock.install();
  await page.goto("/"); await enterDemo(page);
  await page.getByLabel("Name",{exact:true}).fill(`location_${Date.now().toString(36)}`);
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await page.getByRole("navigation").getByRole("button",{name:"You",exact:true}).click();
  await page.getByLabel("Location",{exact:true}).selectOption({label:"Shapiro Undergraduate Library"});
  const token = await page.evaluate(()=>localStorage.getItem("pp.token:proxiprompt-test")!);
  const conn = await new Promise<DbConnection>((resolve,reject)=> DbConnection.builder()
    .withUri("ws://127.0.0.1:3000").withDatabaseName("proxiprompt-test").withToken(token)
    .onConnect(c=>resolve(c)).onConnectError((_c,e)=>reject(e)).build());
  try {
    await new Promise<void>((resolve,reject)=>conn.subscriptionBuilder().onApplied(()=>resolve())
      .onError(reject).subscribe(["SELECT * FROM my_location"]));
    await expect.poll(()=>[...conn.db.myLocation.iter()][0]?.source).toBe("demo");
    const initial=[...conn.db.myLocation.iter()][0].capturedAt.microsSinceUnixEpoch;
    await page.getByRole("navigation").getByRole("button",{name:"Ask",exact:true}).click();
    await page.clock.fastForward(125000);
    await expect.poll(()=>[...conn.db.myLocation.iter()][0]?.capturedAt.microsSinceUnixEpoch > initial).toBe(true);
    const worker = await new Promise<DbConnection>((resolve,reject)=>DbConnection.builder()
      .withUri("ws://127.0.0.1:3000").withDatabaseName("proxiprompt-test")
      .withToken(readFileSync("spacetimedb/.local/worker-token-proxiprompt-test","utf8").trim())
      .onConnect(c=>resolve(c)).onConnectError((_c,e)=>reject(e)).build());
    try {
      await new Promise<void>((resolve,reject)=>worker.subscriptionBuilder().onApplied(()=>resolve())
        .onError(reject).subscribe(["SELECT * FROM svc_user_presence"]));
      const presence = () => [...worker.db.svcUserPresence.iter()].find(p=>p.identity.isEqual(conn.identity!));
      await expect.poll(()=>!!presence()).toBe(true);
      await page.evaluate(()=>{
        Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>"hidden"});
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // Give the reducer acknowledgement time to arrive; a tab switch must retain the
      // last heartbeat, while background timers must stop renewing it indefinitely.
      await page.waitForTimeout(300);
      const lastSeen = presence()?.lastSeenAt.microsSinceUnixEpoch;
      expect(lastSeen).toBeDefined();
      await page.clock.fastForward(125000);
      await page.waitForTimeout(300);
      expect(presence()?.lastSeenAt.microsSinceUnixEpoch).toBe(lastSeen);
    } finally { worker.disconnect(); }
  } finally {conn.disconnect();}
});

test("sign-out unsubscribes push and deactivates the old account's endpoint", async ({page}) => {
  await page.goto("/"); await enterDemo(page);
  await page.getByLabel("Name",{exact:true}).fill(`push_${Date.now().toString(36)}`);
  await page.getByRole("button",{name:"Continue",exact:true}).click();
  await expect(page.getByRole("navigation",{name:"Primary"})).toBeVisible();
  const token=await page.evaluate(()=>localStorage.getItem("pp.token:proxiprompt-test")!);
  const conn=await new Promise<DbConnection>((resolve,reject)=>DbConnection.builder()
    .withUri("ws://127.0.0.1:3000").withDatabaseName("proxiprompt-test").withToken(token)
    .onConnect(c=>resolve(c)).onConnectError((_c,e)=>reject(e)).build());
  const endpoint=`https://push.example.invalid/logout-${Date.now()}`;
  try {
    await new Promise<void>((resolve,reject)=>conn.subscriptionBuilder().onApplied(()=>resolve())
      .onError(reject).subscribe(["SELECT * FROM my_devices"]));
    await conn.reducers.registerDevice({endpoint,p256Dh:"test-key",auth:"test-auth",userAgent:"audit"});
    await expect.poll(()=>[...conn.db.myDevices.iter()].find(d=>d.endpoint===endpoint)?.active).toBe(true);
    await page.evaluate(endpoint=>{
      Object.assign(window,{auditUnsubscribed:false});
      Object.defineProperty(navigator.serviceWorker,"getRegistration",{configurable:true,value:async()=>({
        pushManager:{getSubscription:async()=>({endpoint,unsubscribe:async()=>{
          Object.assign(window,{auditUnsubscribed:true}); return true;
        }})}
      })});
    },endpoint);
    await page.getByRole("navigation").getByRole("button",{name:"You",exact:true}).click();
    await page.getByRole("button",{name:/^Sign out/}).click();
    await expect.poll(()=>[...conn.db.myDevices.iter()].find(d=>d.endpoint===endpoint)?.active).toBe(false);
    expect(await page.evaluate(()=>(window as unknown as {auditUnsubscribed:boolean}).auditUnsubscribed)).toBe(true);
    await expect.poll(()=>page.evaluate(()=>localStorage.getItem("pp.token:proxiprompt-test"))).toBeNull();
  } finally {conn.disconnect();}
});
