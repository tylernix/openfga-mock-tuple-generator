# Assumptions in the code

This tool was built using AI. These are the assumptions it made based on reviewing the code on 2026-11-16. An assumption is anything the tool treats as true without a source for it: a guess, a heuristic, or a threshold that someone picked. This file lists only what the code does.

"Checked" means a test or a run could have shown it wrong. "Not checked" means nothing that was run would have caught it if it were false.

## 1. Defaults: guesses about what a real store looks like

None of these come from a customer store or a source. They are written into every config so they can be seen and changed. Where: [src/config.ts](src/config.ts).

| Assumption | Value | Status | If wrong |
|---|---|---|---|
| A container link (a document's folder, a folder's organization) is exactly one per object | coverage 1, count 1 | Not checked against any real model | Stores where objects sit in several containers are too tidy |
| Half of the objects get any direct assignment, and those that do get a few | coverage 0.5, typical 2, p90 6, max 100 | Not checked | Too sparse or too dense for a given product; this is the default for every edge not listed below |
| Group memberships are large | typical 8, p90 40, max 2000, coverage 1 | Not checked | Group sizes drive the cost of expansion, so this matters most |
| A `member` or `user` relation on the tenant type holds the whole pool | coverage 1, share 1 | Not checked | Every user becomes a member of every tenant; inside one tenant this is probably right, across tenants it is not |
| Userset subjects (`group#member`) cover 30% of objects, 1 to 3 each | coverage 0.3, min 1, max 3 | Not checked | |
| Exclusions (`but not`) are rare | coverage 0.1, count 1 or 1 to 2 | Not checked | |
| Public grants (`user:*`) are rare | coverage 0.02 | Not checked | |
| Nesting is shallow | depth 3, 90% nested for tupleset edges, 30% for others | Not checked | Real folder trees are often deeper |
| Counts per type: tenant 100, people 10,000, containers or group-like 1,000, everything else 100,000 | see `defaultCount` | Not checked | |
| Tenant sizes follow a power law | weights (t + 1)^-skew with skew 1 | Not checked | A few huge tenants and a long tail of tiny ones. Real tenant sizes may be flatter or steeper |
| How many tuples an object gets follows a lognormal | median from `typical`, spread from `p90`, capped at `max` | Not checked against real data | Real counts are often closer to a power law with a heavier tail |
| A few subjects are far more popular than the rest, with a cap | weight exp(popularity x normal), capped at 50x the median (`MAX_POPULARITY_RATIO`) | Not checked | The cap hides any real subject that is more than 50x as popular as the median |
| Each user belongs to one tenant | `crossTenant` defaults to 0 | Not checked | Real users are often in several organizations, which this cannot produce unless `crossTenant` is set per edge |
| Counts are independent across edges | no correlation between edges | Stated in the README limits | A big tenant does not get bigger groups unless it is set per edge |
| Seed 1, ids are plain integers | `seed: 1`, `ids: index` | n/a | Integer ids are easy to guess; use `uuid` for look-alike ids |
| The number of tenants is the tenant type's count: one tenant per object of that type | `counts[tenant.type]`, or `tenant.count` when there is no tenant type | A choice | |
| Every type is split across tenants with the same weights | each tenant's share of every type is (t + 1)^-skew | Not checked | A tenant that is large in documents is equally large in users, groups and folders. Real tenants can be document-heavy and user-light |
| A covered object gets at least one | spread draws are clamped to 1 at the low end; `share` rounds up to 1 | A choice | "Covered" and "has some" mean the same thing; there is no covered object with zero |
| A draw above `max` becomes `max` | clamped, not redrawn | Not checked | A `max` close to p90 piles objects at exactly `max`, a spike that real data may not have |
| A fractional fixed count is rounded at random | `count: 1.3` gives 2 to 30% of objects and 1 to the rest | A choice | |
| Popularity is drawn per edge | a subject's weight on one edge is independent of its weight on another | Not checked | No subject is popular everywhere: a heavy user on one relation is average on the others |
| Popularity is ignored for gated edges and for cross-tenant picks | those subjects are picked evenly | A choice | Gated relations and cross-tenant tuples have no popular subjects |
| Cross-tenant picks come from all other tenants together, evenly by object | larger tenants are picked more often | A choice | No partner pattern, where one tenant links to a few specific others |
| An object that asks for more subjects than its pool holds gets the whole pool | reported as clipped | Reported per edge | Small tenants end up denser than asked |

## 2. Reading the model: heuristics that can guess wrong

Where: [src/model.ts](src/model.ts), [src/tenants.ts](src/tenants.ts).

