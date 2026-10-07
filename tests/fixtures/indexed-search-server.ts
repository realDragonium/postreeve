import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createApi } from "../../src/server/api";
import { createEmptyTestHarness, testAccountInput } from "../support/test-mail";
import type { ProviderMessageSummary } from "../../src/server/mail/provider";

const harness = await createEmptyTestHarness();
const accounts = [await harness.service.createAccount(testAccountInput()),
  await harness.service.createAccount({ ...testAccountInput(),name:"Second mailbox",email:"second@example.test" })];
for (const account of accounts) harness.store.synchronization.cancel("test-tenant",account.id,Date.now());
for (const [index,account] of accounts.entries()) {
  const messages: ProviderMessageSummary[] = Array.from({length:index ? 100 : 150},(_,i)=>{
    const uid=i+1+index*100;
    return { ref:{accountId:account.id,mailbox:"INBOX",uidValidity:"1",uid,modseq:null},messageId:`<${uid}@fixture.test>`,
      subject:`Indexed letter ${String(uid).padStart(3,"0")}`,from:[{name:`Sender ${String(uid).padStart(3,"0")}`,address:"sender@example.test"}],
      to:[{name:"Human",address:account.email}],receivedAt:new Date(Date.UTC(2026,0,1,0,0,uid)).toISOString(),
      preview:"Fixture preview",searchBody:uid===137?"unopened-body-needle":"Fixture body",searchHeaders:`X-Tracking: token-${uid}`,
      read:uid%2===0,flagged:uid%3===0 };
  });
  const provider=harness.providerForAccount(account.id)!;
  provider.listFolders=async()=>[{path:"INBOX",name:"Inbox",specialUse:"inbox",total:messages.length,unread:messages.filter(m=>!m.read).length}];
  provider.listMessagePage=async()=>({messages:[],complete:false});
  provider.searchMessages=async()=>{throw new Error("Fixture provider is offline");};
  const sync=harness.store.synchronization;
  const now=Date.now();
  sync.retry("test-tenant",account.id,now);
  const claim=sync.claim("test-tenant",now,100000)!;
  sync.discover(claim,[{kind:"mailbox",mailbox:"INBOX"}],now,10);
  sync.commit(claim,{kind:"mailbox",mailbox:"INBOX"},{messages,removed:[],cursor:"complete",hasMore:false,coverage:"complete"},now,10000,200);
  sync.finish(claim,now,10000);
}
const app=new Hono();
app.post("/scenario/expire",context=>{
  harness.store.synchronization.configureRetention({maxAgeDays:30,maxContentBytes:1});
  for(const account of accounts) harness.store.synchronization.enforceRetention("test-tenant",account.id,Date.now());
  return context.json({ok:true});
});
app.route("/",createApi(harness.service));
app.use("/*",serveStatic({root:"./dist"}));
app.get("/*",serveStatic({path:"./dist/index.html"}));
const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch:app.fetch});
console.log(`http://127.0.0.1:${server.port}`);
