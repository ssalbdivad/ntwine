import { useQuery } from "@tanstack/react-query"
import { useThreadApi, useThreadProjectId } from "../api/threadApi.tsx"
import { acpModelGroups } from "../lib/acpModelOptions.ts"
import { OPAQUE_PORTAL_SURFACE_Z } from "../lib/overlaySurface.ts"
import { Select } from "./ui/Select.tsx"

// THE MODEL DROPDOWN FOR AN ACP AGENT (maintainer 2026-09-16: "it should be a dropdown picker, not
// the grid"). In the dispatch composer it sits beside the profile grid, which picks the AGENT for the
// next thread — one row per installed agent, no effort axis — and this control picks the model inside
// it. On a LIVE thread it is the only control: the agent cannot change under a session, exactly as a
// thread never moves between Claude Code and Codex, so nothing names it as a choice there. The list is
// the agent's own, grouped by provider (acpModelGroups): the server opens a throwaway session and
// reads the `model` config option (rpc.acpAgentModels, cached ten minutes), so an agent that is not
// signed in lists nothing and the control degrades to the agent's default with the reason in its
// tooltip rather than failing the composer.
//
// Value "" is the agent's default. The parent turns a pick into the thread's model slug
// (`acp:<agent>@<model>`) — this control never sees the slug, only the model id inside it.
export function AcpModelSelect({
  agentId,
  agentLabel,
  modelId,
  onValueChange,
  disabled = false,
  side = "bottom",
  menuZClass = OPAQUE_PORTAL_SURFACE_Z,
  className = "",
}: {
  agentId: string
  agentLabel: string
  modelId: string | undefined
  onValueChange: (modelId: string | undefined) => void
  disabled?: boolean
  side?: "top" | "bottom"
  menuZClass?: string
  className?: string
}) {
  // A project answers this (its runtime, its PATH), so a select inside another project's card asks that
  // project, under a key that names it (upstream ff43f7d3, in the fork's scoping — useDispatchProfile).
  const api = useThreadApi()
  const projectId = useThreadProjectId()
  const models = useQuery({
    queryKey: projectId ? ["acpAgentModels", agentId, { project: projectId }] : ["acpAgentModels", agentId],
    queryFn: () => api.acpAgentModels({ agentId }),
    // The server caches the probe for ten minutes; a minute here keeps a reopened composer from
    // re-asking on every mount while a fresh sign-in still shows up within the session.
    staleTime: 60_000,
  })
  const groups = acpModelGroups(models.data, modelId)
  const failure = models.isError ? (models.error as Error).message : models.data?.error
  const title = failure
    ? `${agentLabel} did not list its models (${failure}); the thread runs on the agent's own default`
    : models.data?.models.length
      ? `Model for ${agentLabel} — the list is the agent's own, read from its session`
      : `${agentLabel} lists no models; the thread runs on the agent's own default`
  return (
    <Select
      variant="readout"
      side={side}
      value={modelId ?? ""}
      onValueChange={(value) => onValueChange(value || undefined)}
      groups={groups}
      placeholder={models.isPending ? "Models…" : "Default"}
      ariaLabel={`Model for ${agentLabel}`}
      title={title}
      disabled={disabled || models.isPending}
      indicatorPosition="right"
      menuZClass={menuZClass}
      className={className}
    />
  )
}
