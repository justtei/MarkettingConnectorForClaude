// Usage: pnpm user:add <email> <password> [owner|staff] [name]
import { getDb, hashPassword } from "../index.js";

const [email, password, role = "owner", name] = process.argv.slice(2);
if (!email || !password || !["owner", "staff"].includes(role)) {
  console.error("Usage: pnpm user:add <email> <password> [owner|staff] [name]");
  process.exit(1);
}
const db = getDb();
const passwordHash = await hashPassword(password);
const user = await db.user.upsert({
  where: { email: email.toLowerCase() },
  create: { email: email.toLowerCase(), passwordHash, role, name },
  update: { passwordHash, role, name },
});
console.log(`Saved ${user.role} user ${user.email}`);
await db.$disconnect();
