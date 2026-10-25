import { Clock, Copy, CopyPlus, Gauge, Pencil, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { printable } from '@shared/redis/bstring'
import { describeTtl, type RedisEdit } from '@shared/redis/types'
import { Button, EnvBadge } from '@/components/ui'
import { Chip, LockButton, RefreshControls } from '@/components/panel'
import { coreLink } from '@/ipc/link'
import { formatBytes, messageOf } from '@/lib/format'
import { useServerCall } from '@/lib/useServerCall'
import { writeClipboard } from '@/lib/clipboard'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'
import { changeData } from '@/state/writes'
import { useWorkbench, workbench, type Tab } from '@/state/workbench'
import { CollectionView } from './CollectionView'
import { TypeBadge, isCollection, lengthLabel } from './common'
import { DuplicateKeyDialog, RenameKeyDialog, TtlDialog } from './KeyDialogs'
import { StreamView } from './StreamView'
import { StringEditor } from './StringEditor'
import { useElements } from './useElements'
import { ValueViewer } from './ValueViewer'

/** Applies one change to the open key, after the checks the connection's environment asks for. */
export type Change = (
  edit: RedisEdit,
  say: {
    title: string
    lines: string[]
    confirmLabel?: string
    destructive?: boolean
    /** The navigator lists keys: say so when the change adds, renames or removes one. */
    refreshTree?: boolean
    done?: string
  },
) => Promise<boolean>

/** One key: what it holds, when it expires, and a way to change either. */
export function KeyView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const { db, key: keyName = '' } = tab.redis!
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const [auto, setAuto] = useState(false)
  const [match, setMatch] = useState('')
  const [dialog, setDialog] = useState<'ttl' | 'rename' | 'duplicate' | null>(null)
  const [memory, setMemory] = useState<number | null | undefined>(undefined)

  const detailCall = useServerCall(
    (signal) => coreLink.call('redis.key', { connectionId, db, key: keyName }, { signal }),
    { refreshMs: 5000, paused: !active || !auto },
  )
  const detail = detailCall.data
  const type = detail && detail.type !== 'none' ? detail.type : null
  const elements = useElements(connectionId, db, keyName, type, match)
  const info = useServerCall(
    (signal) => coreLink.call('redis.info', { connectionId }, { signal }),
    {
      paused: !active,
    },
  )

  const reload = (): void => {
    detailCall.reload()
    elements.reload()
    setMemory(undefined)
  }

  const change: Change = (edit, say) =>
    changeData({
      connectionId,
      title: say.title,
      confirmLabel: say.confirmLabel ?? 'Save',
      lines: say.lines,
      ...(say.destructive ? { destructive: true } : {}),
      ...(say.done ? { done: say.done } : {}),
      refreshTree: say.refreshTree ?? false,
      run: async () => {
        await coreLink.call('redis.edit', {
          connectionId,
          db,
          writable: true,
          key: keyName,
          edit,
        })
        reload()
      },
    })

  const close = (): void => useWorkbench.getState().closeTab(tab.id)
  const label = printable(keyName)

  const remove = async (): Promise<void> => {
    const ran = await change(
      { op: 'key.delete' },
      {
        title: `Delete “${label}”?`,
        confirmLabel: 'Delete',
        destructive: true,
        refreshTree: true,
        done: `Deleted “${label}”.`,
        lines: [`Delete the key ${label} in db${db}`],
      },
    )
    if (ran) close()
  }

  const measure = async (): Promise<void> => {
    try {
      const [size] = await coreLink.call('redis.memory', { connectionId, db, keys: [keyName] })
      setMemory(size ?? null)
    } catch (error) {
      notify(messageOf(error), 'error')
    }
  }

  const clustered = info.data?.mode === 'cluster'
  const missing = detail?.type === 'none'

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1 className="mono redis-keyname selectable">{label}</h1>
          {detail && !missing ? <TypeBadge type={detail.type} /> : null}
          <span className="muted">{clustered ? 'key' : `key in db${db}`}</span>
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {detail && !missing ? (
            <>
              <button
                type="button"
                className="redis-chip-button"
                title="Change the expiry"
                onClick={() => setDialog('ttl')}
              >
                <Chip tone={detail.ttlMs !== null ? 'warn' : undefined}>
                  <Clock size={11} aria-hidden />{' '}
                  {detail.ttlMs === null ? 'no expiry' : `expires in ${describeTtl(detail.ttlMs)}`}
                </Chip>
              </button>
              {detail.length !== null ? (
                <Chip>{lengthLabel(detail.type, detail.length)}</Chip>
              ) : null}
              {detail.encoding ? <Chip>{detail.encoding}</Chip> : null}
              {memory !== undefined ? (
                <Chip>{memory === null ? 'size unknown' : `${formatBytes(memory)} in memory`}</Chip>
              ) : (
                <button
                  type="button"
                  className="redis-chip-button"
                  title="Ask the server how much memory this key takes (MEMORY USAGE)"
                  onClick={() => void measure()}
                >
                  <Chip>
                    <Gauge size={11} aria-hidden /> memory
                  </Chip>
                </button>
              )}
            </>
          ) : null}
        </div>
        <div className="broker-toolbar">
          <Button
            icon={<Copy size={14} />}
            variant="ghost"
            onClick={() => void writeClipboard(keyName).then(() => notify('Copied the key name.'))}
          >
            Copy name
          </Button>
          <Button
            icon={<Pencil size={14} />}
            disabled={missing}
            onClick={() => setDialog('rename')}
          >
            Rename
          </Button>
          <Button
            icon={<CopyPlus size={14} />}
            disabled={missing}
            onClick={() => setDialog('duplicate')}
          >
            Duplicate
          </Button>
          <Button
            variant="ghost"
            icon={<Trash2 size={14} />}
            disabled={missing}
            onClick={() => void remove()}
          >
            Delete
          </Button>
          <span className="spacer" />
          <RefreshControls
            onReload={reload}
            auto={auto}
            onAuto={setAuto}
            updatedAt={detailCall.updatedAt}
          />
          <LockButton connectionId={connectionId} allows="editing and deleting keys" />
        </div>
      </header>

      <div className="broker-body">
        {detailCall.error ? (
          <p className="note-error" role="alert">
            {detailCall.error}
          </p>
        ) : null}
        {detailCall.loading ? <p className="muted">Reading the key…</p> : null}
        {missing ? (
          <p className="muted">
            This key doesn’t exist{' '}
            {detail?.ttlMs === null
              ? ''
              : 'any more. It may have expired, or been deleted elsewhere. '}
            <Button variant="ghost" onClick={reload}>
              Check again
            </Button>
          </p>
        ) : null}
        {elements.error && !detailCall.error ? (
          <p className="note-error" role="alert">
            {elements.error}
          </p>
        ) : null}

        {detail && !missing ? (
          <>
            {detail.type === 'string' && elements.page?.type === 'string' ? (
              <StringEditor page={elements.page} keyName={label} db={db} change={change} />
            ) : null}
            {isCollection(detail.type) ? (
              <CollectionView
                kind={detail.type}
                elements={elements}
                keyName={label}
                db={db}
                change={change}
                match={match}
                onMatch={setMatch}
              />
            ) : null}
            {detail.type === 'stream' ? (
              <StreamView
                elements={elements}
                connectionId={connectionId}
                keyName={keyName}
                db={db}
                change={change}
                active={active}
              />
            ) : null}
            {elements.page?.type === 'json' ? (
              <>
                <p className="muted">
                  A JSON document (RedisJSON). It is shown here, and changed with JSON.SET in the
                  console.
                </p>
                <ValueViewer
                  value={elements.page.value}
                  bytes={new TextEncoder().encode(elements.page.value).length}
                />
              </>
            ) : null}
            {elements.page?.type === 'other' ? (
              <p className="muted">
                This key holds a <span className="mono">{elements.page.name}</span>, a type that
                comes from a module. DBIDE can show that it exists, rename it, expire it and delete
                it; open the console to read or change what it holds.
              </p>
            ) : null}
          </>
        ) : null}
      </div>

      {dialog === 'ttl' && detail ? (
        <TtlDialog
          keyName={keyName}
          hasTtl={detail.ttlMs !== null}
          onClose={() => setDialog(null)}
          onSet={(ttlMs) =>
            change(
              { op: 'ttl.set', ttlMs },
              {
                title: 'Change the expiry?',
                confirmLabel: 'Set expiry',
                lines: [`Make ${label} in db${db} expire in ${describeTtl(ttlMs)}`],
              },
            )
          }
          onClear={() =>
            change(
              { op: 'ttl.clear' },
              {
                title: 'Remove the expiry?',
                confirmLabel: 'Remove expiry',
                lines: [`Make ${label} in db${db} stay forever`],
              },
            )
          }
        />
      ) : null}
      {dialog === 'rename' ? (
        <RenameKeyDialog
          keyName={keyName}
          onClose={() => setDialog(null)}
          onRename={async (newKey, overwrite) => {
            const ran = await change(
              { op: 'key.rename', newKey, overwrite },
              {
                title: 'Rename this key?',
                confirmLabel: 'Rename',
                refreshTree: true,
                done: `Renamed to “${printable(newKey)}”.`,
                lines: [
                  `Rename ${label} to ${printable(newKey)} in db${db}${overwrite ? ', replacing a key with that name' : ''}`,
                ],
              },
            )
            if (ran) {
              close()
              workbench.openRedis(connectionId, { view: 'key', db, key: newKey })
            }
            return ran
          }}
        />
      ) : null}
      {dialog === 'duplicate' ? (
        <DuplicateKeyDialog
          keyName={keyName}
          db={db}
          databases={clustered ? 1 : (info.data?.databases ?? 16)}
          onClose={() => setDialog(null)}
          onDuplicate={async (newKey, overwrite, toDb) => {
            const ran = await change(
              { op: 'key.copy', newKey, overwrite, toDb: toDb === db ? null : toDb },
              {
                title: 'Duplicate this key?',
                confirmLabel: 'Duplicate',
                refreshTree: true,
                done: `Copied to “${printable(newKey)}”.`,
                lines: [
                  `Copy ${label} in db${db} to ${printable(newKey)} in db${toDb}${overwrite ? ', replacing a key with that name' : ''}`,
                ],
              },
            )
            if (ran) workbench.openRedis(connectionId, { view: 'key', db: toDb, key: newKey })
            return ran
          }}
        />
      ) : null}
    </div>
  )
}
