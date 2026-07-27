"use client";

import { motion, AnimatePresence } from "framer-motion";
import { Award, CheckCircle2, Lock } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { ProgressBar } from "@/components/ui/ProgressBar";
import type { BurnAchievement } from "@/lib/burn-types";

interface BurnAchievementsProps {
  achievements: BurnAchievement[];
}

// Visually matches components/ui/AchievementCard.tsx (same badge/lock/
// progress layout) but isn't that component directly: AchievementCard's
// props are typed to lib/xp-engine.ts's Achievement (with a `claimed`
// state and a working onClaim tied to the real XP system). Burn
// achievements are display-only progress badges — XP is a preview, not
// yet wired to xp-engine — so a fake "Claim" button would be misleading.
// No claim UI here until that real integration exists.
export function BurnAchievements({ achievements }: BurnAchievementsProps) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {achievements.map((achievement, i) => {
        const pct = achievement.target === 0 ? 0 : Math.round((achievement.progress / achievement.target) * 100);

        return (
          <motion.div
            key={achievement.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 10) * 0.03 }}
            whileHover={{ y: -3 }}
          >
            <GlassCard className={`relative overflow-hidden p-4 ${achievement.unlocked ? "" : "opacity-60"}`}>
              <div className="flex items-center justify-between">
                <div className="flex h-11 w-11 items-center justify-center rounded-full bg-gold/10">
                  <AnimatePresence mode="wait">
                    {achievement.unlocked ? (
                      <motion.span
                        key="unlocked"
                        initial={{ scale: 0 }}
                        animate={{ scale: 1 }}
                        transition={{ type: "spring", stiffness: 400, damping: 15 }}
                      >
                        <CheckCircle2 className="h-5 w-5 text-gold" aria-hidden="true" />
                      </motion.span>
                    ) : (
                      <Lock className="h-5 w-5 text-muted" aria-hidden="true" />
                    )}
                  </AnimatePresence>
                </div>
                {achievement.unlocked && (
                  <Award className="h-4 w-4 text-gold" aria-hidden="true" />
                )}
              </div>

              <p className="mt-3 text-sm font-semibold text-white">{achievement.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{achievement.description}</p>

              <div className="mt-3">
                <ProgressBar progress={pct} />
                <div className="mt-1 flex items-center justify-between">
                  <p className="text-[10px] text-muted">
                    {achievement.progress}/{achievement.target}
                  </p>
                  <p className="text-[10px] font-medium text-gold">+{achievement.xpRewardPreview} XP</p>
                </div>
              </div>
            </GlassCard>
          </motion.div>
        );
      })}
    </div>
  );
}
