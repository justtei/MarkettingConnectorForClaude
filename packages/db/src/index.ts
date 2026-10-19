import { PrismaClient, Prisma } from "@prisma/client";

export { PrismaClient, Prisma };
export type * from "@prisma/client";
export { hashPassword, verifyPassword } from "./password.js";

let client: PrismaClient | undefined;

/** One shared Prisma client per process. */
export function getDb(): PrismaClient {
  client ??= new PrismaClient();
  return client;
}
