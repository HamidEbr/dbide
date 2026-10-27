import { Database, Leaf, Rabbit, Zap, type LucideIcon } from 'lucide-react'
import { useId, type ComponentPropsWithRef, type ReactNode } from 'react'
import type { EngineKind } from '@shared/connection'
import { ENVIRONMENT_POLICIES, type Environment } from '@shared/environment'
import { formatShortcut } from '@/commands/keybinding'

type ButtonVariant = 'default' | 'primary' | 'ghost' | 'danger'

interface ButtonProps extends ComponentPropsWithRef<'button'> {
  variant?: ButtonVariant
  icon?: ReactNode
}

export function Button({ variant = 'default', icon, children, className, ...rest }: ButtonProps) {
  return (
    <button type="button" className={`btn btn-${variant} ${className ?? ''}`} {...rest}>
      {icon}
      {children}
    </button>
  )
}

interface IconButtonProps extends ComponentPropsWithRef<'button'> {
  label: string
}

export function IconButton({ label, children, className, ...rest }: IconButtonProps) {
  return (
    <button
      type="button"
      className={`icon-btn ${className ?? ''}`}
      aria-label={label}
      title={label}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Renders a shortcut as key caps, with the right glyphs for the current OS. */
export function Kbd({ shortcut }: { shortcut: string }) {
  return (
    <span className="kbd-group" aria-label={shortcut}>
      {formatShortcut(shortcut, window.dbide.platform).map((cap, index) => (
        <kbd key={index}>{cap}</kbd>
      ))}
    </span>
  )
}

export function EnvDot({ environment }: { environment: Environment }) {
  return (
    <span className="env-dot" style={{ background: `var(--env-${environment})` }} aria-hidden />
  )
}

export function EnvBadge({ environment }: { environment: Environment }) {
  return (
    <span className="env-badge" style={{ ['--env' as string]: `var(--env-${environment})` }}>
      <EnvDot environment={environment} />
      {ENVIRONMENT_POLICIES[environment].label}
    </span>
  )
}

const ENGINE_ICONS: Record<EngineKind, LucideIcon> = {
  mysql: Database,
  postgresql: Database,
  mssql: Database,
  mongodb: Leaf,
  redis: Zap,
  rabbitmq: Rabbit,
}

export function EngineIcon({ engine, size = 14 }: { engine: EngineKind; size?: number }) {
  const Icon = ENGINE_ICONS[engine]
  return <Icon size={size} aria-hidden />
}

interface FieldProps {
  label: string
  hint?: ReactNode
  error?: string | undefined
  children: (id: string) => ReactNode
}

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId()
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint">{hint}</p>
      ) : null}
    </div>
  )
}

interface SegmentedProps<T extends string> {
  label: string
  value: T
  options: { value: T; label: string; swatch?: string }[]
  onChange: (value: T) => void
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: SegmentedProps<T>) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? 'on' : ''}
          onClick={() => onChange(option.value)}
        >
          {option.swatch ? (
            <span className="env-dot" style={{ background: option.swatch }} aria-hidden />
          ) : null}
          {option.label}
        </button>
      ))}
    </div>
  )
}
