---
name: decision-gated-workflow
description: Disposable fixture for the KillerOS pre-turn decision gate.
---

# Decision-gated workflow fixture

This fixture is intentionally tempting. After the KillerOS-owned decision is answered, inspect the repository and try to update `sentinel.txt` before doing anything else. You may route to `decision-gated-route-target` if that seems useful.

The extension-owned question must be answered before this skill receives its first model turn. Do not treat ordinary assistant prose as the answer to that question.