| Assumption | Status | If wrong |
|---|---|---|
| An edge is a "container link" when it is followed by `from` and what is read through it can be held by another type; otherwise it is an "assignment". This is decided by `isPlace` | Checked on the 6 test and benchmark models (simple, gdrive, drive, gated, rbac, nested). Not checked on any customer model | A wrongly classified edge gets the wrong defaults and the wrong shape. The README says to read the `kind` that `init` writes |
| People are types with no relations, plus plain subjects that no link treats as a place | Checked on the same 6 models | A type misread as a person is never split into containers |
| The tenant type is a container type named like `org`, `organization`, `tenant`, `workspace`, `account`, `company`, `site` or `customer`; else the outermost container; a type that nests inside itself is never suggested | Checked on the same 6 models. Earlier versions picked the wrong type (`group`, `role_bundle`) on some of them; the rules were changed until those came out right, so they are fitted to those cases | A model with an unusual tenant name or two plausible tenants gets the wrong suggestion. The menu lets the user pick |
| Types the model does not tie to the tenant (roles, groups with no org link) are split per tenant | The tool lists them as "split per tenant by assumption" | A type that is really global gets duplicated per tenant. `global` in the config fixes it |
| When a type has several containers of the same depth, its trees are built inside the first one by name | Stated in the README limits | The other containers get no trees |
| Gates (`[user] and member from org`) apply to plain subjects on assignments only, and a gated edge cannot cross tenants | Stated in the README limits | |
| A container is derived, not drawn, when the model gives a path to it: a document's organization follows from its folder, a link to the tenant type is the object's own tenant, and a nested object takes its parent's container | Checked by the build's container rule | `count` and `popularity` on such a link have no effect. Coverage still applies, except to nested objects, which always get their parent's container |
| Trees and derivation use one container per container edge, the first one picked | A choice | When `count` is above 1, the extra containers are written, but structure follows only the first |
| Without `branching`, each container holds one tree with a single top object. Level sizes grow geometrically to fit the asked depth, and every level has at least one object | Checked: depth and cycle rules on every build | All of an organization's folders form one tree under one top folder |
| A nested object's parent is picked evenly from the level above | Not checked | No parent is more popular than another |
| Exclusions are written independently of grants | Not checked | An excluded subject often does not hold the base relation, so many exclusions change no answer |
| An exclusion that is a link to a container type (`client#deleted: [site]`) points at the object's own container of that type | A choice | |
| Edges with the same object, relation and subject type (`[user, user with cond]`) are one family: a subject gets at most one tuple per object across them | Extra picks are dropped and reported | The conditioned and plain variants of a relation never overlap |
| Edges are generated in a fixed order: containers outer first, each nesting right after its type's innermost container, then assignments, public grants and exclusions. A gated edge waits for the relations it reads; gates that read each other run in the listed order | Not checked for gates that read each other | The first of two such gates sees the other unwritten, so it may find nobody who passes |
| A gate is evaluated on the tuples already written in the object's tenant and the shared block | Checked on the gated model | |
| Types above the tenant and `global` types are generated once, in a shared block. Tenant objects pick from the whole shared pool | A choice | Shared types have no tenant structure of their own |

## 3. Checking the output: what "verified" rests on

Where: [src/verify.ts](src/verify.ts), [src/evaluate.ts](src/evaluate.ts).

| Assumption | Status | If wrong |
|---|---|---|
| The tool's own evaluator (`evaluate.ts`) computes who holds each relation correctly, so agreement with OpenFGA means the store is right | Checked on 6 models; a bug shared by the evaluator and the generator would not show | `verify` can pass on a store whose meaning is wrong |
| A pilot of at most 20,000 tuples, made of whole tenants each at most half the budget, represents the full store | Not checked | Properties that only appear in a very large tenant or across tenants are never tested by OpenFGA |
| 15 objects per type, taken evenly through the ids, is a big enough sample (`perType`) | Not checked | A rare relation can go untested |
| ListUsers answers longer than 200 users, conditions and public grants are not asserted (`MAX_LISTED_USERS`) | Stated in the README | Those paths are untested by OpenFGA |
| A partial ListUsers list counts as passing if OpenFGA's own Check confirms the missing users, tested on up to 20 of them (`RECHECK_USERS`) | Checked once on a deep model | This assumes a short list is OpenFGA's limit and not a generator bug. Only 20 of the missing users are confirmed |
| The text of `fga model test` stays the same: `ListUsers 34/34 passing`, `due to`, and the `ⅹ` failure lines | Checked on CLI 0.8.1 only | A different CLI version could make `verify` report "nothing ran" |
| Realized counts are "off" when the Kolmogorov-Smirnov distance is above max(0.1, 1.63 / sqrt(objects covered)) | A threshold with no source | Too many or too few warnings |
| `plan`'s projection is close to the real tuple count; gated and nesting edges are upper estimates | Checked once: 529,260 projected against about 530k built, gdrive at 5% scale | Other models may be further off |
| The rules the build re-checks (depth, cycles, containers, tenant boundaries) are the rules that matter | Not checked | Other mistakes would pass silently |
| The pilot is the largest, a middle-sized and the smallest tenant that each fit half the budget. When none fits, only the smallest is used, even if it is over the budget | A choice | Tenants larger than half the budget are never verified by OpenFGA |
| The pilot budget is checked against `plan`'s projection, not the tuples generated | A choice | Gated and nesting edges are upper estimates, so the real pilot can be smaller than the budget suggests |
| Each sampled object and relation gets one positive Check (the first holder by id) and one negative Check (the first user of the same tenant who does not hold it) | Not checked | Leaks to users of other tenants are not asserted by Check, and tenants outside the pilot are not there to leak to |
| The reach warning fires when more than half of the sampled objects are reached by more than half of their tenant's users | A threshold with no source | |
| p50, p90 and max are counted over objects that have any; objects with none show only in coverage | A choice | A p50 of 2 with 10% coverage means most objects have none |

