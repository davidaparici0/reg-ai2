// Idempotent demo-corpus seeder. Runs the REAL chunk + embed path so retrieval sees
// production-shaped chunks. Menu items are rendered to text cards and embedded as chunks
// under a synthetic "Menu" document — the single uniform retrieval path (Phase 3 spec §2).
// Run: npm run eval:seed   (needs a real OPENAI_API_KEY + Docker Postgres up)
import "dotenv/config";
import { inArray } from "drizzle-orm";
import { db, withTenant, pool } from "@/lib/db";
import { restaurants, users, documents, chunks, menuItems } from "@/db/schema";
import { chunk as chunkText } from "@/lib/ingest/chunk";
import { embed } from "@/lib/ai/embeddings";
import { hashPassword } from "@/lib/auth/password";
import { menuCard } from "@/lib/qa/menu-card";
import {
  RESTAURANT_A, DOCS_A, MENU_A, RESTAURANT_B, DOCS_B, MENU_B,
  type SeedDoc, type SeedMenu,
} from "./content";

async function ingestDoc(rid: string, title: string, text: string) {
  const [doc] = await withTenant(rid, (tx) =>
    tx.insert(documents).values({
      restaurantId: rid, title, sourceType: "text",
      contentHash: `seed-${title}-${rid}`, status: "done",
    }).returning());
  const pieces = chunkText(text);
  const { vectors } = await embed(pieces.map((p) => p.text));
  await withTenant(rid, (tx) =>
    tx.insert(chunks).values(pieces.map((p) => ({
      documentId: doc.id, restaurantId: rid, chunkIndex: p.chunkIndex,
      text: p.text, tokenCount: p.tokenCount, embedding: vectors[p.chunkIndex],
    }))));
}

async function ingestMenu(rid: string, items: SeedMenu[]) {
  const [menuDoc] = await withTenant(rid, (tx) =>
    tx.insert(documents).values({
      restaurantId: rid, title: "Menu", sourceType: "text",
      contentHash: `seed-menu-${rid}`, status: "done",
    }).returning());
  const cards = items.map((it) => menuCard(it));
  const { vectors } = await embed(cards);
  await withTenant(rid, async (tx) => {
    for (const it of items) {
      await tx.insert(menuItems).values({
        restaurantId: rid, name: it.name, description: it.description,
        ingredients: it.ingredients, allergens: it.allergens as never,
        dietaryFlags: it.dietaryFlags, price: it.price,
      });
    }
    await tx.insert(chunks).values(items.map((_, i) => ({
      documentId: menuDoc.id, restaurantId: rid, chunkIndex: i,
      text: cards[i], tokenCount: Math.max(1, cards[i].split(/\s+/).length), embedding: vectors[i],
    })));
  });
}

async function seedRestaurant(name: string, docs: SeedDoc[], menu: SeedMenu[]) {
  const [r] = await db.insert(restaurants).values({ name }).returning();
  await db.insert(users).values({
    restaurantId: r.id, email: `owner@${name}.test`,
    passwordHash: await hashPassword("x".repeat(12)), role: "owner",
  });
  for (const d of docs) await ingestDoc(r.id, d.title, d.text);
  await ingestMenu(r.id, menu);
  console.log(JSON.stringify({ event: "seed.restaurant", name, id: r.id, docs: docs.length, menu: menu.length }));
}

async function main() {
  // Idempotent: drop prior demo restaurants (cascade clears children), then reseed.
  await db.delete(restaurants).where(inArray(restaurants.name, [RESTAURANT_A, RESTAURANT_B]));
  await seedRestaurant(RESTAURANT_A, DOCS_A, MENU_A);
  await seedRestaurant(RESTAURANT_B, DOCS_B, MENU_B);
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
