/**
 * What changed between a refused launch and the one approved before it, in
 * the shapes the approval card draws. Values follow the gateway's display
 * redaction, and the page draws a value only for a key the gateway shows in clear.
 */
import type { LaunchRefusal } from './mcpManagementModel'

/**
 * Each distinct command line once, in first-seen order. The gateway sends one
 * line per launch, and launches of one program often differ only in their env
 * (one per agent that declares the server), so the same line would repeat.
 */
export function distinctCommands(commands?: readonly string[][]): string[][] {
  const seen = new Set<string>()
  return (commands ?? []).filter(argv => {
    const key = JSON.stringify(argv)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** One env key whose value changed between the approved and the new launch. */
export type EnvValueChange = { name: string; added: string[]; removed: string[] }

function envValues(envs?: readonly (readonly string[])[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const env of envs ?? []) {
    for (const pair of env) {
      const at = pair.indexOf('=')
      if (at <= 0) continue
      const name = pair.slice(0, at)
      if (!out.has(name)) out.set(name, new Set())
      out.get(name)?.add(pair.slice(at + 1))
    }
  }
  return out
}

/** One launch as the page draws it: its command and its env pairs, a hidden value cut to its key. */
export type DrawnLaunch = { command: string[]; env: string[] }

/**
 * The keys whose values the gateway sends in clear (`_DISPLAY_ENV_VALUE_KEYS`,
 * the `LD_`/`DYLD_` prefixes and a bare `${VAR}` reference, in
 * `mcp_gateway/launch_approval.py`). The page draws a value only for these, so
 * any other value stays a key name here even if a display ever carried it.
 */
const CLEAR_ENV_KEYS = new Set([
  'PATH', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
  'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONSTARTUP', 'PYTHONHOME',
])

function clearValue(name: string, value: string): boolean {
  if (opaqueValue(value)) return false
  return CLEAR_ENV_KEYS.has(name) || /^(LD|DYLD)_/.test(name) || /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value)
}

function drawnEnv(env?: readonly string[]): string[] {
  return (env ?? []).map(pair => {
    const at = pair.indexOf('=')
    if (at <= 0) return pair
    const name = pair.slice(0, at)
    return clearValue(name, pair.slice(at + 1)) ? pair : name
  })
}

/** One launch's value for `name`, or null when that launch does not set it. */
function keyValue(env: readonly string[] | undefined, name: string): string | null {
  const pair = (env ?? []).find(p => p.startsWith(`${name}=`))
  return pair === undefined ? null : pair.slice(name.length + 1)
}

/** A value the gateway hid, redacted or cut: its entries can't be compared. */
function opaqueValue(value: string): boolean {
  return value.startsWith('<hidden') || value.includes('[REDACTED') || value.endsWith('…')
}

/**
 * The separator of one key's list values, read from ALL its values on both
 * sides together so both are split the same way: `;` when any value has one or
 * starts with a drive letter (Windows, where `C:` holds a colon), else `:`.
 */
function listSeparator(values: Iterable<string>): string {
  for (const v of values) {
    if (v.includes(';') || /^[A-Za-z]:[\\/]/.test(v)) return ';'
  }
  return ':'
}

/**
 * The env keys set on both sides whose values changed, and for a visible value
 * the list entries added and removed (a PATH dir, say). A value the gateway hid
 * or redacted gives empty lists, so only its key is named; so does a change
 * that only reorders the entries.
 */
export function envValueChanges(refusal: LaunchRefusal): EnvValueChange[] {
  const before = envValues(refusal.approved_envs)
  const after = envValues(refusal.envs)
  const out: EnvValueChange[] = []
  for (const [name, now] of after) {
    const was = before.get(name)
    if (!was) continue
    const gone = [...was].filter(v => !now.has(v))
    const fresh = [...now].filter(v => !was.has(v))
    if (gone.length === 0 && fresh.length === 0) {
      // The same values on both sides can still hide a change in WHICH launch
      // carries the key (one launch dropped it, or it moved): name the key.
      const sigs = (commands?: string[][], envs?: string[][]) =>
        new Set((commands ?? []).map((c, i) => JSON.stringify([c, keyValue(envs?.[i], name)])))
      const a = sigs(refusal.approved_commands, refusal.approved_envs)
      const b = sigs(refusal.commands, refusal.envs)
      if (a.size !== b.size || [...a].some(s => !b.has(s))) out.push({ name, added: [], removed: [] })
      continue
    }
    if ([...gone, ...fresh].some(v => !clearValue(name, v))) {
      out.push({ name, added: [], removed: [] })
      continue
    }
    // A side with no value of its own left (a launch only added, or only
    // dropped) is compared through all its values, so an added launch's PATH
    // shows only the dirs no approved PATH had.
    const sep = listSeparator([...was, ...now])
    // An empty POSIX entry searches the current folder, so it is kept and shown
    // as `.` (the same search) rather than dropped. Windows skips empty entries.
    const entries = (v: string) =>
      sep === ':' ? v.split(sep).map(e => (e === '' ? '.' : e)) : v.split(sep).filter(Boolean)
    const left = new Set((gone.length > 0 ? gone : [...was]).flatMap(entries))
    const right = new Set((fresh.length > 0 ? fresh : [...now]).flatMap(entries))
    out.push({
      name,
      added: fresh.length > 0 ? [...right].filter(e => !left.has(e)) : [],
      removed: gone.length > 0 ? [...left].filter(e => !right.has(e)) : [],
    })
  }
  return out
}

/** One launch as the gateway displayed it: its command and its raw env pairs. */
type RawLaunch = { command: string[]; env: string[] }

/** One changed launch: what changed against the approved launch it replaced. */
export type LaunchChange = {
  /** `changed`: paired with an approved launch; `added` / `removed`: no partner. */
  kind: 'changed' | 'added' | 'removed'
  command: string[]
  envAdded: string[]
  envRemoved: string[]
  values: EnvValueChange[]
  before?: DrawnLaunch
  after?: DrawnLaunch
}

function rawLaunches(commands?: string[][], envs?: string[][]): Map<string, RawLaunch> {
  const out = new Map<string, RawLaunch>()
  ;(commands ?? []).forEach((command, i) => {
    const env = envs?.[i] ?? []
    out.set(JSON.stringify([command, env]), { command, env })
  })
  return out
}

function names(env: readonly string[]): Set<string> {
  return new Set(env.map(p => p.slice(0, Math.max(0, p.indexOf('=')))).filter(Boolean))
}

/** What changed from one approved launch to one new launch. */
function pairDiff(before: RawLaunch, after: RawLaunch): Omit<LaunchChange, 'kind' | 'command'> {
  const was = names(before.env)
  const now = names(after.env)
  return {
    envAdded: [...now].filter(n => !was.has(n)),
    envRemoved: [...was].filter(n => !now.has(n)),
    values: envValueChanges({
      reason: 'changed_needs_reapproval',
      approved_commands: [before.command],
      approved_envs: [before.env],
      commands: [after.command],
      envs: [after.env],
    }),
    before: { command: before.command, env: drawnEnv(before.env) },
    after: { command: after.command, env: drawnEnv(after.env) },
  }
}

/**
 * The summary per LAUNCH: each new launch is paired with the approved launch it
 * most likely replaced (same command first, then the fewest changed keys; on a
 * tie the first in the gateway's order), and its env is diffed against that one
 * launch only. A change a per-key summary would miss -- two launches swapping
 * values -- shows as a change on each launch. A launch with no partner is
 * reported as added or removed whole.
 */
export function launchChanges(refusal: LaunchRefusal): LaunchChange[] {
  const was = rawLaunches(refusal.approved_commands, refusal.approved_envs)
  const now = rawLaunches(refusal.commands, refusal.envs)
  const removed = [...was].filter(([k]) => !now.has(k)).map(([, l]) => l)
  const added = [...now].filter(([k]) => !was.has(k)).map(([, l]) => l)
  const free = new Set(removed.keys())
  const out: LaunchChange[] = []
  for (const after of added) {
    let best = -1
    let bestScore = Infinity
    for (const i of free) {
      // Only a launch of the same command is a partner: pairing across
      // commands would hide the command change behind an env diff.
      if (JSON.stringify(removed[i].command) !== JSON.stringify(after.command)) continue
      const d = pairDiff(removed[i], after)
      const score = d.envAdded.length + d.envRemoved.length + d.values.length
      if (score < bestScore) {
        best = i
        bestScore = score
      }
    }
    if (best < 0) {
      out.push({ kind: 'added', command: after.command, envAdded: [], envRemoved: [], values: [], after: { command: after.command, env: drawnEnv(after.env) } })
      continue
    }
    free.delete(best)
    out.push({ kind: 'changed', command: after.command, ...pairDiff(removed[best], after) })
  }
  for (const i of free) {
    const before = removed[i]
    out.push({ kind: 'removed', command: before.command, envAdded: [], envRemoved: [], values: [], before: { command: before.command, env: drawnEnv(before.env) } })
  }
  return out
}
