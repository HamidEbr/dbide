import type { Tab } from '@/state/workbench'
import { ConsoleView } from './ConsoleView'
import { InfoView } from './InfoView'
import { KeysView } from './KeysView'
import { KeyView } from './KeyView'

/** A tab about one part of a Redis server. It is keyed by what it shows, so each part keeps its own state. */
export function RedisTab({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.redis?.view) {
    case 'keys':
      return <KeysView tab={tab} active={active} />
    case 'key':
      return <KeyView tab={tab} active={active} />
    case 'console':
      return <ConsoleView tab={tab} active={active} />
    case 'info':
      return <InfoView tab={tab} active={active} />
    default:
      return null
  }
}
