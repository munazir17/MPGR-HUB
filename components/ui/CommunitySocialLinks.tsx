"use client";

import { motion } from "framer-motion";
import { Send, Github, MessageCircle, Coins } from "lucide-react";
import { GlassCard } from "@/components/ui/GlassCard";
import { BUY_MPGR_URL, SOCIALS } from "@/lib/site";

function XIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5" aria-hidden="true">
      <path
        fill="#ffffff"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.744l7.727-8.835L1.254 2.25H8.08l4.253 5.622L18.244 2.25zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77z"
      />
    </svg>
  );
}

const SOCIAL_LINKS = [
  {
    label: "Telegram",
    href: SOCIALS.telegram,
    icon: Send,
  },
  {
    label: "X",
    href: SOCIALS.x,
    icon: XIcon,
  },
  {
    label: "Discord",
    href: SOCIALS.discord,
    icon: MessageCircle,
  },
  {
    label: "GitHub",
    href: SOCIALS.github,
    icon: Github,
  },
];

export function CommunitySocialLinks() {
  return (
    <GlassCard className="p-5 sm:p-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SOCIAL_LINKS.map((link) => {
          const Icon = link.icon;

          return (
            <motion.a
              key={link.label}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={link.label}
              whileHover={{ y: -2, scale: 1.02 }}
              whileTap={{ scale: 0.96 }}
              className="flex min-h-[44px] flex-col items-center justify-center gap-2 rounded-2xl border border-white/[0.08] bg-white/[0.03] p-4 text-center transition-colors duration-200 hover:border-primary/25 hover:bg-white/[0.06]"
            >
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-white/[0.04] ring-1 ring-white/10">
                <Icon className="h-4.5 w-4.5 text-primary" aria-hidden="true" />
              </div>
              <p className="text-xs font-semibold text-white">{link.label}</p>
            </motion.a>
          );
        })}
      </div>

      <motion.a
        href={BUY_MPGR_URL}
        target="_blank"
        rel="noopener noreferrer"
        whileHover={{ scale: 1.01 }}
        whileTap={{ scale: 0.97 }}
        className="mt-3 flex min-h-[44px] w-full items-center justify-center gap-2 rounded-xl bg-gold px-5 py-3 text-sm font-semibold text-background"
      >
        <Coins className="h-4 w-4" aria-hidden="true" />
        Buy MPGR
      </motion.a>
    </GlassCard>
  );
}
