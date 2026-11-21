// MCP Management: what a changed launch shows before it is approved again.
//
// Contract under test:
// - a command the gateway lists once per launch is drawn once
// - when only the env changed, each changed launch says what changed against
//   the approved launch it replaced (the PATH dirs added and removed), and the
//   whole launches sit behind "Show full command"
// - two launches that swap values show as a change on each launch
// - a hidden or redacted value is named by its key only, never by its value
//
// Every label is read from the catalog, so a wording change never breaks a test.
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { i18nT } from '../i18n/t'
import { fmtList } from '../i18n/format'
import { RefusalLaunch } from '../pages/settings/McpManagementLaunchReview'
import { distinctCommands, envValueChanges, launchChanges } from '../pages/settings/mcpLaunchDiff'
import type { LaunchRefusal } from '../pages/settings/mcpManagementModel'

const M = (key: string, vars?: Record<string, unknown>) => i18nT(`pages.mcpManagement.${key}`, vars)
const list = (items: string[]) => fmtList(items, { style: 'narrow' })
const pres = (root: HTMLElement) => Array.from(root.querySelectorAll('pre')).map(p => p.textContent)

const CMD = ['/opt/bin/docs-mcp']
const OLD_PATH = 'PATH=/home/u/.local/bin:/home/u/bin:/usr/local/bin:/usr/bin'
const NEW_PATH = 'PATH=/home/u/.local/bin:/usr/local/bin:/usr/bin:/sbin'
const OTHER_PATH = 'PATH=/home/u/.local/bin:/usr/bin'

// Three agents declare the same server; only the third one's PATH changed.
const pathOnly: LaunchRefusal = {
  reason: 'changed_needs_reapproval',
  complete: true,
  expected_launch: 'shown',
  commands: [CMD, CMD, CMD],
  envs: [[OTHER_PATH], [OTHER_PATH], [NEW_PATH]],
  approved_commands: [CMD, CMD, CMD],
  approved_envs: [[OTHER_PATH], [OTHER_PATH], [OLD_PATH]],
}

afterEach(cleanup)

