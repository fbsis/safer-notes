import { connection } from "next/server";

export default async function Home() {
  await connection();

  return (
    <main className="foundation">
      <section>
        <span aria-hidden="true">◆</span>
        <h1>Cofre de notas</h1>
        <p>Migração para Next.js em andamento.</p>
      </section>
    </main>
  );
}
