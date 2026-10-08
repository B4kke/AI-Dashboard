# AI Dashboard — Design Principles

**Status:** Binding visual and interaction design contract  
**Date:** 2026-08-25  
**Applies to:** Dashboard, Project workspaces, onboarding/discovery, Tasks, Agents, GitHub/CI, Research, Evidence and System UI

## 1. Role of this document

This document defines **how AI Dashboard should feel and behave as a product**.

It is not a roadmap and must not compete with `docs/04-roadmap.md`.

- `docs/01-product-plan.md` defines what the product is.
- `docs/02-architecture.md` defines how the control plane works.
- `docs/04-roadmap.md` defines implementation priority.
- `docs/10-project-first-ux-discovery.md` defines the Project-first/discovery implementation slice.
- **this document defines the visual hierarchy, interaction rules and usability quality bar.**

Control-plane safety always wins over convenience. Design must make fail-closed state understandable; it must never hide or weaken it.

The design may learn from VibeBoard, Codeman, OpenHands and later Odysseus product/UX ideas, but AI Dashboard must develop its own coherent visual language rather than copy an upstream interface.

---

## 2. Product design goal

AI Dashboard should feel like a **calm mission-control workspace for projects**, not like a database admin panel and not like a wall of developer telemetry.

The first screen should answer, in seconds:

1. What Projects do I have?
2. Which Projects are active?
3. What is working right now?
4. What needs my attention?
5. What happens next?

Technical detail remains available, but appears after the operator asks for it.

**Complexity belongs in the control plane. Clarity belongs in the UI.**

---

## 3. Project is the primary visual object

`Project` is the domain root for executable work and must also be the primary visual root.

The Dashboard homepage is therefore primarily a **Project overview**.

A Project may be represented as a rich card because it is a durable workspace with meaningful aggregate state.

Do **not** mechanically turn every Task, Run, PR, check, provider, integration and evidence item into another elevated card.

Inside a Project, prefer:

- clear sections,
- compact lists,
- timelines,
- tables where comparison matters,
- expandable detail,
- drawers/dialogs for focused work.

This is an explicit anti-`card soup` rule.

### Project card anatomy

The normal Project card should have a predictable hierarchy:

```text
Project name                              status
Short description

Current / next work
Worker / attention state

small secondary summary
```

Secondary summary may contain a few of:

- PR state,
- CI state,
- open Task count,
- active agent count,
- last meaningful activity.

Do not show all available metadata simply because it exists.

A Project card may expand or open the Project workspace, but card expansion must not become a miniature copy of the entire workspace.

---

## 4. Progressive disclosure

The default information hierarchy is:

```text
Dashboard
    ↓
Project
    ↓
Task / Agent / PR / Research / Evidence
    ↓
Advanced technical detail
```

Primary views should describe meaning and action.

Advanced/debug views may expose implementation truth such as:

- exact domain state,
- IDs,
- SHAs,
- branch/worktree,
- harness/provider/model identity,
- raw logs,
- raw evidence JSON.

The rule is:

> **hide complexity by default; never destroy evidence.**

Every human-readable summary should remain traceable to canonical evidence.

---

## 5. Attention hierarchy

Visual prominence follows operational importance, not storage schema.

Priority of attention:

1. **Needs operator attention** — blocked, `needs_input`, `needs_sync`, required CI failure, identity/sync blocker
2. **Active work** — worker, supervisor or research currently running
3. **Next ready action** — Task ready, review ready, merge ready
4. **Healthy/idle state**
5. Historical/debug information

Examples:

- A failed required check is more important than a counter showing 17 completed Tasks.
- A worker running on a Project should be visible from the Dashboard without opening a global Runs list.
- A Project waiting for operator input must not look merely "inactive".

---

## 6. Human language first

Canonical state-machine names remain unchanged in the backend.

Primary UI copy translates them into operator language.

Prefer:

```text
GitHub tests are running
Needs your input
Worker is implementing terrain streaming
Ready for supervisor review
Project needs synchronization
```

instead of:

```text
awaiting_ci
needs_input
in_progress
awaiting_review
needs_sync
```

Internal names may be shown in Advanced/Debug detail.

The UI should answer **why** something stopped and **what can happen next**, not just display a state code.

---

## 7. One primary action per surface

Each major surface should have one dominant action.

Examples:

- Dashboard → **Add / discover Project**
- discovered local repository → **Import**
- GitHub-only repository → **Clone & import**
- Project with no active work → **Create Task**
- blocked Task → **Respond / repair**
- ready-to-merge Task → **Review merge**

Secondary actions must remain visually secondary.

Do not repeat the current pattern where several unrelated creation actions compete in the same header.

Destructive or irreversible actions must be visually distinct and must never become the default primary action merely because they are currently available.

---

## 8. Navigation is workspace-oriented

The product must move away from one long page containing nearly every system concept.

Primary global navigation should trend toward:

