import { describe, it, expect, vi, afterEach } from 'vitest'
import { announceRelayPanePainted, RELAY_PANE_PAINTED } from './relayPanePainted'

const PANE_UA = 'Mozilla/5.0 Electron/44 kiroCrewRelayWindow kiroCrewRelayPane'

afterEach(() => { vi.restoreAllMocks() })

describe('announceRelayPanePainted', () => {
  it('in a relay pane, prints the line once the root has content and two frames drew it', async () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(cb => { frames.push(cb); return frames.length })
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const root = document.createElement('div')
    announceRelayPanePainted(root, PANE_UA)
    expect(frames).toHaveLength(0)
    root.appendChild(document.createElement('span'))
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    frames.shift()!(0)
    expect(info).not.toHaveBeenCalled()
    frames.shift()!(0)
    expect(info).toHaveBeenCalledWith(RELAY_PANE_PAINTED)
  })

  it('prints nothing outside a relay pane', async () => {
    const raf = vi.spyOn(window, 'requestAnimationFrame')
    const root = document.createElement('div')
    root.appendChild(document.createElement('span'))
    announceRelayPanePainted(root, 'Mozilla/5.0 Electron/44 kiroCrewRelayWindow')
    expect(raf).not.toHaveBeenCalled()
  })
})
