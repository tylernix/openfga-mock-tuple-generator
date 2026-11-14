# OpenFGA Mock Tuple Generator

Builds a full-size mock tuple store for any OpenFGA model, and has OpenFGA check it.

You give it a model and a config (how many of each type, and a few shape numbers per relation). It writes tuples you can [load](#load-the-tuples-into-fga) with `fga tuple write` or `fga store import`.

## Dependencies
- Node (tested on 24) 
- [OpenFGA CLI](https://github.com/openfga/cli) (`fga`, tested on 0.8.1) on the PATH. 
- No runtime dependencies; `tsx` and `vitest` run it and test it.

## Use it

### init

Start with the `init` command. It asks a few questions and builds your config file. This runs on an included sample model:

```bash
npm install
npx tsx src/cli.ts init bench/models/simple.fga
```

Press Enter to take the default in brackets.

[simple.fga](bench/models/simple.fga) is a small team document app. Users belong to organizations, every document is in one organization and has an owner, and a document can be viewed by its owner, by people it is shared with, or by every member of its organization:

```
model
  schema 1.1

type user

type organization
  relations
    define member: [user]

type document
  relations
    define org: [organization]
    define owner: [user]
    define viewer: [user] or owner or member from org
```

For your own model, put its path in place of `bench/models/simple.fga` (a `.fga` or `.json` file). The questions are always the same three kinds: which type is a tenant, how many objects of each type, and, if the model nests a type inside itself, how deep.

To skip the questions, add `--skip`: `init <model> --skip` writes the same file with every default, and you edit it by hand (see [The config](#the-config)).

`init` names the file by date and time, like `20261113-0936.gen.json`, so a second run never overwrites the first. You don't need to type that name later: `plan`, `verify` and `build` use the newest `*.gen.json` in the folder and print which one (`Using 20261113-0936.gen.json`). To use another, put its name after the command.

### plan

Once you have a config file, the other commands read it.

`plan` plans the tenants and projected tuples, but writes nothing.
```bash
npx tsx src/cli.ts plan
```

### verify

`verify` uses OpenFGA to check a sample of the store
```bash
npx tsx src/cli.ts verify
```

### build

`build` creates the full store

```bash
npx tsx src/cli.ts build --out tuples.csv
```

`build` also writes `.jsonl` and a `.yaml` store file, and takes `--tenants 0,3,9` to write only those tenants, or `--scale 0.01` to shrink every count to 1%. 

## The config

The config (a `*.gen.json` file) is the only input. Keep it in git with its seed: the same file always writes the same store.

This is the simplest config you can make. Two fields: the model file and how many object of each type you want.

```json
{
  "model": "models/simple.fga",
  "counts": { "user": 5000, "organization": 50, "document": 100000 }
}
```

Try it:

```bash
npx tsx src/cli.ts plan   bench/simple.smallest.gen.json    # about 399,000 tuples
npx tsx src/cli.ts verify bench/simple.smallest.gen.json    # OpenFGA agrees: 48/48 ListUsers, 57/57 Checks
```

The defaults are plain: every user belongs to one organization, every document is in one organization, and half of the documents have an owner and half have direct viewers, typically 2 each. That is why the next step exists. Every type in the model needs a count; if one is missing, the tool stops and names it (`counts.user is missing`).

### One step up: set two relations

To choose the shape of a relation, add it under `edges`. This is [bench/simple.gen.json](bench/simple.gen.json), the config the simple benchmarks run: every document has exactly one owner, and 30% of documents are also shared directly with a few people (typically 3, at most 50).

```json
{
  "model": "models/simple.fga",
  "counts": { "user": 5000, "organization": 50, "document": 100000 },
  "edges": {
    "document#owner:user": { "coverage": 1, "count": 1 },
    "document#viewer:user": { "coverage": 0.3, "count": { "typical": 3, "p90": 10, "max": 50 } }
  }
}
```

`coverage` is the share of documents that get any, and `count` is how many each gets: a number, or a spread (`typical`, `p90`, `max`). The other two relations stay at their defaults and still show as warnings. Run `init <model> --skip` to get every relation written out, each with its default and the question it answers.

The benchmarks check this config's output file: every document has exactly one owner, owners and direct viewers are members of the document's organization, 29.9% of documents are shared, and the largest organization has 22,226 documents against 444 for the smallest (see [Benchmarks](#independent-check-of-the-simple-output-file)).

### All the fields
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

## How it works

The model defines which tuples are allowed. The tool reads the model, builds the store one tenant/org at a time, and verifies its own work using OpenFGA. Review the [Benchmarks](#benchmarks).

1. **Read the model.** Every direct type restriction becomes an *edge*, one way a tuple can be written: `document#viewer: [user, group#member]` is two edges. Each edge is classified by how the model uses it: a *container* link (followed by `from`, pointing at a place such as a folder or an organization), *nesting* (a type inside itself, like `folder#parent`), an *assignment* (people or groups given a relation), a *block* (only used on the right of `but not`), or a *wildcard* (a public grant).
   *Why it works?* Tuples come only from the model's own type restrictions, so the tool cannot write a tuple the model does not allow, and it does not need a hand-written generator per model.
2. **Split by multi-tenancy before writing anything.** It picks the tenant type (an organization, a site; any type you specify in the config file) and gives every object a tenant. Both ends of a tuple come from the same tenant unless an edge sets `crossTenant`.
   *Why it works?* Picking users, groups and folders at random across a whole store would link everyone to everything. Real applications are made up of many organizations that mostly do not touch, and this keeps that shape.
3. **Write in dependency order.** Containers go first, outermost first (a folder's organization before a document's folder), so an object can follow its container upward. Each type's nesting is built right after its own container links, so a tree can stay inside its container. Assignments, public grants and exclusions come after. A relation whose rule is an intersection, such as `[user] and member from org`, waits for the relations that rule reads, and only subjects who pass the rule are written.
   *Why it works?* Otherwise random subjects almost never pass an intersection, and the relation ends up empty.
4. **Build trees level by level.** The nested objects in a container are split into levels with at least one object each, and each object picks its parent from the level above. A nested object also takes the same containers as its parent.
   *Why it works?* A tree built this way is never deeper than the `depth` you asked for and cannot contain a cycle. It is exactly that deep when its container has at least `depth + 1` nested objects; smaller containers get shallower trees, and the report lists them. Picking a random earlier object as the parent gives a depth nobody chose: a simple generator that did that reached 22 to 24 levels at 200,000 folders in a test.
5. **Draw every number from the object it is for.** Each random draw comes from a stream keyed by the seed, the edge and the object's index, not from one shared stream.
   *Why it works?* The same config writes the same store (the benchmarks compare hashes), a tenant built alone is identical to its slice of the full store, and changing one edge's settings changes no other edge's tuples.
6. **Stream it, tenant by tenant.** Only the tenant being built is held in memory, and tuples are written out as they are made.
   *Why it works?* Memory depends on the largest tenant, not on the size of the store. The 106 million tuple store ran in 338 MB, against 96 MB for a 105,000 tuple one.
7. **Check its own work.** After each tenant, a separate pass re-derives depth, cycles, containers and tenant crossings from the parent and container choices behind the tuples it wrote, and the build compares the realized counts with what you asked for. A broken rule fails the build.
   *Why it works?* The rules are checked on the result, not assumed from the code that made it. The benchmarks go further and re-read a written file with code that shares nothing with the generator.
8. **Final OpenFGA check.** `verify` writes a few whole tenants into the CLI's in-memory OpenFGA and compares its answers with the tool's own.
   *Why it works?* An independent implementation agrees on who can access what.

What none of this decides is whether the shape matches your customers. The counts and spreads in the config are yours, and the defaults are guesses.

## What it checks

These are checked on every build, in a separate pass over what was written. If one fails, the build exits 1.

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
npx tsx bench/bench.ts          # about 5 minutes (5 min 13 s on the machine below); needs about 4.5 GB of free disk
npx tsx bench/bench.ts --quick  # skips the 100-million-tuple runs and the 4 GB files
```

### Scale and speed

Two models run at several sizes. [simple.fga](bench/models/simple.fga) is the example above, with [simple.gen.json](bench/simple.gen.json). [gdrive.fga](bench/models/gdrive.fga) is bigger: organizations that contain groups, nested folders and documents, with users, group members, owners and a `but not` exclusion, with [gdrive.gen.json](bench/gdrive.gen.json) (shown [below](#the-config-the-benchmark-used)). Every row uses the config's own numbers, scaled with `--scale`.

Every row writes the whole CSV to disk, then re-reads the file line by line, counts the rows and checks that each is a type restriction the model allows. The file is deleted afterwards. Seconds include writing the file.

Measured on an Apple M3 Pro (11 cores, 18 GB), Node 24.14, OpenFGA CLI 0.8.1, 2026-11-14. One run each; speed varies by a few percent between runs. Each scale row is a separate process, so its peak memory is its own. It is taken before the file is re-read.

| model, size | objects | tenants | tuples | seconds | tuples / second | peak memory (MB) | CSV size (MB) | rows re-read from the file | rows the model does not allow | rule violations | depth reached / asked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| simple, 1x | 105,050 | 50 | 345,204 | 0.3 | 1,369,857 | 144 | 12 | 345,204 | 0 | 0 | - |
| simple, 10x | 1,050,500 | 500 | 3,440,717 | 2.3 | 1,518,410 | 253 | 127 | 3,440,717 | 0 | 0 | - |
| simple, 100x | 10,505,000 | 5,000 | 34,413,756 | 21.6 | 1,594,706 | 307 | 1,335 | 34,413,756 | 0 | 0 | - |
| **simple, 300x** | **31,515,000** | **15,000** | **103,189,935** | **66.0** | **1,562,939** | **337** | **4,122** | **103,189,935** | **0** | **0** | - |
| gdrive, 0.01x | 23,705 | 5 | 105,465 | 0.1 | 901,410 | 96 | 4 | 105,465 | 0 | 0 | 3/3, 3/3 |
| gdrive, 0.1x | 237,050 | 50 | 1,057,488 | 1.0 | 1,043,917 | 226 | 38 | 1,057,488 | 0 | 0 | 3/3, 3/3 |
| gdrive, 1x | 2,370,500 | 500 | 10,579,235 | 9.9 | 1,068,394 | 288 | 406 | 10,579,235 | 0 | 0 | 3/3, 3/3 |
| **gdrive, 10x** | **23,705,000** | **5,000** | **105,829,695** | **103.6** | **1,021,986** | **338** | **4,272** | **105,829,695** | **0** | **0** | **3/3, 3/3** |
| gated, 1x | 210,200 | 200 | 335,668 | 2.7 | 123,136 | 248 | 10 | 335,668 | 0 | 0 | - |

- **Over a million tuples per second, flat from 345,000 to 106 million tuples.** The simple model runs at about 1.4 to 1.6 million per second, and gdrive at about 1 million. Memory does not grow with size (96 MB at 100,000 tuples, 338 MB at 106 million) because tenants are generated one at a time.
- **The two largest stores are real files of 4.1 GB and 4.3 GB.** Every row of both (103,189,935 and 105,829,695) was written, re-read, and is allowed by the model. A CSV is about 40 bytes per tuple.
- **The gated model ran about 8 to 9x slower per tuple** (123,000 tuples per second). It picks subjects who pass `[user] and member from org`, which means evaluating the rule per object. I expect that is the cost but did not profile it; the model also writes far fewer tuples per object.
- **The large stores were written to disk and re-read, not loaded into OpenFGA.** Only pilots are loaded (below).

### Determinism

| check | result | detail |
| --- | --- | --- |
| same config twice writes the same store | PASS | sha256 3a0b509f4839b8b1 both times, 27,137 tuples |
| a different seed writes a different store | PASS | sha256 b28e5729fbc4406e |
| each tenant built alone is exactly its slice of the full store | PASS | 12 tenants, 27,137 tuples |
| tenants can be built in any order | PASS | tenants 11 down to 0, compared as sets |
| changing one edge's settings changes no other edge's tuples | PASS | folder#viewer:user went from 969 to 4,229 tuples |

### Independent check of the output file

This re-reads the 1,057,488-tuple CSV and derives everything from the tuples and the model JSON. It uses none of the generator's own reports. These checks keep every row in memory, so they run on this file and not the 106-million-tuple one; the scale table above re-reads every size for row count and allowed types.

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
| simple (the example above) | 13,728 | 3 | 33/33 | 43/43 | 0 | 1.9 | PASS |
| drive (wildcards, conditions, nesting) | 4,016 | 3 | 121/121 | 169/169 | 15 | 0.3 | PASS |
| gated (intersections, exclusions) | 543 | 3 | 86/86 | 113/113 | 0 | 0.1 | PASS |
| rbac (roles with no org link) | 1,868 | 3 | 63/63 | 97/97 | 0 | 0.1 | PASS |
| nested (two containers per folder) | 6,069 | 1 | 89/89 | 127/127 | 0 | 0.4 | PASS |
| drive, larger pilot | 27,069 | 3 | 113/113 | 152/152 | 23 | 6.4 | PASS |

Verifying is the slow part, not generating: 27,069 tuples take 6 seconds to check, and generating them takes well under a second. That is why `verify` loads a pilot and not the whole store.

### What these do not show

- **Realism.** They show the store is valid, deterministic and as asked. Whether the asked numbers look like a real customer is up to your config.
- **The rules at 106 million tuples, independently.** The 4.3 GB file is independently checked only for row count and allowed types. Depth, cycles, tenant boundaries and duplicates are checked there by the generator itself (the rule violations column, 0), and independently only on the 1-million-tuple file.
- **Other machines.** These are one run on one laptop. Rerun the command for yours.
- **Load time into a real OpenFGA server.** Only the CLI's in-memory server is used.

## Load the tuples into FGA

Everything above ran against the CLI's in-memory OpenFGA. This is how to put the tuples into a server you run or one that is hosted for you. It works with any OpenFGA server. You need the same model file the config points to, and the `tuples.csv` from `build`.

**1. Point the CLI at your server.**

```bash
export FGA_API_URL=http://localhost:8080   # your OpenFGA API URL
```

For a local server, `docker run -p 8080:8080 -p 8081:8081 -p 3000:3000 openfga/openfga run` starts one with the default configuration. For millions of tuples, give it [Postgres or MySQL](https://openfga.dev/docs/getting-started/setup-openfga/docker).

For a hosted server, create a store and an API client in your provider's console. Pass the client's credentials to every command below with `--client-id`, `--client-secret`, `--api-token-issuer` and `--api-audience` (or `--api-token` for a bearer token), and use `--store-id` in place of `FGA_STORE_ID`. The CLI also reads a config file (`--config`, default `~/.fga.yaml`).

**2. Create a store with the model.**

```bash
export FGA_STORE_ID=$(fga store create --name "mock tuples" --model model.fga | jq -r .store.id)
```

On a hosted server you made the store in the console, so write the model into it instead: `fga model write --store-id <id> --file model.fga`. The same command works for any existing store.

Write the model before the tuples: the server checks every tuple against it when it is written.

**3. Write the tuples.**

```bash
fga tuple write --file tuples.csv --max-tuples-per-write 100 --max-parallel-requests 10 --hide-imported-tuples
```

The CSV columns are the ones `fga tuple write` expects, so no conversion is needed. The default is 1 tuple per request, which is very slow for a large file, so always set `--max-tuples-per-write`.

| Target | `--max-tuples-per-write` | `--max-rps` |
|---|---|---|
| Self-hosted OpenFGA | up to 100 (the API accepts 100 per request) | not needed |
| Hosted OpenFGA | your provider's limit (check it; it can be lower than 100) | at or below its write rate limit |

If a load stops partway, run the same command again. For a file, the CLI ignores tuples that already exist (`--on-duplicate ignore`), so it carries on where it stopped. The server must be OpenFGA v1.10.0 or later for this.

**4. Spot-check it.** Pick any row from `tuples.csv` and ask the server:

```bash
fga query check user:<id> <relation> <object_type>:<object_id>
```

### Fit the store to your server's limits

A hosted server limits three things: tuples in the store, tuples per write, and writes per second. Look up the three numbers for your plan, set `--max-tuples-per-write` and `--max-rps` to match, and size the store to the first.

The fastest a load can run is tuples per write times writes per second. As an example (not any particular provider's limits), a host that allows 40 tuples per write and 150 writes per second tops out at 6,000 tuples per second. So 1 million tuples take about 3 minutes, and the 10.6 million tuple gdrive store in the benchmarks above would take about 30. That is derived from the example limits, not measured.

Use `plan --scale 0.01` to see the tuple count first. Then shrink with `build --scale`, or write a few whole tenants with `build --tenants 0,3,9`. A tenant built alone is identical to its slice of the full store.

### What has been tested

The tool's CSV was read correctly by the CLI's CSV reader, including public grants (`user:*`) and conditions. I loaded a 15,365-tuple store with both as a store file's `tuple_file` in `fga model test`, and Checks on a public grant and on a condition (allowed at `hour` 10, denied at 20) came back right.

I have not run `fga tuple write` against a live server, so the flags above come from the CLI's help and the OpenFGA docs. I also have not measured load speed, so treat the times above as the best case.

## Tests

```bash
npx vitest run
```
