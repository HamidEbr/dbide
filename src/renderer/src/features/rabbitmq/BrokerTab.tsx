import type { Tab } from '@/state/workbench'
import { ExchangeView } from './ExchangeView'
import { QueueView } from './QueueView'
import { VhostView } from './VhostView'

/** A tab about one part of a RabbitMQ broker. It is keyed by what it shows, so each part keeps its own state. */
export function BrokerTab({ tab, active }: { tab: Tab; active: boolean }) {
  switch (tab.broker?.view) {
    case 'queue':
      return <QueueView tab={tab} active={active} />
    case 'exchange':
      return <ExchangeView tab={tab} active={active} />
    case 'vhost':
      return <VhostView tab={tab} active={active} />
    default:
      return null
  }
}
