"use client";

// app/campaigns/page.tsx
//
// The Campaigns hub — temporary events/competitions launched by the
// operator. Config-driven: every card here comes from
// lib/campaigns/campaigns/* via GET /api/campaigns, so a new campaign
// appears without any page changes. Follows the existing page recipe
// (Navbar + PageContainer + SectionHeader + GlassCard tiles) and the
// mobile-first layout rules — one column on phones, two from md up,
// no horizontal overflow.

import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { Megaphone } from "lucide-react";
import { Navbar } from "@/components/Navbar";
import { PageContainer } from "@/components/layout/PageContainer";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { SkeletonCard } from "@/components/ui/SkeletonCard";
import { CampaignCard } from "@/components/features/campaigns/CampaignCard";
import { useCampaigns } from "@/hooks/useCampaigns";
import { clsx } from "clsx";
import type { CampaignStatus } from "@/lib/campaigns/campaign-types";

type TabId = "active" | "upcoming" | "completed" | "all";

const TABS: Array<{ id: TabId; label: string }> = [
  { id: "active", label: "Active" },
  { id: "upcoming", label: "Upcoming" },
  { id: "completed", label: "Completed" },
  { id: "all", label: "All" },
];

export default function CampaignsPage() {
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<TabId>("active");
  const { campaigns, loading, error } = useCampaigns();

  useEffect(() => setMounted(true), []);

  const visible = useMemo(() => {
    if (tab === "all") return campaigns;
    return campaigns.filter((campaign) => campaign.status === (tab as CampaignStatus));
  }, [campaigns, tab]);

  const counts = useMemo(() => {
    const map: Record<TabId, number> = { active: 0, upcoming: 0, completed: 0, all: campaigns.length };
    for (const campaign of campaigns) {
      if (campaign.status === "active" || campaign.status === "upcoming" || campaign.status === "completed") {
        map[campaign.status] += 1;
      }
    }
    return map;
  }, [campaigns]);

  return (
    <>
      <Navbar />
      <PageContainer>
        {!mounted ? null : (
          <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
            <SectionHeader
              size="page"
              as="h1"
              title="Campaigns"
              subtitle="Temporary competitions and events across MPGR HUB — earn campaign points, climb each leaderboard, and win its reward pool."
            />

            {/* Status tabs — segmented control, thumb-friendly on mobile. */}
            <div
              role="tablist"
              aria-label="Campaign status"
              className="flex max-w-full gap-1 overflow-x-auto rounded-xl border border-white/[0.08] bg-white/[0.03] p-1"
            >
              {TABS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                  className={clsx(
                    "min-h-[36px] shrink-0 rounded-lg px-3.5 py-1.5 text-xs font-semibold transition-colors duration-200 sm:text-sm",
                    tab === item.id
                      ? "bg-white/[0.08] text-white shadow-soft"
                      : "text-muted hover:text-white",
                  )}
                >
                  {item.label}
                  <span className="ml-1.5 font-mono text-[10px] tabular-nums text-muted/80">
                    {counts[item.id]}
                  </span>
                </button>
              ))}
            </div>

            {loading ? (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <SkeletonCard lines={3} />
                <SkeletonCard lines={3} />
              </div>
            ) : error ? (
              <EmptyState
                icon={Megaphone}
                title="Couldn't load campaigns"
                description="Something went wrong reaching the campaigns service. Please try again shortly."
              />
            ) : visible.length === 0 ? (
              <EmptyState
                icon={Megaphone}
                title={`No ${tab === "all" ? "" : tab} campaigns yet`}
                description={
                  tab === "completed"
                    ? "Completed campaigns will stay here with their finalized leaderboards."
                    : "New events drop here — check back soon for the next competition."
                }
              />
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                {visible.map((campaign) => (
                  <CampaignCard key={campaign.id} campaign={campaign} />
                ))}
              </div>
            )}
          </motion.div>
        )}
      </PageContainer>
    </>
  );
}
