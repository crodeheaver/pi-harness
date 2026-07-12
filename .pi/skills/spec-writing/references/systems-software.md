# Module: Systems Software

Fold these sections into the spec spine for an operating system, kernel, game engine, runtime, driver, or embedded/firmware project. These systems are defined by their **interface contracts and their observable guarantees** (timing, memory, failure behavior). Specify those; leave the choice of internal data structures and algorithms to the implementer unless a guarantee forces a particular one.

## Sections to add

- **Platform & environment assumptions.** Target hardware/ISA, privilege levels, the boot/init context the code runs in, toolchain and ABI expectations, and which runtime services are available vs forbidden. These are real constraints — tag each with its source.
- **Subsystem decomposition.** The major subsystems and the interface each must provide to the others — the internal contracts — without dictating each subsystem's internals.
- **Resource model.** Guarantees for memory (layout, allocation behavior, alignment), CPU/scheduling, I/O, interrupts/IRQs, and time. Specify the guarantees, not the algorithms that deliver them.
- **Concurrency & synchronization.** The concurrency model, reentrancy rules, what may run in interrupt vs normal context, and memory-ordering guarantees.
- **Public interfaces.** The externally-observable surface at the contract level — the syscall/ABI for a kernel, the engine API, a driver's operations table.
- **Fault & failure model.** How faults are detected, contained, and reported; panic/abort semantics; recovery behavior; and the safety and liveness properties that must hold.
- **Performance & footprint budgets.** Quantified: latency bounds, memory ceilings, and real-time deadlines where applicable.
- **Conformance.** The hardware specs, device specs, or standards the implementation must satisfy.

## Cautions & conventions

- State observable guarantees and interface contracts; leave data-structure and algorithm choices open unless a stated guarantee (e.g., a hard real-time deadline) constrains them.
- For real-time or safety-critical scope, make timing and failure behavior explicit and testable — these are the requirements that matter most and are easiest to leave dangerously vague.
- **Ground every hardware-facing claim in the actual platform documentation via research.** Do not guess register layouts, ABI calling conventions, or device behavior — verify them against the ISA/device manuals and flag anything unverified as an Open question.
