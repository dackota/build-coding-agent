{{/*
Guards the schema cannot express: the agent lands in its own team's namespace under its
folder's name, and only the runtimes this release renders.
*/}}
{{- define "agent.check" -}}
{{- $ns := printf "team-%s" .Values.team -}}
{{- if ne .Release.Namespace $ns -}}
{{- fail (printf "team %s deploys to %s, not %s: put the values file under deployments/%s/" .Values.team $ns .Release.Namespace .Values.team) -}}
{{- end -}}
{{- if ne .Release.Name .Values.name -}}
{{- fail (printf "name %s must match its folder name %s" .Values.name .Release.Name) -}}
{{- end -}}
{{- if ne .Values.runtime "stock" -}}
{{- fail (printf "runtime %s is not supported yet; use stock" .Values.runtime) -}}
{{- end -}}
{{- end -}}

{{/* The team base's ModelConfig for each platform model name. */}}
{{- define "agent.modelConfig" -}}
{{- $configs := dict "glm-5.3-flash" "default-model-config" -}}
{{- get $configs .Values.model -}}
{{- end -}}

{{- define "agent.labels" -}}
app.kubernetes.io/name: {{ .Values.name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
agents.build-coding-agent.dev/team: {{ .Values.team }}
agents.build-coding-agent.dev/runtime: {{ .Values.runtime }}
{{- end -}}
