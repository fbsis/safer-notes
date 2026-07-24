import { connection } from "next/server";
import NotesApp from "@/components/notes-app";

export default async function Home() {
  await connection();

  return <NotesApp />;
}
