{{/*
Guards the schema cannot express: the agent lands in its own team's namespace under its
folder's name.
*/}}
{{- define "agent.check" -}}
{{- $ns := printf "team-%s" .Values.team -}}
{{- if ne .Release.Namespace $ns -}}
{{- fail (printf "team %s deploys to %s, not %s: put the values file under deployments/%s/" .Values.team $ns .Release.Namespace .Values.team) -}}
{{- end -}}
{{- if ne .Release.Name .Values.name -}}
{{- fail (printf "name %s must match its folder name %s" .Values.name .Release.Name) -}}
{{- end -}}
{{- end -}}

{{/*
The tool catalog: a catalog name is a catalog MCP server, its tools, and whether it writes.
A write tool always pauses for approval (the schema refuses requireApproval: false on one;
this forces it on when unset). Each server sits behind agentgateway at its route
(platform/gateway.yaml); the agent reaches it through its own RemoteMCPServer
(mcp-servers.yaml), and the minter's tool policy for the agent allows only its tools there.
*/}}
{{- define "agent.catalog" -}}
github-read: {server: github-mcp, tools: [issue_read], write: false}
github-write: {server: github-mcp, tools: [create_branch, push_files, create_pull_request], write: true}
demo-delete-branch: {server: demo-mcp, tools: [delete_branch], write: true}
{{- end -}}

{{/* The catalog MCP servers: agentgateway's route for each, and what it is. */}}
{{- define "agent.mcpServers" -}}
github-mcp: {path: /mcp/github, description: "GitHub through agentgateway, which holds the token"}
demo-mcp: {path: /mcp/demo, description: "Demo MCP server with one destructive-looking tool, for the requireApproval check"}
{{- end -}}

{{/* The agent's own RemoteMCPServer for a catalog server: <agent>-<server>. */}}
{{- define "agent.mcpServerName" -}}
{{- printf "%s-%s" .agent .server -}}
{{- end -}}

{{/* The catalog entries of the agent's tools, in order, as a JSON list (an unknown name fails in agent.tools). */}}
{{- define "agent.toolEntries" -}}
{{- $catalog := include "agent.catalog" . | fromYaml -}}
{{- $entries := list -}}
{{- range .Values.tools }}
{{- $name := . }}
{{- if kindIs "map" . }}{{ $name = .name }}{{ end }}
{{- $entries = append $entries (get $catalog $name | default dict) }}
{{- end }}
{{- $entries | toJson -}}
{{- end -}}

{{/* The catalog servers the agent's tools use, each once, as a JSON list. */}}
{{- define "agent.usedServers" -}}
{{- $servers := list -}}
{{- range include "agent.toolEntries" . | fromJsonArray }}
{{- $servers = append $servers .server }}
{{- end }}
{{- $servers | uniq | toJson -}}
{{- end -}}

{{/* The MCP tool names of the agent's catalog tools, as a JSON list: the registration gives them to the minter. */}}
{{- define "agent.mcpToolNames" -}}
{{- $names := list -}}
{{- range include "agent.toolEntries" . | fromJsonArray }}
{{- $names = concat $names .tools }}
{{- end }}
{{- $names | uniq | toJson -}}
{{- end -}}

{{/* The team base's subagent templates, by subagent name. */}}
{{- define "agent.subagents" -}}
explorer: {template: explorer-template, description: Read-only helper that finds and reads files and summarizes them. Cheap and fast.}
executor: {template: executor-template, description: "Does the hard work with full file tools (read, write, edit, search)."}
reviewer: {template: reviewer-template, description: Read-only reviewer that checks a change against the issue or against the repo's AGENTS.md and returns JSON findings.}
{{- end -}}

{{/* The AgentTemplate's tools: catalog MCP tools, then subagents, as a YAML list. */}}
{{- define "agent.tools" -}}
{{- $catalog := include "agent.catalog" . | fromYaml -}}
{{- $subagents := include "agent.subagents" . | fromYaml -}}
{{- range .Values.tools }}
{{- $name := . }}
{{- $approval := false }}
{{- if kindIs "map" . }}
{{- $name = .name }}
{{- $approval = default false .requireApproval }}
{{- end }}
{{- $entry := get $catalog $name }}
{{- if not $entry }}{{ fail (printf "tool %s is not in the catalog" $name) }}{{ end }}
- mcp:
    server: {kind: RemoteMCPServer, name: {{ include "agent.mcpServerName" (dict "agent" $.Values.name "server" $entry.server) }}}
    tools: {{ $entry.tools | toJson }}
    {{- if or $entry.write $approval }}
    requireApproval: true
    {{- end }}
{{- end }}
{{- range .Values.subagents }}
{{- $sub := get $subagents . }}
- subAgent:
    name: {{ . }}
    description: {{ $sub.description | quote }}
    templateRef: {name: {{ $sub.template }}}
{{- end }}
{{- end -}}

{{/* The AgentTemplate's skills, each from the image make deploy pinned for it. */}}
{{- define "agent.skills" -}}
{{- $images := (.Values.platform | default dict).skillImages | default dict -}}
{{- range .Values.skills }}
{{- $image := get $images . }}
{{- if not $image }}{{ fail (printf "skill %s has no pinned image yet: run make deploy" .) }}{{ end }}
- name: {{ . }}
  source: {oci: {{ $image | quote }}}
{{- end }}
{{- end -}}

{{/* The agent's own ModelConfig, and the key Secret the platform's minter writes for it. */}}
{{- define "agent.modelConfig" -}}
{{- printf "%s-model" .Values.name -}}
{{- end -}}
{{- define "agent.keySecret" -}}
{{- printf "%s-agent-key" .Values.name -}}
{{- end -}}

{{- define "agent.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
agents.build-coding-agent.dev/team: {{ .Values.team }}
agents.build-coding-agent.dev/runtime: {{ .Values.runtime }}
{{- end -}}
