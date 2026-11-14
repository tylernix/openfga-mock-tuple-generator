# OpenFGA Mock Tuple Generator

Builds a full-size mock tuple store for any OpenFGA model, and has OpenFGA check it.

You give it a model and a config (how many of each type, and a few shape numbers per relation). It writes tuples you can load with `fga tuple write` or `fga store import`; [loading them](#load-the-tuples-into-fga) comes last, after the evidence that the tuples are worth loading.

It needs Node (tested on 24) and the [OpenFGA CLI](https://github.com/openfga/cli) (`fga`, tested on 0.8.1) on the PATH. No runtime dependencies; `tsx` and `vitest` run it and test it.

## Use it

```bash
npm install                                          # tsx and vitest, for running and testing
npx tsx src/cli.ts init model.fga --out gen.json     # every type and edge, with defaults
npx tsx src/cli.ts plan gen.json                     # tenants and projected tuples; writes nothing
npx tsx src/cli.ts verify gen.json                   # OpenFGA checks a pilot of the store
npx tsx src/cli.ts build gen.json --out tuples.csv   # the full store
```

`init --interactive` asks for the tenant type, the counts and the nesting depths. `build` also writes `.jsonl` and a `.yaml` store file, and takes `--tenants 0,3,9` to write only those tenants, or `--scale 0.01` to shrink every count to 1%.

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

### The config the benchmark used

The scale benchmarks run [bench/gdrive.gen.json](bench/gdrive.gen.json). It is what `init` wrote for [gdrive.fga](bench/models/gdrive.fga), with only the counts raised to 200,000 users, 500 organizations, 20,000 groups, 150,000 folders and 2,000,000 documents. Every other value is the default `init` wrote. The gated row uses [bench/gated.gen.json](bench/gated.gen.json) the same way. The benchmark reads these files, so what is shown here is what ran.

The 0.01x, 0.1x and 10x rows are the same file with `--scale`, which multiplies every count, and so the number of organizations, which are the tenants:

```bash
npx tsx src/cli.ts plan  bench/gdrive.gen.json                              # about 10.6 million tuples
npx tsx src/cli.ts build bench/gdrive.gen.json --scale 10 --out tuples.csv  # about 106 million, 4.3 GB
```

What it says, in plain words:

- **Tenants:** 500 organizations, with `skew` 1, so they differ a lot in size. The plan projects the largest at about 1.56 million tuples and the median at about 6,200.
- **Containers:** every group and folder sits in exactly one organization, and every document in exactly one folder (`count` 1, `coverage` 1).
- **Nesting:** folders and groups nest up to 3 levels below a top-level one. 90% of folders and 30% of groups are nested at all.
- **Access:** about half of the documents have owners and about half have direct viewers, each typically 2 (90th percentile 6). A group typically has 8 members (90th percentile 40). 30% of folders and 30% of documents are shared with 1 to 3 groups, and 10% of documents block 1 or 2 users.

<details>
<summary>The whole file, <code>bench/gdrive.gen.json</code></summary>

`_help`, `question` and `kind` are notes that `init` writes for the reader. The tool ignores them. Here, short `count` objects are put on one line; the values are the file's.

```json
{
  "_help": [
    "counts: how many objects of each type exist in the whole store.",
    "tenant: organization contains 3 type(s) and is named like a tenant. Every type is split per tenant unless listed in \"global\". skew 0 makes tenants equal; 1 makes the largest far bigger than the typical one.",
    "edges: one entry per way a tuple can be written. coverage is the share of objects that get any (0 to 1).",
    "count is how many each gets: a number, {\"min\",\"max\"}, {\"typical\",\"p90\",\"max\"} or {\"share\"} of the pool.",
    "per: \"subject\" makes count mean objects per subject (\"groups per user\"). crossTenant is the share of picks from another tenant.",
    "Nesting edges take depth (a hard limit on levels below the top) and optionally branching."
  ],
  "model": "models/gdrive.fga",
  "seed": 1,
  "ids": "index",
  "tenant": {
    "type": "organization",
    "skew": 1
  },
  "global": [],
  "counts": {
    "user": 200000,
    "organization": 500,
    "group": 20000,
    "folder": 150000,
    "document": 2000000
  },
  "edges": {
    "organization#admin:user": {
      "question": "For a typical organization, how many users hold admin?",
      "kind": "assignment",
      "coverage": 0.5,
      "count": { "typical": 2, "p90": 6, "max": 100 }
    },
    "organization#member:user": {
      "question": "For a typical organization, how many users hold member?",
      "kind": "assignment",
      "coverage": 1,
      "count": { "share": 1 }
    },
    "group#manager:user": {
      "question": "For a typical group, how many users hold manager?",
      "kind": "assignment",
      "coverage": 0.5,
      "count": { "typical": 2, "p90": 6, "max": 100 }
    },
    "group#member:user": {
      "question": "For a typical group, how many users hold member?",
      "kind": "assignment",
      "coverage": 1,
      "count": { "typical": 8, "p90": 40, "max": 2000 }
    },
    "group#member:group#member": {
      "question": "How many levels of group sit inside a top-level group, and what share of them are nested at all?",
      "kind": "nesting",
      "coverage": 0.3,
      "depth": 3
    },
    "group#org:organization": {
      "question": "Which organization does each group belong to (org)? Usually one.",
      "kind": "container",
      "coverage": 1,
      "count": 1
    },
    "folder#org:organization": {
      "question": "Which organization does each folder belong to (org)? Usually one.",
      "kind": "container",
      "coverage": 1,
      "count": 1
    },
    "folder#parent:folder": {
      "question": "How many levels of folder sit inside a top-level folder, and what share of them are nested at all?",
      "kind": "nesting",
      "coverage": 0.9,
      "depth": 3
    },
    "folder#viewer:user": {
      "question": "For a typical folder, how many users hold viewer?",
      "kind": "assignment",
      "coverage": 0.5,
      "count": { "typical": 2, "p90": 6, "max": 100 }
    },
    "folder#viewer:group#member": {
      "question": "For a typical folder, how many group members hold viewer?",
      "kind": "assignment",
      "coverage": 0.3,
      "count": { "min": 1, "max": 3 }
    },
    "document#blocked:user": {
      "question": "What share of documents have users excluded through blocked, and how many each?",
      "kind": "block",
      "coverage": 0.1,
      "count": { "min": 1, "max": 2 }
    },
    "document#folder:folder": {
      "question": "Which folder does each document belong to (folder)? Usually one.",
      "kind": "container",
      "coverage": 1,
      "count": 1
    },
    "document#owner:user": {
      "question": "For a typical document, how many users hold owner?",
      "kind": "assignment",
      "coverage": 0.5,
      "count": { "typical": 2, "p90": 6, "max": 100 }
    },
    "document#viewer:user": {
      "question": "For a typical document, how many users hold viewer?",
      "kind": "assignment",
      "coverage": 0.5,
      "count": { "typical": 2, "p90": 6, "max": 100 }
    },
    "document#viewer:group#member": {
      "question": "For a typical document, how many group members hold viewer?",
      "kind": "assignment",
      "coverage": 0.3,
      "count": { "min": 1, "max": 3 }
    }
  }
}
```

</details>

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
   *Why it works?* Memory depends on the largest tenant, not on the size of the store. The 106 million tuple store ran in 329 MB, against 116 MB for a 100,000 tuple one.
7. **Check its own work.** After each tenant, a separate pass re-derives depth, cycles, containers and tenant crossings from the parent and container choices behind the tuples it wrote, and the build compares the realized counts with what you asked for. A broken rule fails the build.
   *Why it works?* The rules are checked on the result, not assumed from the code that made it. The benchmarks go further and re-read a written file with code that shares nothing with the generator.
8. **Final OpenFGA check.** `verify` writes a few whole tenants into the CLI's in-memory OpenFGA and compares its answers with the tool's own.
   *Why it works?* An independent implementation agrees on who can access what.

What none of this decides is whether the shape matches your customers. The counts and spreads in the config are yours, and the defaults are guesses.

## What it guarantees

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
npx tsx bench/bench.ts          # about 3 minutes (2 min 49 s on the machine below); needs about 4.5 GB of free disk
npx tsx bench/bench.ts --quick  # skips the 100-million-tuple run and the 4 GB file
```



### Scale and speed

The model is [gdrive.fga](bench/models/gdrive.fga): organizations that contain groups, nested folders and documents, with users, group members, owners and a `but not` exclusion. Every row used the default shape numbers, with nesting depth 3.

Every row writes the whole CSV to disk, then re-reads the file line by line, counts the rows and checks that each is a type restriction the model allows. The file is deleted afterwards. Seconds include writing the file.

Measured on an Apple M3 Pro (11 cores, 18 GB), Node 24.14, OpenFGA CLI 0.8.1, 2026-11-14. One run each; speed varies by a few percent between runs. Each scale row is a separate process, so its peak memory is its own. It is taken before the file is re-read.

| model, size | objects | tenants | tuples | seconds | tuples / second | peak memory (MB) | CSV size (MB) | rows re-read from the file | rows the model does not allow | rule violations | depth reached / asked |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gdrive, 0.01x | 23,705 | 5 | 105,465 | 0.1 | 871,612 | 116 | 4 | 105,465 | 0 | 0 | 3/3, 3/3 |
| gdrive, 0.1x | 237,050 | 50 | 1,057,488 | 1.0 | 1,009,053 | 227 | 38 | 1,057,488 | 0 | 0 | 3/3, 3/3 |
| gdrive, 1x | 2,370,500 | 500 | 10,579,235 | 10.1 | 1,050,048 | 284 | 406 | 10,579,235 | 0 | 0 | 3/3, 3/3 |
| gdrive, 10x | 23,705,000 | 5,000 | 105,829,695 | 102.8 | 1,029,111 | 329 | 4,272 | 105,829,695 | 0 | 0 | 3/3, 3/3 |
| gated, 1x | 210,200 | 200 | 335,668 | 2.7 | 124,414 | 248 | 10 | 335,668 | 0 | 0 | - |

- **About a million tuples per second, flat from 1 million to 106 million tuples.** Memory does not grow with size (116 MB at 100,000 tuples, 329 MB at 106 million) because tenants are generated one at a time.
- **The 10x store is a real 4.3 GB file.** All 105,829,695 rows were written, then re-read, and every one is allowed by the model. A CSV is about 40 bytes per tuple.
- **The gated model ran about 8x slower per tuple** (124,000 tuples per second). It picks subjects who pass `[user] and member from org`, which means evaluating the rule per object. I expect that is the cost but did not profile it; the model also writes far fewer tuples per object.
- **The 10x store was written to disk and re-read, not loaded into OpenFGA.** Only pilots are loaded (below).

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
| drive (wildcards, conditions, nesting) | 4,016 | 3 | 121/121 | 169/169 | 15 | 0.3 | PASS |
| gated (intersections, exclusions) | 543 | 3 | 86/86 | 113/113 | 0 | 0.1 | PASS |
| rbac (roles with no org link) | 1,868 | 3 | 63/63 | 97/97 | 0 | 0.1 | PASS |
| nested (two containers per folder) | 6,069 | 1 | 89/89 | 127/127 | 0 | 0.4 | PASS |
| drive, larger pilot | 27,069 | 3 | 113/113 | 152/152 | 23 | 6.1 | PASS |

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

Use `plan gen.json --scale 0.01` to see the tuple count first. Then shrink with `build --scale`, or write a few whole tenants with `build --tenants 0,3,9`. A tenant built alone is identical to its slice of the full store.

### What has been tested

The tool's CSV was read correctly by the CLI's CSV reader, including public grants (`user:*`) and conditions. I loaded a 15,365-tuple store with both as a store file's `tuple_file` in `fga model test`, and Checks on a public grant and on a condition (allowed at `hour` 10, denied at 20) came back right.

I have not run `fga tuple write` against a live server, so the flags above come from the CLI's help and the OpenFGA docs. I also have not measured load speed, so treat the times above as the best case.

## Tests

```bash
npx vitest run
```
