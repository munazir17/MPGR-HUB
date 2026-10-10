"use client";

import { useState } from "react";
import { Navbar } from "@/components/Navbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const SWATCHES = [
  ["Canvas", "bg-background", "#05080F"],
  ["Surface", "bg-surface", "#0A101B"],
  ["Surface 2", "bg-surface-2", "#0D1524"],
  ["Blue", "bg-primary", "#4DA3FF"],
  ["Gold", "bg-gold", "#E2C073"],
  ["Ink", "bg-foreground", "#EEF3FA"],
] as const;

export default function DesignSystemPage() {
  const [open, setOpen] = useState(false);

  return (
    <div className="min-h-screen">
      <Navbar />
      <main className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-4 py-10 sm:px-6">
        <header className="flex flex-col gap-3">
          <p className="eyebrow">Base UI · maia geometry</p>
          <h1 className="display-l text-4xl text-foreground sm:text-5xl">
            MPGR design system
          </h1>
          <p className="max-w-2xl text-base text-muted">
            shadcn/ui on Base UI, painted in MPGR navy, blue, and gold.
            Existing screens stay as they are. New work starts here.
          </p>
        </header>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-foreground">Color</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {SWATCHES.map(([name, fill, hex]) => (
              <div
                key={name}
                className="overflow-hidden rounded-2xl border border-border"
              >
                <div className={`h-16 ${fill}`} />
                <div className="flex items-center justify-between bg-surface px-3 py-2 text-xs">
                  <span className="text-foreground">{name}</span>
                  <span className="font-mono text-muted">{hex}</span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-foreground">Type</h2>
          <Card>
            <CardHeader>
              <p className="eyebrow">Inter</p>
              <CardTitle className="display-l text-3xl">
                Play. Trade. Earn.
              </CardTitle>
              <CardDescription className="text-muted">
                14px muted for descriptions. Mono is for addresses and amounts
                only.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-sm text-foreground">
                0x71C7…a91E · 1,250 XP
              </p>
            </CardContent>
          </Card>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="text-sm font-semibold text-foreground">Buttons</h2>
          <div className="flex flex-wrap items-center gap-3">
            <Button>Primary</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="destructive">Burn</Button>
            <Button size="lg">Large</Button>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge>Live</Badge>
            <Badge variant="gold">Premium</Badge>
            <Badge variant="outline">Season</Badge>
            <Badge variant="destructive">Failed</Badge>
          </div>
        </section>

        <Separator />

        <section className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Field</CardTitle>
              <CardDescription className="text-muted">
                44px, 16px radius, blue focus ring.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <Input placeholder="Wallet or amount" />
              <Input disabled placeholder="Disabled" />
            </CardContent>
            <CardFooter>
              <Button size="sm">Continue</Button>
            </CardFooter>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Tabs and overlays</CardTitle>
              <CardDescription className="text-muted">
                Base UI render props. No Radix asChild.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <Tabs defaultValue="quests">
                <TabsList>
                  <TabsTrigger value="quests">Quests</TabsTrigger>
                  <TabsTrigger value="xp">XP</TabsTrigger>
                  <TabsTrigger value="base">Base</TabsTrigger>
                </TabsList>
                <TabsContent value="quests" className="pt-3 text-muted">
                  Complete quests to build onchain reputation.
                </TabsContent>
                <TabsContent value="xp" className="pt-3 text-muted">
                  XP is earned. It is never trusted from the browser.
                </TabsContent>
                <TabsContent value="base" className="pt-3 text-muted">
                  Base mainnet, chain 8453, is the only chain.
                </TabsContent>
              </Tabs>
              <div className="flex flex-wrap gap-2">
                <Dialog open={open} onOpenChange={setOpen}>
                  <DialogTrigger render={<Button variant="outline" />}>
                    Open dialog
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Confirm on Base</DialogTitle>
                      <DialogDescription>
                        The wallet still signs. This dialog only shows the
                        exact effect.
                      </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                      <Button onClick={() => setOpen(false)}>Close</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
                <Tooltip>
                  <TooltipTrigger render={<Button variant="ghost" />}>
                    Tooltip
                  </TooltipTrigger>
                  <TooltipContent>Hairline surface, not a glow.</TooltipContent>
                </Tooltip>
                <Button
                  variant="secondary"
                  onClick={() =>
                    toast.add({
                      title: "Saved on Base",
                      description: "The toast uses the same card recipe.",
                      type: "success",
                    })
                  }
                >
                  Toast
                </Button>
              </div>
            </CardContent>
          </Card>
        </section>
      </main>
    </div>
  );
}