```text
Dashboard
Projects
Exploration
System
```

Opening a Project changes context to that Project and exposes Project-specific navigation such as:

```text
Overview
Tasks
Agents
GitHub
Evidence
Research
Settings
```

Global provider/runtime configuration belongs outside ordinary Project work.

The operator should always know:

- which Project is open,
- how to return to the Dashboard,
- where a running worker belongs,
- whether a displayed Task/PR/Run is Project-scoped.

Navigation depth should stay shallow. Do not introduce nested navigation purely to mirror backend object relationships.

---

## 9. Status and color semantics

Color carries meaning, not decoration.

Use a small semantic state palette:

- **healthy / complete**
- **active / running**
- **warning / waiting**
- **blocked / failed**
- **neutral / inactive**

Rules:

- The same state family uses the same visual meaning across the product.
- Never rely on color alone; combine it with text and/or iconography.
- Avoid arbitrary per-model/per-provider rainbow coloring in primary views.
- Keep the primary accent restrained so it still communicates priority when used.
- Running state may use subtle motion; failed/blocked state should not need animation to be noticeable.

---

## 10. Typography and information density

AI Dashboard must remain comfortably readable on Android without zooming.

Guidance:

- normal body/control text: approximately `14px` or larger,
- secondary metadata: approximately `12px` or larger,
- essential Project/Task/status text must not rely on 9–10px typography,
- touch targets in primary mobile flows should be approximately `44px`,
- line height should favor scanning over maximum density.

Small uppercase eyebrow labels may be used sparingly as tertiary structure, but must not carry important operational information.

Dense technical surfaces are allowed under Advanced/Debug views.

The current UI contains several 9–10px status/label elements; those are not an acceptable baseline for essential mobile state.

---

## 11. Layout and spacing

Prefer a consistent spacing scale rather than one-off gaps.

Recommended base rhythm:

```text
4 / 8 / 12 / 16 / 24 / 32
```

Use larger whitespace to separate concepts; use borders and cards only when they add hierarchy.

Do not put a border and rounded background around every region.

Desktop Project overview may use a Project-card grid. Project detail should usually use a strong page header plus structured sections rather than nested grids of panels.

---

## 12. Surfaces and elevation

Elevation should communicate hierarchy.

Recommended direction:

- app canvas: lowest level,
- main Project card / dialog / focused overlay: elevated,
- ordinary rows/lists inside a Project: mostly flat,
- debug/log terminal: visually distinct but subordinate.

A border, radius and background are not automatically required for every component.

If everything is elevated, nothing is elevated.

---

## 13. Live activity should feel alive, not noisy

SSE/live state is a core product advantage.

Use it to update meaningful product state:

- worker running indicator,
- Task phase,
- CI transition,
- supervisor verdict,
- blocker,
- completion.

The raw control-plane event stream is for diagnostics, not the normal progress experience.

Subtle animation may communicate a running worker or pending action. Avoid constant movement across the Dashboard.

Respect `prefers-reduced-motion` for non-essential motion.

---

## 14. Empty states are onboarding surfaces

An empty surface should explain the next meaningful action.

Example first-run Dashboard:

```text
No Projects yet

Choose the folder where your Projects live.
AI Dashboard can discover local Git repositories and match them with GitHub.

[Choose Project folder]
[Import from GitHub]
```

Likewise:

- Project with no Tasks → explain and offer **Create Task**,
- GitHub not connected → explain what GitHub enables,
- no active worker → show healthy idle/ready state instead of an empty run table,
- no Research → explain that Research is read-only and Project-scoped.

Empty-state copy should teach the product model without forcing the operator to read architecture documentation.

---

## 15. Forms and onboarding

Default forms must ask only for information the Dashboard cannot safely infer.

Project import should not ask for:

- repo path if selected/discovered,
- GitHub repository if matched from origin,
- base branch if Git can determine it,
- four model-role defaults when global defaults exist,
- verification commands when safe candidates can be proposed,
- low-level autonomy controls during ordinary import.

Advanced settings remain available through progressive disclosure.

Large configuration forms are a failure mode for normal onboarding even if every individual field is technically valid.

---

## 16. Feedback, errors and repair

Normal product flows must not rely on:

- `window.alert()`,
- `window.prompt()`,
- `window.confirm()`.

Use:

- contextual inline errors,
- toasts for transient success/failure,
- proper dialogs/drawers for focused input,
- first-class repair surfaces for blocked Tasks/Projects.

Example:

```text
Project needs synchronization
Remote main moved after this Task started.

[Inspect change]  [Sync & re-check]
```

or:

```text
CI failed
2 required checks failed.

[View checks]  [Send back to worker]
```

A fail-closed stop should feel deliberate and understandable rather than like the Dashboard crashed.

---

## 17. Evidence UX

Evidence is essential, but raw JSON is not the primary operator representation.

Prefer grouped evidence:

### Code
- changed files,
- diff summary,
- scope validation,
- checkpoint SHA.