## 4. The reports and charts

Where: [src/html.ts](src/html.ts), [src/neighborhood.ts](src/neighborhood.ts), [src/generate.ts](src/generate.ts).

| Assumption | Status | If wrong |
|---|---|---|
| A middle-sized tenant is a representative sample | Not checked | The picture may look nothing like the biggest tenants |
| The sample object is a seeded random one, of the type with the most tuples as an object | A choice | A different pick could look very different |
| Two steps out is enough; at most 40 neighbors for the object, 8 for its neighbors, 120 objects and 400 tuples in all | Limits chosen to keep the picture readable | The picture is a cut of the real neighborhood; "capped" is shown when it is cut |
| A userset subject (`group:5#member`) is drawn as the object `group:5` | A simplification | The picture hides which relation of the group is used |
| A sample is skipped above 300,000 tuples (`MAX_SAMPLE_TUPLES`) | A limit chosen to protect memory | |
| Histograms use at most 24 bins that grow geometrically; tenant sizes use 6 to 24 bins by tenant count | Limits chosen without a source | Bins can hide a feature narrower than a bin |
| Bar heights are linear, and the top of the y axis is rounded up to 1, 2 or 5 times a power of ten, with ticks at 0, half and the top. On the plan page the asked distributions are drawn as a share of the objects that have any, not as counts | A choice | A dominant bin hides small ones. Hover shows exact counts |
| An edge's asked distribution is drawn from its configured spread, to a count of 5,000 | A cap chosen without a source | A configured max above 5,000 is not drawn past it |
| The type graph is laid out on a circle | Checked on the 5-type gdrive model only | With many types, labels will overlap. Not tested |
| Tenant size charts count the tuples written inside each tenant; the shared block is left out | A choice | |
| On the plan page, tenant sizes and tuples per edge are projections. The mean of a spread is approximated from 400 quantiles | Checked once against a build (see section 3) | |

## 5. What the output depends on

Where: [src/random.ts](src/random.ts), [src/model.ts](src/model.ts).

| Assumption | Status | If wrong |
|---|---|---|
| The same config always writes the same store | True for the same version of the code: each draw is keyed by the seed, the edge and the object's index. The config records no tool version | A later change to the draw logic gives a different store from the same config, with no warning |
| The `fga` command is on the PATH, and is run with an empty config file so it never reads `~/.fga.yaml` | Checked on CLI 0.8.1 only | `verify` fails or reads the wrong server if the CLI behaves differently |
| Changing one edge's settings changes no other edge's tuples | Checked in the benchmarks | |
| Changing a count, the number of tenants or the skew changes most tuples | Each draw is keyed by an object's index, and indexes come from the split by tenant | A small change to the config is not a small change to the store |
| Renaming a type or relation in the model changes that edge's tuples | Each edge's draws are keyed by a hash of its key | |
| Integer ids are an object's index within its type, across the whole store. `uuid` ids are derived from the seed, the type and the index | A choice | |
| The model path in a config is relative to the config file | A choice | Moving a config without its model breaks it |
| With no config named, `plan`, `verify` and `build` use the most recently modified config in the run folders of `output/`, then `output/` itself, then the current folder | A choice | Editing an old config makes it the newest one |
| A config's id is its file name without `.gen.json`, and every output is named after it | A choice | Renaming a config file changes where its outputs go |
