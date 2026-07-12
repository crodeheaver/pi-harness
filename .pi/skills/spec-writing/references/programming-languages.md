# Module: Programming Languages, Compilers & DSLs

Fold these sections into the spec spine when specifying a language, compiler, interpreter, or DSL. The crucial distinction: the **language definition** is the contract; a **particular compiler or runtime** is an implementation of it. Specify the definition; leave parser technology, codegen, and optimization passes to the implementer.

## Sections to add

- **Design tenets.** What the language optimizes for and the tradeoffs it accepts (e.g., safety vs raw speed, expressiveness vs simplicity). These guide every later decision.
- **Lexical structure.** Tokens, literals, identifiers, keywords, comments, whitespace significance — the surface, not the lexer's internals.
- **Grammar / syntax.** The concrete and abstract syntax, given in a standard notation (e.g., EBNF). This is the contract any implementation must parse.
- **Static semantics.** The type system (typing discipline, inference, subtyping, generics), name resolution and scoping, and the module/namespace system. State the rules an implementation must enforce.
- **Dynamic semantics.** The evaluation/execution model; the memory model and its observable guarantees (ownership, lifetimes, or GC stance — as guarantees, not as a chosen GC algorithm); the error/exception model; and the concurrency model with its memory-ordering guarantees.
- **Standard library scope.** What is built into the language vs provided by the stdlib, described as capabilities and contracts rather than implementations.
- **Tooling surface that is part of the contract.** Source file extension, program entry point, and the compilation/interpretation model as observable behavior.
- **Conformance.** What makes an implementation conformant; what behavior is explicitly reserved or undefined.

## Cautions & conventions

- Specify semantics precisely — they are the contract every implementer and every program author relies on. Leave parsing strategy, IR, and optimization entirely open.
- Include **illustrative examples for any non-obvious rule**: well-formed and ill-formed snippets paired with their expected outcome. These double as acceptance criteria and resolve ambiguity better than prose.
- Ground the design in prior art via research: how do comparable languages define this feature? Flag genuinely novel semantics as areas needing extra rigor and worked examples.
- Reserve room for the implementer: state where behavior is unspecified or implementation-defined on purpose, so an implementer does not mistake an incidental choice for a requirement.
