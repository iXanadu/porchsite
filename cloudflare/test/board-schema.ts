// The board's D1 as deployed: schema.sql, then its migrations (once each).
import schema from "../downloads/board/schema.sql?raw";
import credit from "../downloads/board/0002_credit.sql?raw";
import asks from "../downloads/board/0003_asks.sql?raw";

const statements = (sql: string) =>
  sql
    .replace(/--.*$/gm, "")
    .split(";")
    .map((x) => x.trim())
    .filter(Boolean);

export async function applyBoardSchema(db: D1Database): Promise<void> {
  for (const stmt of statements(schema)) await db.prepare(stmt).run();
  const cols = (await db.prepare("PRAGMA table_info(board_submissions)").all<{ name: string }>()).results.map((c) => c.name);
  if (!cols.includes("author_x")) for (const stmt of statements(credit)) await db.prepare(stmt).run();
  for (const stmt of statements(asks)) await db.prepare(stmt).run();
}
