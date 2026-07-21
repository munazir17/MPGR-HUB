"use client";

import { useAccount } from "wagmi";
import { Navbar } from "@/components/Navbar";
import { StatCard } from "@/components/StatCard";
import { Coins, Flame, Trophy, Users } from "lucide-react";
import { motion } from "framer-motion";

export default function DashboardPage() {
  const { address, isConnected } = useAccount();

  return (
    <>
      <Navbar />
      <main className="mx-auto max-w-6xl px-4 py-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4 }}
        >
          <h1 className="text-2xl font-semibold text-white">
            {isConnected ? "Welcome back" : "Welcome to MPGR HUB"}
          </h1>
          <p className="mt-1 text-sm text-muted">
            {isConnected
              ? `Connected as ${address?.slice(0, 6)}...${address?.slice(-4)}`
              : "Connect your wallet to view your dashboard."}
          </p>
        </motion.div>

        {isConnected ? (
          <div className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatCard label="MPGR Balance" value="0.00" icon={Coins} />
            <StatCard label="XP" value="0" icon={Trophy} />
            <StatCard label="Level" value="1" icon={Flame} />
            <StatCard label="Referrals" value="0" icon={Users} />
          </div>
        ) : (
          <div className="mt-10 rounded-2xl border border-border bg-surface p-10 text-center text-muted">
            No wallet connected yet.
          </div>
        )}
      </main>
    </>
  );
}