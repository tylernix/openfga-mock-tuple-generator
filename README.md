# OpenFGA Mock Tuple Generator

Builds a full-size mock tuple store for any OpenFGA model, and has OpenFGA check it.

You give it a model and a config (how many of each type, and a few shape numbers per relation). It writes tuples you can load with `fga tuple write` or `fga store import`.

It needs Node (tested on 24) and the [OpenFGA CLI](https://github.com/openfga/cli) (`fga`, tested on 0.8.1) on the PATH. No runtime dependencies; `tsx` and `vitest` run it and test it.

## Use it

```bash
npm install                                          # tsx and vitest, for running and testing
npx tsx src/cli.ts init model.fga --out gen.json     # every type and edge, with defaults
npx tsx src/cli.ts plan gen.json                     # tenants and projected tuples; writes nothing
npx tsx src/cli.ts verify gen.json                   # OpenFGA checks a pilot of the store
npx tsx src/cli.ts build gen.json --out tuples.csv   # the full store
```

`init --interactive` asks for the tenant type, the counts and the nesting depths. `build` also writes `.jsonl` and a `.yaml` store file, and takes `--tenants 0,3,9` to write only those tenants.

## The config

`gen.json` is the only input. Keep it in git with its seed: the same file always writes the same store.

| Field | Meaning |
|---|---|
| `counts` | Objects of each type in the whole store. |
| `tenant.type` | The type that is a tenant (an organization, a site). Every other type is split per tenant. `null` with `tenant.count` splits a model that has no tenant type. |
| `tenant.skew` | 0 makes tenants equal; 1 makes the largest far bigger than the typical one. |
| `global` | Types that are one pool shared by every tenant. |
| `edges` | One entry per way a tuple can be written, keyed `object#relation:subject`. |

Per edge:

| Field | Meaning |
|---|---|
| `coverage` | Share of objects that get any (0 to 1). |
| `count` | How many each gets: a number, `{"min","max"}`, `{"typical","p90","max"}`, or `{"share"}` of the pool. |
| `per` | `"subject"` makes `count` mean objects per subject ("groups per user"). |
| `popularity` | 0 picks subjects evenly; higher makes a few subjects much more popular. |
| `crossTenant` | Share of picks that come from another tenant. Default 0. |
| `depth`, `branching` | Nesting only. `depth` is a hard limit on levels below a top-level object. |
| `perLevel` | Average subjects per object on each nesting level, top first. |
| `context` | Condition context written on every tuple of a conditioned edge. |

The defaults are guesses. They are written into the config so you see them and change them.

## What it guarantees

These are re-derived from the written tuples on every build. If one fails, the build exits 1.

- No tree is deeper than the asked `depth`, and none has a cycle.
- A nested object is in the same containers as its parent.
- No tuple crosses tenants unless its edge sets `crossTenant`.

Other properties:

- **Same input, same store.** Each object's draws depend only on the seed, the edge and the object. A tenant built alone is identical to its slice of the full store, and changing one edge's settings changes no other edge's tuples.
- **Nothing is silent.** The build report lists, per edge, asked versus realized counts, the fit (Kolmogorov-Smirnov distance), the side you did not ask for (tuples per subject), and anything clipped, skipped or dropped.
- **Gated relations get subjects who pass the gate.** For `[user] and member from org`, only org members are written.

## What `verify` proves, and what it does not

`verify` builds a few whole tenants, loads them into the CLI's in-memory OpenFGA with `fga model test`, and compares OpenFGA's ListUsers and Check answers with its own on a spread of objects. It also reports reach: the share of a tenant's users who hold each relation.

It proves the tuples are accepted and mean what the report says. It does not prove the store looks like a real customer's. That depends on the numbers you put in the config.

## Limits

- A relation followed by `from` is a container link when what is read through it can be held by another type (a folder's viewers are users). A link from user to user is an assignment. Check the `kind` that `init` writes for each edge.
- Gates are applied to plain subjects on assignments only, and a gated edge cannot cross tenants.
- Conditional tuples are written with the context you give. Answers that depend on a condition or a public grant are not asserted by `verify`.
- When a type has several containers of equal depth, its trees are built inside the first by name.
- Counts are not correlated across edges: a big organization does not get bigger teams unless you say so per edge.

## Benchmarks

Run them yourself; every number below comes from this one command and is checked, not asserted:

```bash
npx tsx bench/bench.ts          # a few minutes (the 10x run alone is 100 seconds); exits 1 if any check fails
npx tsx bench/bench.ts --quick  # skips the 100-million-tuple run
```

Measured on an Apple M3 Pro (11 cores, 18 GB), Node 24.14, OpenFGA CLI 0.8.1, 2026-11-14. One run each; speed varies by a few percent between runs. Each scale row is a separate process, so its peak memory is its own.

### Scale and speed

The model is [gdrive.fga](bench/models/gdrive.fga): organizations that contain groups, nested folders and documents, with users, group members, owners and a `but not` exclusion. Every row used the default shape numbers, with nesting depth 3.

| model, size | output | objects | tenants | tuples | seconds | tuples / second | peak memory (MB) | file (MB) | rule violations | depth reached / asked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gdrive, 0.01x | CSV file | 23,705 | 5 | 105,465 | 0.1 | 871,612 | 96 | 4 | 0 | 3/3, 3/3 |
| gdrive, 0.1x | CSV file | 237,050 | 50 | 1,057,488 | 1.0 | 1,020,741 | 227 | 38 | 0 | 3/3, 3/3 |
| gdrive, 1x | CSV file | 2,370,500 | 500 | 10,579,235 | 9.9 | 1,070,773 | 288 | 406 | 0 | 3/3, 3/3 |
| gdrive, 1x | /dev/null | 2,370,500 | 500 | 10,579,235 | 9.9 | 1,068,718 | 304 | - | 0 | 3/3, 3/3 |
| gdrive, 10x | /dev/null | 23,705,000 | 5,000 | 105,829,695 | 99.5 | 1,064,086 | 324 | - | 0 | 3/3, 3/3 |
| gated, 1x | CSV file | 210,200 | 200 | 335,668 | 2.7 | 124,046 | 251 | 10 | 0 | - |

- **About a million tuples per second, flat from 1 million to 106 million tuples.** Memory does not grow with size (96 MB at 100,000 tuples, 324 MB at 106 million) because tenants are generated one at a time.
- **`/dev/null` means the tuples were generated and formatted as CSV, then written to `/dev/null`:** generation without the disk. Writing a CSV file costs almost nothing extra here. A CSV is about 40 bytes per tuple, so 100 million tuples is about 4 GB.
- **The gated model ran about 9x slower per tuple** (124,000 tuples per second). It picks subjects who pass `[user] and member from org`, which means evaluating the rule per object. I expect that is the cost but did not profile it; the model also writes far fewer tuples per object.
- **The 10x store was generated and counted, not loaded into OpenFGA.** Only pilots are loaded (below).

### Determinism

| check | result | detail |
| --- | --- | --- |
| same config twice writes the same store | PASS | sha256 3a0b509f4839b8b1 both times, 27,137 tuples |
| a different seed writes a different store | PASS | sha256 b28e5729fbc4406e |
| each tenant built alone is exactly its slice of the full store | PASS | 12 tenants, 27,137 tuples |
| tenants can be built in any order | PASS | tenants 11 down to 0, compared as sets |
| changing one edge's settings changes no other edge's tuples | PASS | folder#viewer:user went from 969 to 4,229 tuples |

### Independent check of the output file

This re-reads the 1,057,488-tuple CSV and derives everything from the tuples and the model JSON. It uses none of the generator's own reports.

| check | result | detail |
| --- | --- | --- |
| every tuple is a type restriction the model allows | PASS | 1,057,488 tuples read, 0 not allowed |
| no tuple written twice | PASS | 0 duplicates |
| folder trees no deeper than the asked 3, no cycles | PASS | deepest 3, 0 cycles, 13,475 nested folders |
| group trees no deeper than the asked 3, no cycles | PASS | deepest 3, 0 cycles, 558 nested groups |
| every nested object is in the same organization as its parent | PASS | 0 of 14,033 parents outside |
| every user and group sits in the organization of the object it is written on | PASS | 0 of 827,013 tuples cross organizations |
| every user is in one organization | PASS | 0 users in two or more |

### OpenFGA agrees

A pilot is whole tenants, exactly as they are in the full store. It is loaded into the CLI's in-memory OpenFGA (`fga model test`), which answers ListUsers and Check on a spread of objects. Its answers must match what the generator's own evaluator says. "Not asserted" answers read a condition or a public grant, or list more than 200 users.

| model | pilot tuples | tenants | ListUsers | Check | not asserted | seconds | result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| drive (wildcards, conditions, nesting) | 4,016 | 3 | 121/121 | 169/169 | 15 | 0.3 | PASS |
| gated (intersections, exclusions) | 543 | 3 | 86/86 | 113/113 | 0 | 0.1 | PASS |
| rbac (roles with no org link) | 1,868 | 3 | 63/63 | 97/97 | 0 | 0.1 | PASS |
| nested (two containers per folder) | 6,069 | 1 | 89/89 | 127/127 | 0 | 0.4 | PASS |
| drive, larger pilot | 27,069 | 3 | 113/113 | 152/152 | 23 | 6.1 | PASS |

Verifying is the slow part, not generating: 27,069 tuples take 6 seconds to check, and generating them takes well under a second. That is why `verify` loads a pilot and not the whole store.

### What these do not show

- **Realism.** They show the store is valid, deterministic and as asked. Whether the asked numbers look like a real customer is up to your config.
- **Other machines.** These are one run on one laptop. Rerun the command for yours.
- **Load time into a real OpenFGA server.** Only the CLI's in-memory server is used.

## Tests

```bash
npx vitest run
```
