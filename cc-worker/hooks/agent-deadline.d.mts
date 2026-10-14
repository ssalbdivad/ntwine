export const DEADLINE_MIN_MS: number
export const DEADLINE_FINAL_LEAD_MS: number
export const CHILD_RESERVE_FRACTION: number
export const CHILD_RESERVE_MIN_MS: number
export const STAGES: readonly ["half", "converge", "final", "over"]
export type Stage = (typeof STAGES)[number]
export const TIME_LIMIT_LINE: RegExp
export const DEADLINE_MARKER: RegExp
export function stageAtMs(setAtMs: number, deadlineMs: number, stage: Stage): number
export function stageDue(setAtMs: number, deadlineMs: number, nowMs: number): Stage | undefined
export function childDeadlineMs(input: { nowMs: number; parentDeadlineMs?: number | null; declaredMs?: number | null }): number | undefined
export function parseSpan(raw: string): number | undefined
export function spanLabel(ms: number): string
export function preciseSpanLabel(ms: number): string
export function deadlineParagraph(atMs: number, setAtMs: number, declaredAtMs?: number): string
export function shareIntoPrompt(prompt: string, at: { nowMs: number; parentDeadlineMs?: number | null }): { prompt: string; atMs?: number }
export function threadDeadlineMs(env?: Record<string, string | undefined>): Promise<number | undefined>
export type AgentDeadline = { atMs: number; setAtMs: number; announce: boolean; setBy?: "user"; declaredAtMs?: number } | { none: true }
export function agentDeadline(
  sessionDir: string,
  agentId: string,
  deps: { nowMs: number; threadDeadline: () => Promise<number | undefined> },
): Promise<AgentDeadline | undefined>
export function childCheckIn(stage: Stage, atMs: number, nowMs: number): string
export function childDeadlineContext(
  sessionDir: string,
  agentId: string,
  deps: { nowMs: number; threadDeadline: () => Promise<number | undefined> },
): Promise<string | undefined>
