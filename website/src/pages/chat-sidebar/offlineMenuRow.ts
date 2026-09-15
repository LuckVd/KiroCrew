/** The offline gate for one sidebar menu row whose action writes to the gateway.
 *
 *  Spread onto a `DropdownMenuItem` / `ContextMenuItem`:
 *
 *    <Item {...offlineMenuRow(connected, i18nT('utils.offline.delete_folders'), label, () => del())}>
 *
 *  Online it adds only `onSelect`, which runs the action. Offline it dims the row
 *  (`offline`), names why in the tooltip and accessible name (`offlineProps`),
 *  and refuses on `onSelect` with `preventDefault`. Radix closes a menu on
 *  `onSelect`, so the refusal keeps the menu open, and with it the menu's
 *  `OfflineMenuReason` row; an `onClick` that returned early would let the menu
 *  close and read as though the action ran.
 *
 *  The row is not Radix-`disabled`: that adds `pointer-events-none` and drops it
 *  from the focus order, so its tooltip could never open and a screen-reader
 *  user would never learn why it is inert.
 *
 *  `offlineProps` is spread only while offline, so an online row keeps its own
 *  `disabled` (for example `creatingSlot`) without a contradicting
 *  `aria-disabled="false"`. */
import { offlineProps } from '../../utils/offline'

export function offlineMenuRow(connected: boolean, verb: string, label: string, run: () => void) {
  return {
    offline: !connected,
    ...(connected ? {} : offlineProps(false, verb, label)),
    onSelect: (e: Event) => {
      if (!connected) { e.preventDefault(); return }
      run()
    },
  }
}
