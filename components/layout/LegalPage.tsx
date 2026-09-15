import type { ReactNode } from "react";
import { Navbar } from "@/components/Navbar";

export function LegalPage({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted">{children}</div>
      </main>
    </>
  );
}
