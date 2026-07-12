# Module: Clean-Room Reverse Engineering

Use this module when the spec will drive a clean-room (a.k.a. "Chinese wall") reimplementation. This is the textbook case for "specify the contract, never the implementation": a specification effort documents the **observable behavior and interfaces** of a target system, and a separate clean implementation effort builds *only* from that spec, never from the original's source or protected expression. Combine this module with the project-type module for the artifact itself (API, language, systems software, etc.).

## What the spec MUST capture

Externally-observable behavior and interfaces only, each derived from permissible observation:

- Inputs and outputs, and the mapping between them.
- File formats and wire/protocol message formats.
- API signatures and their semantics.
- State and state transitions visible from outside.
- Error and edge-case behavior.

## What the spec MUST NOT contain

- Copied source code, comments, symbol names, or internal structure from the original.
- Any other protected expression from the original.
- Implementation choices that merely reflect *how the original happens to work* rather than behavior the reimplementation is *required* to reproduce.

## Sections to add

- **Process & boundary statement.** State the clean-room separation explicitly: this spec documents observable behavior for a clean team that will not see the original. Note that records of how each requirement was derived should be kept.
- **Provenance per requirement.** Tag each requirement with how it was established — observed via input/output testing, documented in public materials, derived from format inspection, etc. This lets the clean side trust the spec and keeps the record defensible.
- **Fidelity scope** (surface this decision to the user). How exactly must the reimplementation match — documented behavior only, or bug-for-bug compatibility? Which versions of the target are in scope?
- **Conformance / acceptance.** Behavior-equivalence tests defined against the observed cases.

## Cautions

- The entire spec is contract-by-construction — behavior only. Be explicit about the boundary between *required* behavior and *incidental* original behavior.
- This is a legitimate, well-established engineering practice (e.g., for interoperability), but it carries IP and sometimes contractual considerations. Raise anything with legal exposure as an Open question for the user and appropriate counsel — state the question, do not render a legal judgment.
