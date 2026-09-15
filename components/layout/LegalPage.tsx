import type { ReactNode } from "react";
import { Navbar } from "@/components/Navbar";
import { HomeFooter } from "@/components/layout/HomeFooter";

export function LegalPage({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 py-10">
        <h1 className="text-2xl font-semibold tracking-tight text-white">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm text-muted">{subtitle}</p> : null}
        <div className="mt-6 space-y-4 text-sm leading-relaxed text-muted">{children}</div>
      </main>
      <HomeFooter />
    </>
  );
}
