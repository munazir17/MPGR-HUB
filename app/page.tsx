"use client";

import { Navbar } from "@/components/Navbar";
import { AgentExperience } from "@/components/features/agent/AgentExperience";
import { HomeFooter } from "@/components/layout/HomeFooter";

export default function HomePage() {
  return (
    <div className="flex min-h-[100dvh] flex-col">
      <Navbar />
      <div className="flex min-h-[calc(100dvh-5rem)] flex-1 flex-col md:min-h-0">
        <AgentExperience />
      </div>
      <HomeFooter />
    </div>
  );
}
