# Using the agent

Deploy first (`make up`, then `make deploy`). All examples talk to `hello-agent` through the
kagent controller. Without `KAGENT_URL` set, the CLI opens a `kubectl port-forward` for you.

`make chat MSG="..."` is a short form of `pnpm --dir agent run cli -- "..."`. Use the long form
when you need flags.

## Send a message

```sh
make chat MSG="What is 7 times 6?"
```

Text prints as it streams. Each tool call prints as `> name {args}`.
At the end the CLI prints `context=<id>` on stderr. That id is your session.

## Continue a session

```sh
pnpm --dir agent run cli -- --context <id> "Now make it 8 times 6"
```

## Send a file and get a diff back

```sh
make chat FILE=greet.js MSG="rename function foo to bar"
```

The file is written to the workspace, byte for byte. The CLI prints the reply, then a
unified diff of what changed. Repeat `--file <path>` to send more than one file.

## Answer a question

When a task is unclear, the agent asks instead of guessing. The CLI prints the question,
the choices, and a line like:

```
paused: task=T context=C request=R
```

Answer with:

```sh
pnpm --dir agent run cli -- --task T --context C --request R "Blue"
```

## Approve or deny a command

A risky `bash` command or an MCP tool call prints the command and:

```
paused: task=T context=C approval=A
```

Decide with one of:

```sh
pnpm --dir agent run cli -- --task T --context C --approval A --approve
pnpm --dir agent run cli -- --task T --context C --approval A --approve-session
pnpm --dir agent run cli -- --task T --context C --approval A --deny "use git stash instead"
```

| Answer | Effect |
|---|---|
| `--approve` | Runs this one call. |
| `--approve-session` | Runs this call, and later calls of the same kind (for example, any `rm`, or any `push_files`) run with no pause in this session. |
| `--deny "reason"` | Does not run. The model gets your reason as the tool's result. |

## Stop a turn

Press Ctrl-C. The CLI cancels the task, prints `context=<id>`, and exits 130. The steps
that finished stay in the session, so you can continue it with `--context`.

## Work on a GitHub repo

**Git in.** Ask the agent to clone a public repo. It runs
`git clone --depth 1 https://github.com/<owner>/<repo>.git` in its workspace. A clone and a
test run each pause for approval. Pick repos with quick installs and tests: a `bash` command
stops after 60 s.

**Git out.** The agent never runs `git push`. It calls the GitHub MCP tools instead:
`create_branch`, then `push_files` with the full content of each changed file, then
`create_pull_request`. Each call pauses for your approval.

**Whole issue to PR.** Use `/implement`. See [implement-loop.md](implement-loop.md).

## Triage an issue first

`triage-agent` reads an issue and tells you what to do with it. Give it the issue URL:

```sh
AGENT=triage-agent make chat MSG="https://github.com/<owner>/<repo>/issues/<n>"
```

It replies "ready, build it", "needs a plan", or "too big, split it", says why, and ends
with the command to run next:

```sh
AGENT=hello-agent make chat MSG="/implement https://github.com/<owner>/<repo>/issues/<n>"
```

A docs-only issue gets `AGENT=docs-agent make chat MSG="/implement <url>"` instead. A
too-big issue gets no command, only how to split it. Triage cannot call another agent on
alpha17 (see [ADR 0003](decisions/0003-a2a-and-stock-runtime.md)), so you run the command
yourself. That also means every pause (start approval, plan sign-off) comes straight from
the agent that pauses, and you answer it as above.

## See your sessions in the kagent UI

Sessions belong to a user id. The CLI uses `cli@build-coding-agent` by default. The UI signs
in as `admin@kagent.dev`. To see CLI sessions (and their pauses) in the UI:

```sh
KAGENT_USER_ID=admin@kagent.dev make chat MSG="hello"
kubectl --context kind-build-coding-agent -n kagent port-forward svc/kagent-ui 8080:8080
```

Then open `http://localhost:8080/agents/kagent/hello-agent/new`.

## CLI settings

| Variable | Default | What it sets |
|---|---|---|
| `AGENT` | `hello-agent` | Which agent to talk to. |
| `AGENT_NAMESPACE` | `kagent` | The agent's namespace. |
| `KAGENT_URL` | port-forward | The controller's URL. |
| `KAGENT_USER_ID` | `cli@build-coding-agent` | The user that owns the session. |

## Read the agent's logs

The agent logs one JSON object per line. Useful events: `system-prompt`, `step-usage`,
`subagent-call`, `mcp-call`, `loop-step`, `extension-blocked`. Log lines never hold tool
input or secrets.
