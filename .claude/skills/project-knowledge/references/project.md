# Project Context

## Purpose
This file provides high-level project overview for AI agents. Helps agents understand WHAT we're building and WHY.

---

## Project Overview

**Name:** ToTalk-ToDo

**Description:** Telegram bot that converts voice messages into clear, actionable task lists — removing verbal noise, resolving ambiguous references, and ordering tasks by dependencies.

The core idea: people speak as they think — chaotically, with hesitations, vague names, and unfinished thoughts. The bot understands this and outputs not a transcript, but an action plan.

---

## Target Audience

**Primary users:** People who find it easier to dictate than to type — entrepreneurs, managers, anyone with high cognitive load who loses thoughts while planning aloud.

**Use case:** User sends a voice message with a chaotic stream of thoughts. Bot extracts concrete tasks, resolves ambiguities ("that guy who fixed..." → "clarify the repairman's name from Anya"), and returns an ordered action plan.

---

## Core Problem

Currently, when people dictate tasks or plans, they get either a raw transcript (useless) or have to manually extract actions from their own ramblings. This is tedious and thoughts get lost. ToTalk-ToDo solves this by using STT + LLM to intelligently extract structured tasks from natural speech, including resolving unclear references and ordering by dependencies.

---

## Key Features

- **Voice-to-tasks pipeline** — Accept voice message → transcribe via faster-whisper → extract tasks via LLM → return numbered action list
- **Ambiguity resolution** — Detect vague references ("that guy", "or maybe Andrey") and turn them into explicit clarification tasks
- **Dependency ordering** — Arrange tasks logically (can't call someone whose number you don't know yet)
- **Multi-voice context** — Multiple voice messages forwarded simultaneously are treated as a single context
- **Feedback collection** — After each voice message, request 1-5 rating; if below 5, ask for a short comment

---

## Out of Scope

- Persistent memory between sessions (v2)
- Task completion tracking (v2)
- Reminders and notifications (v2)
- Video notes (voice circles)
- Multi-language support (v2)
- Integration with external task managers — Notion, Todoist (v3)
- Interrupted context detection — asking "will you continue?" (v2)

## Trial System

- 30 free voice messages → feedback request → 20 more free → after that 10/day or package deals (v2 monetization)
