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
      <main className="mx-auto max-w-2xl px-4 py-12 md:py-16">
        <span
          aria-hidden="true"
          className="mb-3 block h-px w-10 bg-gradient-to-r from-primary/80 to-transparent"
        />
        <h1 className="text-2xl font-semibold tracking-[-0.02em] text-white md:text-4xl md:leading-[44px]">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
        <div className="mt-8 space-y-4 text-sm leading-[1.8] text-muted">{children}</div>
      </main>
      <HomeFooter />
    </>
  );
}
