import { hashPassword } from './auth.js';
import { createDb, migrate } from './db/index.js';

const db = await createDb();
await migrate(db);
const pw = await hashPassword('demo1234');
await db.query(`INSERT INTO orgs (id, name) VALUES ('org-demo','Riverside Clinic (demo)') ON CONFLICT DO NOTHING`);
const users = [
  ['u-sender', 'sender@demo.test', 'Sam Sender', 'sender'],
  ['u-approver', 'approver@demo.test', 'Alex Approver', 'approver'],
  ['u-admin', 'admin@demo.test', 'Ada Admin', 'admin'],
];
for (const [id, email, name, role] of users) {
  await db.query(
    `INSERT INTO users (id, org_id, email, name, role, password_hash) VALUES ($1,'org-demo',$2,$3,$4,$5)
     ON CONFLICT (id) DO UPDATE SET password_hash = $5`,
    [id, email, name, role, pw],
  );
}
console.log('Seeded demo org. Log in with sender@demo.test / approver@demo.test / admin@demo.test, password demo1234');
await db.close();
