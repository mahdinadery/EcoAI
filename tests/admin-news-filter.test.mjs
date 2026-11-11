import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The server module uses Next.js path aliases. tsx honors tsconfig paths and
// renders queries without opening a database connection.
test("admin news list/count filters render valid parameterized SQL", () => {
  const helper = fileURLToPath(new URL("./helpers/admin-news-filter-check.mjs", import.meta.url));
  const env = { ...process.env, DATABASE_URL: "postgresql://test:test@127.0.0.1:5432/test" };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ["--import", "tsx", "--test", helper], {
    env,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (!output.includes("# tests 5")) throw new Error(`SQL filter checks did not run: ${output}`);
});
