# The implement loop

`/implement` turns one GitHub issue into one reviewed pull request. Code drives each step,
not the model. The model only writes the plan, the tests, the code, and the reviews.

## Use it

```sh
make chat MSG="/implement https://github.com/<owner>/<repo>/issues/<n>"
```

The loop pauses for you at most twice:

1. **Plan approval** (only when the issue is not ready). It shows a one-ticket plan. Answer
   `approve`, or anything else to ask for changes.
2. **Start approval** (always). It shows the exact setup command, test command, branch
   (`implement/<n>-<slug>`), and repo. Approve it, and the loop runs to the end with no more
   pauses. This includes the push and the pull request.

Answer both the same way as any other pause ([using-the-agent.md](using-the-agent.md)).
The final reply is the pull request URL. The PR body links the issue, shows the test result,
lists MEDIUM and LOW review findings, and ends with `Closes #<n>`.

Each step prints as `> implement <step> (round n): <result>`.

| Command | What it does |
|---|---|
| `/implement <issue URL>` | Starts a run. Refused while another run is open or parked in this session. |
| `/implement continue [note]` | Gives a parked run 3 more rounds. The note goes into every later executor prompt. |
| `/implement stop` | Drops the run, so you can start a new one. |

## What the target repo needs

- A public GitHub repo (the actor can clone public repos only).
- A test command. The loop looks for `Test: \`cmd\`` and `Setup: \`cmd\`` lines in `AGENTS.md`
  first, then `package.json` and the lockfile. No test command means the run parks.
- Setup and tests that finish in 5 minutes (`AGENT_LOOP_TIMEOUT_MS`, default 300000).
- The `GITHUB_TOKEN` must allow contents and pull requests (read and write) on that repo.

## The steps

```
read issue ─> ready? ──no──> plan ─> you approve plan
                 │yes                      │
                 └──────────┬──────────────┘
                            v
              find setup/test commands ─> you approve start ─> setup
                            │
                            v
         ┌─> executor writes tests ─> tests must FAIL (red)
         │   executor writes code   ─> tests must PASS (green)
 round   │   reviewer: spec axis + standards axis
 (max 3) │        │ CRITICAL or HIGH finding?
         └─── yes ┘
                  │ no
                  v
        create_branch ─> push_files ─> create_pull_request ─> reply with URL
```

- **Read.** Reads the issue (title, body, comments) with the GitHub MCP `issue_read` tool, and
  clones the repo into the empty workspace.
- **Ready check.** The `explorer` subagent says, as JSON, if the issue is clear enough to build.
- **Plan.** If not ready, the `explorer` writes a plan: what to build, acceptance criteria,
  seams, and a proof line. If the issue is too big, the run parks with "split this issue".
  You can ask for changes 2 times; a third time parks the run.
- **Build, test-first.** The `executor` writes only tests. If it writes a non-test file, the
  loop removes it and the round goes back. The tests must fail. Then the `executor` writes the
  code, and the tests must pass.
- **Review.** Two fresh `reviewer` calls. `review-spec` asks "does the diff do what the issue
  asks?". `review-standards` asks "does it follow the repo's `AGENTS.md`?". Each returns
  findings as JSON with a severity. A CRITICAL or HIGH finding starts a fix round.
- **Pull request.** The loop calls the GitHub MCP tools itself, with no model and no more
  approval. The start approval already named the branch and repo.

## Rounds and parking

A **round** is one pass of build, test, and review. A run has 3 rounds. At the cap, the run
**parks**: it stops, tells you why, shows the last test output and any open CRITICAL and HIGH
findings, and keeps its workspace and state. Use `/implement continue` or `/implement stop`.

A run also parks when an event comes that the step does not expect, or when a review returns
bad JSON twice (`review-invalid`; this one cannot continue).

## Why it is built this way

- **Code, not the model, drives the steps.** The model cannot skip the red test, the review,
  or the approval.
- **Pure step machine.** `next(state, event)` in `agent/src/loop.ts` does no I/O. So each step
  is easy to test, and the state saves to the session after every step. A cold wake goes on
  from the last step, and an opened PR is never opened twice.
- **One approval up front.** You see every command that will run, so the loop can then work
  without waiting on you.

## Code

| File | Job |
|---|---|
| `agent/src/loop.ts` | The step machine: state, events, actions. |
| `agent/src/loop-runner.ts` | Does each action (subagent calls, commands, GitHub calls). |
| `agent/src/loop-commands.ts` | Finds the setup and test commands. |
| `agent/src/loop-github.ts` | GitHub MCP calls: read the issue, branch, push, PR. |