### Verification
- commands,
- result,
- relevant output.

### GitHub
- PR,
- exact head/base,
- required checks,
- branch/ruleset state.

### Supervisor
- verdict,
- criteria,
- requested changes,
- risks.

### Merge
- reviewed SHA,
- merge SHA,
- final verification,
- cleanup state.

Raw evidence remains available under Advanced/Debug.

---

## 18. Responsive behavior is designed, not compressed

Desktop must not simply shrink until it technically fits a phone.

Target behavior:

- **desktop:** Project grid / spacious Project workspace,
- **tablet:** reduced columns with the same hierarchy,
- **phone:** single-column Project cards and focused Project views.

At approximately `360–430px` width:

- no required horizontal page scrolling,
- no horizontal primary navigation that hides important destinations,
- Project name/status/next action visible without expansion,
- primary actions comfortably tappable,
- secondary metadata collapses before primary information,
- essential state text readable without zoom.

A horizontally scrollable technical timeline may be acceptable inside an explicitly technical detail view; horizontal scrolling must not be required for the primary workflow.

---

## 19. Accessibility baseline

At minimum:

- visible keyboard focus,
- semantic buttons and links,
- icon-only actions have accessible labels,
- dialogs manage and restore focus correctly,
- status is not encoded by color alone,
- adequate text/background contrast,
- reduced-motion preference respected,
- interactive Project cards are keyboard operable if the whole card is clickable.

Accessibility is part of quality, not a post-beta decoration pass.

---

## 20. Design tokens and component consistency

Visual constants should be tokenized.

At minimum maintain tokens for:

- canvas/background,
- surfaces,
- borders,
- primary/secondary/muted text,
- accent,
- success/active/warning/danger,
- spacing,
- radius,
- typography,
- motion.

Reuse existing components and tokens before adding one-off CSS.

A design change that requires repeated literal values should usually introduce or reuse a token.

Do not blindly copy VibeBoard's exact color values, radii or component implementation. Reuse the **principles** where they improve clarity.

---

## 21. Design non-goals

AI Dashboard must not become:

- a generic SaaS admin dashboard,
- a wall of KPI cards,
- a clone of GitHub,
- a clone of VibeBoard Kanban,
- a terminal/log viewer with buttons around it,
- a nested-card interface where every object gets its own rounded box,
- an ornamental "AI" interface where animation replaces real state.

The intended character is **technical, calm, precise, modern and operational**.

---

## 22. Visual acceptance gate

Frontend work is not complete solely because syntax/unit tests pass.

Before a significant design slice is considered complete, inspect the **real rendered UI** at minimum at approximately:

- `1440px` desktop width,
- `768px` tablet width,
- `390px` Android/mobile width.

Use rendered pages/screenshots, not only DOM assertions.

Review:

1. Can a new user identify Projects immediately?
2. Is the active worker/Project obvious?
3. Is the next action obvious?
4. Are blockers stronger than routine metadata?
5. Is there more than one competing primary action?
6. Is essential text comfortably readable on mobile?
7. Does a primary workflow require horizontal page scrolling?
8. Has technical metadata displaced Project/Task meaning?
9. Has card soup been reintroduced?
10. Can advanced evidence still be reached?
11. Are empty states useful rather than blank?
12. Does the visual result still look coherent when Projects have long names/descriptions, many Tasks or failed CI?

For `docs/10-project-first-ux-discovery.md`, the final visual dogfood journey is:

```text
first launch
 -> choose Workspace Root
 -> discover repositories
 -> import one Project
 -> see it on Dashboard
 -> open Project
 -> create/select Task
 -> worker starts
 -> observe live state
 -> CI failure
 -> clear repair state
 -> supervisor review
 -> merge
 -> Project card returns to clear healthy/next-work state
```

The visual/usability review must be performed on the **exact commit** being considered complete.

---

## 23. Source-derived principles

### VibeBoard

Useful principles retained:

- strong task/status hierarchy,
- semantic color,
- one primary action per surface,
- live agent feedback,
- responsive/mobile intent,
- deliberate component/token consistency.

AI Dashboard deliberately does **not** inherit a Kanban-first/card-everything product model.

### OpenHands

Useful principles retained:

- workspace/project boundary,
- separation of agent execution from workspace identity,
- low-friction existing-project entry,
- local project-root concept as a natural onboarding model.

### Codeman

Useful principles retained:

- mission-control framing,
- persistent agent visibility,
- operator attention and recovery as first-class UI,
- mobile visibility into long-running work.

### OpenCode

Useful principles retained:

- harness capabilities surfaced without letting the harness become the product domain,
- agents/models/tools are selectable capabilities rather than global Dashboard truth.

### Odysseus

Useful later-direction principles:

- coherent workspace shell,
- conversational access to a broader control center,
- persistent assistant/Master experience.

Those later features must not displace the immediate Project-first and control-plane usability gates.
