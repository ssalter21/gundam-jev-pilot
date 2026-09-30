# Deck name goes here

<!--
Copy this file to jev-decks/<something>.md and fill it in, or use the studio (pnpm jev:studio),
which writes this same format. Everything is plain English.
Only the Decklist is required, plus either a Playstyle or at least one Game plan.

Tips that make the bot noticeably better:
- Playstyle (Aggro / Midrange / Control) sends that guide from jev-guides/ to the bot. If you
  write no Game plans, it uses the guide's default plans.
- Overview is the overall strategy. Key plays are the specific lines to look for.
- Write plans as "When: <board condition>. Do: <what to prioritise>." The bot re-picks its plan
  at the start of every one of its turns by matching the "When" parts against the board.
- Write rules as priorities or conditions, not vibes. "Hold Hawk of Endymion for their Blocker
  when they are on 2 shields" beats "use removal well".
- The bot already sees exact numbers (AP, HP left, whether an attack kills, shields left, whether
  a hit wins the game). You don't need to explain maths, only what matters and when.
- Card notes are only sent while that card is visible (in its hand or on either board), so it's
  fine to write one for every card.
-->

## Playstyle
Midrange

## Decklist
<!-- One card per line: "4x GD01-008" (also "4 GD01-008", "GD01-008 x4"). Must total 50. -->
4x GD01-001
4x GD01-002
resource 10 R-001

## Overview
Two or three sentences: what the deck wants to do and how it wins.

## Key plays
- Turn 4: pair <pilot> onto <unit> to link and attack the same turn.
- Hold <command> for their Blocker when they are on 2 or fewer shields.

## Game plans
<!-- Optional when a Playstyle is set. Writing any plans here replaces the playstyle's defaults. -->

### opening
When: turns 1-3. Do: ...

### closing
When: the opponent is on 2 or fewer shields, or ... Do: ...

## Rules
- Always take an attack option that says it wins the game.
- If a direct attack on me would lose me the game, block it if any option allows.

## Card notes
- GD01-001: when to play it, what to target, what to pair it with.
- Card Name Also Works: note.
