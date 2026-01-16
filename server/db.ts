import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import * as schema from "../shared/schema";
import { sql } from "drizzle-orm";

// Backup is disabled as bot should rely solely on local.db
export const isBackupEnabled = false;

const client = createClient({
  url: "file:local.db",
});

export const db = drizzle(client, { schema });

export const pool = { 
  query: async (text: string, params: any[]) => {
    try {
      if (text.toLowerCase().startsWith('select')) {
        const result = await db.run(sql.raw(text));
        return { rows: (result as any).rows || [] };
      }
      return { rows: [] };
    } catch (e) {
      console.error("Pool query error:", e);
      return { rows: [] };
    }
  }
} as any;
