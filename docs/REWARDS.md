# MPGR Rewards System

## Overview

The MPGR Rewards System is the core incentive mechanism of MPGR HUB.

All rewards are funded exclusively from the Community Treasury.

No new MPGR tokens are ever minted.

The reward system is designed to encourage meaningful participation while maintaining long-term sustainability.

---

# Reward Treasury

Total Reward Treasury

100,000,000 MPGR

Reward Distribution

Treasury Based

Network

Base

Token

MPGR

---

# Reward Categories

## Daily Check-In

10,000,000 MPGR

Reward users for daily activity.

---

## Mini Games

15,000,000 MPGR

Includes:

- Tap Challenge
- Memory Game
- Future Games
- Weekly Competitions

---

## Community Quests

12,000,000 MPGR

Weekly quests

On-chain quests

Partner campaigns

Special missions

---

## Seasonal Events

10,000,000 MPGR

Season Pass

XP Seasons

Limited Events

Special Campaigns

---

## Referral Rewards

8,000,000 MPGR

Invite new users.

Reward successful referrals.

Implementation status: on-chain/USDB referral payouts are **not live**
(no reward provider exists for this category yet). What IS live is the
server XP-ledger reward (`REFERRAL_SUCCESS`, +100 XP) with the Task 8
anti-abuse rules:

- Attribution is permanent, first-write-wins, and only ever made by the
  referred wallet's own authenticated session (the referrer address in
  the request body can be anyone; the referred side can never be forged).
- Self-referral is rejected (case-normalized wallet comparison).
- The reward is NOT paid at signup time. It stays pending until the
  referred wallet performs genuine server-awarded activity (its first
  daily check-in), which makes bulk sybil registration worthless on its
  own.
- A referrer's reward count is capped per UTC day
  (`REFERRAL_REWARDS_PER_REFERRER_PER_DAY`, default 5) and checked
  atomically together with the payout claim, so concurrent farming
  cannot overshoot the cap. The cap throttles payouts only — honest
  referrals never lose attribution or count.
- A referral pays only into a referrer that already exists in the server
  XP ledger, so rewards cannot be pointed at arbitrary or fabricated
  addresses.
- Every paid referral is credited exactly once: replay, refresh, retries
  from multiple sessions and races on the same referred wallet are all
  deduplicated by the permanent ledger event key.
- Self-referral, attribution-steal attempts and cap saturations are
  logged (`referral.abuse.*`, `referral.reward.*`) and counted in
  `mpgrhub:referral:abuse:{wallet}:{day}` for operator review.

---

## AI Rewards

5,000,000 MPGR

AI Agent Tasks

Automation Rewards

Future AI Economy

---

## Community Airdrops

5,000,000 MPGR

Early users

Campaigns

Special promotions

---

## Ecosystem Partnerships

3,000,000 MPGR

Partner collaborations

Base ecosystem incentives

---

## Emergency Reserve

2,000,000 MPGR

Reserved for future ecosystem requirements.

---

# Reward Principles

Rewards are based on:

User activity

On-chain participation

Community contribution

Fair distribution

Anti-abuse protection

Treasury availability

---

# Reward Distribution

Rewards are never guaranteed.

Reward values may change depending on:

Treasury balance

Number of active users

Seasonal campaigns

Governance decisions

---

# Anti-Abuse Protection

One reward per completed action

Duplicate claims are rejected

Spam activity is ignored

Suspicious activity may receive reduced rewards

Future governance may introduce additional anti-bot measures

---

# Live Features

Claim Rewards

Reward History

Pending Rewards

Reward Statistics

Recent Claims

Automatic Refresh

Wallet Synchronization

Transaction Status

---

# Smart Contract Events

RewardClaimed

RewardUpdated

RewardAllocated

TreasuryUpdated

---

# Governance

Future governance may modify:

Reward amounts

Campaign budgets

Treasury allocations

Emission rates

Special events

---

# Long-Term Vision

The MPGR Rewards System is designed to encourage consistent ecosystem participation while preserving the long-term value of MPGR through treasury-funded, sustainable reward distribution.