describe('a changed launch', () => {
  it('draws a command that repeats once per launch only once', () => {
    const { container } = render(<RefusalLaunch refusal={pathOnly} />)
    // One changed launch, named once; its whole before and after sit behind the
    // disclosure. Three copies of the command are never drawn.
    expect(pres(container)).toEqual([CMD[0], `${CMD[0]}\n${OLD_PATH}`, `${CMD[0]}\n${NEW_PATH}`])
    expect(container.querySelector('details summary')?.textContent).toBe(M('show_full_launch'))
    expect(distinctCommands([CMD, ['/opt/x', '--a'], CMD])).toEqual([CMD, ['/opt/x', '--a']])
  })

  it('says which PATH dirs were added and removed when only the env changed', () => {
    const { container } = render(<RefusalLaunch refusal={pathOnly} />)
    const text = container.textContent ?? ''
    expect(text).toContain(M('diff_env_entries_added', { name: 'PATH', entries: list(['/sbin']) }))
    expect(text).toContain(M('diff_env_entries_removed', { name: 'PATH', entries: list(['/home/u/bin']) }))
  })

  it('shows two launches that swapped their values as a change on each launch', () => {
    const refusal: LaunchRefusal = {
      ...pathOnly,
      commands: [CMD, CMD],
      approved_commands: [CMD, CMD],
      approved_envs: [['PATH=/a', 'PYTHONPATH=/x'], ['PATH=/b', 'PYTHONPATH=/y']],
      envs: [['PATH=/a', 'PYTHONPATH=/y'], ['PATH=/b', 'PYTHONPATH=/x']],
    }
    // Each new launch is paired with the approved launch that shares its PATH,
    // so the summary names the PYTHONPATH change on both.
    expect(launchChanges(refusal).map(c => [c.kind, c.values])).toEqual([
      ['changed', [{ name: 'PYTHONPATH', added: ['/y'], removed: ['/x'] }]],
      ['changed', [{ name: 'PYTHONPATH', added: ['/x'], removed: ['/y'] }]],
    ])
    const { container } = render(<RefusalLaunch refusal={refusal} />)
    const items = Array.from(container.querySelectorAll('li')).map(li => li.textContent)
    expect(items).toEqual([
      M('diff_env_entries_added', { name: 'PYTHONPATH', entries: list(['/y']) }),
      M('diff_env_entries_removed', { name: 'PYTHONPATH', entries: list(['/x']) }),
      M('diff_env_entries_added', { name: 'PYTHONPATH', entries: list(['/x']) }),
      M('diff_env_entries_removed', { name: 'PYTHONPATH', entries: list(['/y']) }),
    ])
  })

  it('never pairs launches of different commands, so a command switch shows as removed and added', () => {
    const A = ['/opt/bin/docs-mcp']
    const B = ['/opt/bin/docs-mcp', '--extra']
    const refusal: LaunchRefusal = {
      ...pathOnly,
      approved_commands: [A, A, B],
      approved_envs: [['MODE=1'], ['MODE=2'], ['MODE=1']],
      commands: [A, B, B],
      envs: [['MODE=1'], ['MODE=1'], ['MODE=2']],
    }
    expect(launchChanges(refusal).map(c => [c.kind, c.command])).toEqual([
      ['added', B],
      ['removed', A],
    ])
    const { container } = render(<RefusalLaunch refusal={refusal} />)
    const items = Array.from(container.querySelectorAll('li')).map(li => li.textContent)
    expect(items).toEqual([
      M('diff_added', { tokens: '/opt/bin/docs-mcp --extra' }),
      M('diff_removed', { tokens: '/opt/bin/docs-mcp' }),
    ])
  })

  it('names a launch with no approved partner as added', () => {
    const extra = ['/opt/bin/docs-mcp', '--extra']
    const changes = launchChanges({
      ...pathOnly,
      commands: [CMD, extra],
      approved_commands: [CMD],
      envs: [[OTHER_PATH], [OTHER_PATH]],
      approved_envs: [[OTHER_PATH]],
    })
    expect(changes.map(c => [c.kind, c.command])).toEqual([['added', extra]])
  })

  it('never draws the value of a key the gateway does not show in clear', () => {
    const refusal: LaunchRefusal = { ...pathOnly, commands: [CMD], approved_commands: [CMD], envs: [['MODE=new']], approved_envs: [['MODE=old']] }
    const { container } = render(<RefusalLaunch refusal={refusal} />)
    expect(container.textContent).not.toContain('new')
    expect(container.textContent).toContain(M('diff_env_value_changed', { name: 'MODE' }))
  })

  it('shows only the dirs no approved PATH had when a launch is added', () => {
    expect(
      envValueChanges({
        ...pathOnly,
        envs: [[OTHER_PATH], [OLD_PATH], ['PATH=/home/u/.local/bin:/opt/new']],
        approved_envs: [[OTHER_PATH], [OLD_PATH]],
      }),
    ).toEqual([{ name: 'PATH', added: ['/opt/new'], removed: [] }])
  })

  it('names a hidden value by its key only', () => {
    const refusal: LaunchRefusal = {
      ...pathOnly,
      commands: [CMD],
      approved_commands: [CMD],
      envs: [['API_TOKEN=<hidden sha256:00ff00ff>']],
      approved_envs: [['API_TOKEN=<hidden sha256:11aa11aa>']],
    }
    const { container } = render(<RefusalLaunch refusal={refusal} />)
    const text = container.textContent ?? ''
    expect(text).toContain(M('diff_env_value_changed', { name: 'API_TOKEN' }))
    expect(text).not.toContain('sha256')
    expect(text).not.toContain('00ff00ff')
  })

  it('splits both sides of a Windows value the same way, even when one side has one entry', () => {
    const win = (before: string, after: string) =>
      envValueChanges({ ...pathOnly, envs: [[`PYTHONPATH=${after}`]], approved_envs: [[`PYTHONPATH=${before}`]] })
    expect(win('C:\\proj\\src', 'C:\\proj\\src;C:\\other')).toEqual([
      { name: 'PYTHONPATH', added: ['C:\\other'], removed: [] },
    ])
    expect(win('C:\\Tools', 'D:\\Tools')).toEqual([{ name: 'PYTHONPATH', added: ['D:\\Tools'], removed: ['C:\\Tools'] }])
  })

  it('shows a new empty POSIX PATH entry as the current folder, never drops it', () => {
    expect(envValueChanges({ ...pathOnly, envs: [['PATH=/bin::/opt/new']], approved_envs: [['PATH=/bin']] })).toEqual([
      { name: 'PATH', added: ['.', '/opt/new'], removed: [] },
    ])
  })

  it('names a key one launch dropped while another launch still has the same value', () => {
    const refusal: LaunchRefusal = {
      ...pathOnly,
      commands: [CMD, CMD],
      approved_commands: [CMD, CMD],
      approved_envs: [['MODE=a', 'TRACE=1'], ['MODE=b', 'TRACE=1']],
      envs: [['MODE=a', 'TRACE=1'], ['MODE=b']],
    }
    expect(envValueChanges(refusal)).toEqual([{ name: 'TRACE', added: [], removed: [] }])
    // Per launch, the second launch says exactly what it lost.
    const { container } = render(<RefusalLaunch refusal={refusal} />)
    expect(container.textContent).toContain(M('diff_env_removed', { names: list(['TRACE']) }))
  })

  it('draws no env row in the one block, since the lines above name the changed keys', () => {
    const { container } = render(<RefusalLaunch refusal={pathOnly} />)
    expect(container.textContent).not.toContain(M('details_env'))
  })

  it('keeps two columns when a redacted command line cannot prove the program is the same', () => {
    const tagged = ['/opt/bin/docs-mcp', '--key=[REDACTED]']
    const { container } = render(
      <RefusalLaunch refusal={{ ...pathOnly, commands: [tagged], approved_commands: [tagged], envs: [[NEW_PATH]], approved_envs: [[OLD_PATH]] }} />,
    )
    expect(container.textContent).toContain(M('details_approved'))
    expect(container.textContent).toContain(M('details_new'))
  })

  it('splits a Windows PATH on semicolons, so a drive colon is not an entry break', () => {
    expect(
      envValueChanges({
        ...pathOnly,
        envs: [['PATH=C:\\Tools;C:\\New']],
        approved_envs: [['PATH=C:\\Tools;C:\\Old']],
      }),
    ).toEqual([{ name: 'PATH', added: ['C:\\New'], removed: ['C:\\Old'] }])
  })
})
