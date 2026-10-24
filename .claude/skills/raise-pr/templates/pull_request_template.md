<!--
Title: [ITEM] Short imperative summary
Rules: .claude/skills/raise-pr/SKILL.md. Never list files or features; the diff shows them.
Delete a section only when it truly has nothing to say. Never delete the top line or Verification.
-->

Replace this line with one sharp sentence: what this PR makes possible or changes, and why it matters.

Closes #

<!-- Use "Refs #" instead if this PR doesn't finish the issue. -->

## Why

<!-- The problem and the approach, in one to three sentences. -->

## How it works

<!--
Complex data-model interaction or a cross-boundary change (between owners, to an outside service, a lifecycle)?
Add a small Mermaid diagram: about 8 nodes or fewer, every arrow labelled with what moves, then one sentence.
Otherwise delete this section.
-->

## Decisions and trade-offs

<!-- Required for any critical technical decision. List every option you seriously considered. -->

| Option | Trade-offs | Chosen? |
| --- | --- | --- |
|  |  |  |

## Scope

<!-- What this covers and what it deliberately leaves out. -->

## Blast radius

<!-- Who or what this touches, and why that is safe or risky. -->

## Verification

<!-- Each command you ran and the key line it printed. "inconclusive" plus the reason if a check couldn't run. -->

-

## Contract

- [ ] This PR does not touch the contract in `packages/core`
- [ ] This PR changes the contract: labelled `contract`, the other owners requested for review
