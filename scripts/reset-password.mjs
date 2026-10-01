import { Store } from '../server/store.mjs';
import { passwordHash } from '../server/auth.mjs';
const password=process.env.CHAT_PASSWORD;
if(!password||password.length<12) throw new Error('Set CHAT_PASSWORD to at least 12 characters before resetting the password.');
const store=new Store(process.env.DATA_DIR??'./data');
try {
  const encoded=await passwordHash(password);
  store.transaction(()=>{
    store.run("INSERT INTO account(id,password) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET password=excluded.password",encoded);
    store.run('DELETE FROM sessions');
  });
  console.log('Owner password updated. All previous sessions were revoked.');
} finally {store.close();}
