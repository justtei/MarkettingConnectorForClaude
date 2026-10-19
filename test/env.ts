// Runs in every test worker before the tests import anything.
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgresql://sandalez:sandalez@localhost:5433/sandalez_test?schema=public";
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? "silent";
process.env.NODE_ENV = "test";
