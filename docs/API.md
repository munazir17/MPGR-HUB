# MPGR HUB API Architecture

Version: 1.0

---

# Overview

MPGR HUB follows a service-first architecture.

The frontend never communicates directly with smart contracts unless user interaction is required.

Business logic is encapsulated within reusable services and hooks.

---

# Architecture Flow

UI

↓

Hooks

↓

Services

↓

Blockchain / APIs

↓

Base Network

---

# Service Layer

Production services include:

Portfolio Service

Reward Service

Staking Service

Treasury Service

Transaction History Service

Portfolio Sync Service

Refresh Manager

AI Services

---

# Hooks

Production hooks expose blockchain data to the UI.

Examples:

useMPGRPortfolio()

useMPGRTransactionHistory()

useMPGRStaking()

useMPGRRewards()

usePremium()

---

# Blockchain Reads

Uses Viem public clients.

Examples:

Balance

Token Metadata

Portfolio

Staking Positions

Reward Information

Transaction History

---

# Blockchain Writes

Uses Wagmi wallet actions.

Examples:

Stake

Unstake

Claim Rewards

Premium Actions

Future Governance Voting

---

# Event System

Shared Event Bus

Examples

portfolio_updated

staking_updated

reward_claimed

reward_updated

wallet_connected

wallet_disconnected

background_sync_completed

transaction_history_updated

---

# Background Services

Refresh Manager

Portfolio Sync

Task Queue

Performance Monitor

Logger

Retry System

---

# Error Handling

All services return typed results.

Errors are:

Logged

Reported

Recoverable where possible

Displayed through consistent UI states

---

# Performance

Caching

Background Refresh

Retry Logic

Deduplicated Requests

Lazy Loading

Event-driven Updates

---

# Security

Read-only operations never require wallet approval.

Write operations always require explicit wallet confirmation.

Private keys are never stored by MPGR HUB.

---

# Future APIs

Governance API

AI API

Analytics API

Notification API

Developer SDK

Public API
