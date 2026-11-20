/**
 * A relay Crew's page tells the desktop shell it has drawn the app, so the shell
 * can show its pane and the window's "Connecting…" cover can go. The page has no
 * preload, so it says it the one way main can hear without one: a console line
 * main watches for (electron/relay-crew-window.js, `RELAY_PANE_PAINTED`). Any
 * page could print it; all it decides is when that page's own pane shows.
 */
import { isRelayCrewPane } from '../utils/offlineReason'

/** The console line; electron/relay-crew-window.js holds the same string. */
export const RELAY_PANE_PAINTED = 'kirocrew:relay-pane-painted'

/** Once `root` has its first content and two frames have drawn it, print the line.
 *  Does nothing outside a relay pane. */
export function announceRelayPanePainted(root: HTMLElement, ua?: string): void {
  if (!isRelayCrewPane(ua)) return
  // eslint-disable-next-line no-console -- the console line IS the signal main reads
  const tell = () => requestAnimationFrame(() => requestAnimationFrame(() => console.info(RELAY_PANE_PAINTED)))
  if (root.childElementCount > 0) {
    tell()
    return
  }
  const mo = new MutationObserver(() => {
    if (root.childElementCount === 0) return
    mo.disconnect()
    tell()
  })
  mo.observe(root, { childList: true })
}
