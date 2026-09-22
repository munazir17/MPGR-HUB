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
      <main className="mx-auto max-w-[72ch] px-4 py-12 md:py-16">
        <p className="eyebrow">MPGR HUB</p>
        <h1 className="display-l mt-3 text-[28px] text-white md:text-4xl md:leading-[44px]">{title}</h1>
        {subtitle ? <p className="mt-2 text-sm leading-relaxed text-muted">{subtitle}</p> : null}
        <div className="mt-8 space-y-4 text-base leading-[1.7] text-muted">{children}</div>
      </main>
      <HomeFooter />
    </>
  );
}
