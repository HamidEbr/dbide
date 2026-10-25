/**
 * Connection environments act as policy bundles: choosing "prod" changes how the whole
 * window looks and behaves, not just a label.
 */
export type Environment = 'local' | 'dev' | 'staging' | 'prod'

export const ENVIRONMENTS: readonly Environment[] = ['local', 'dev', 'staging', 'prod']

export interface EnvironmentPolicy {
  label: string
  /** Connections open read-only until the user explicitly unlocks them. */
  readOnlyByDefault: boolean
  /** Destructive actions need the user to type the object name. */
  confirmDestructive: boolean
  /** Statements run only after an explicit confirmation. */
  confirmBeforeExecute: boolean
  autoCommit: boolean
}

export const ENVIRONMENT_POLICIES: Record<Environment, EnvironmentPolicy> = {
  local: {
    label: 'Local',
    readOnlyByDefault: false,
    confirmDestructive: false,
    confirmBeforeExecute: false,
    autoCommit: true,
  },
  dev: {
    label: 'Dev',
    readOnlyByDefault: false,
    confirmDestructive: false,
    confirmBeforeExecute: false,
    autoCommit: true,
  },
  staging: {
    label: 'Staging',
    readOnlyByDefault: false,
    confirmDestructive: true,
    confirmBeforeExecute: false,
    autoCommit: true,
  },
  prod: {
    label: 'Prod',
    readOnlyByDefault: true,
    confirmDestructive: true,
    confirmBeforeExecute: true,
    autoCommit: false,
  },
}
