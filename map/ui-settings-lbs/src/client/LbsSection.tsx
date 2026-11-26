/**
 * LBS key pool settings section, aligned with the Models settings page:
 * provider-style row cards with credential dots, one editor card at a time,
 * an add card behind one button, a destructive-removal confirmation dialog,
 * and an aria-live saved notice. Pool-specific controls (usage mode, enable,
 * order) live inside the same editor card. Styles compile from a real
 * `LbsSection.module.css` through the map layer's CSS Modules pipeline, the
 * same mechanism the Models settings page uses.
 */

import { useEffect, useId, useState } from 'react'
import type { ReactNode } from 'react'
import {
  IconPlusOutlineRegular, Modal, SegmentedControl, Switch, Tag,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { LbsKeyMode, LbsVendorId } from '@map-harness/lbs-keyring/contract'
import type { LbsPoolFace } from './pool-controller.ts'
import type { LbsPoolRow, LbsPoolState, LbsPoolVendor } from './pool-model.ts'
import {
  modeHintKey, modeLabelKey, vendorHintKey, vendorLabelKey,
  type LbsSettingsLocaleKey,
} from './locales.ts'
import styles from './LbsSection.module.css'

/** Props the renderer binds for the LBS section. */
export type LbsSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.lbs'>
  & InjectFace<LbsPoolFace>

/** Translate function type for this namespace. */
type Translate = (key: LbsSettingsLocaleKey) => string

const EYE_CONTOUR = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`
const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`

/** Write-only credential input with a reveal toggle, as on the Models page. */
function ApiKeyInput(props: {
  id: string
  value: string
  configured: boolean
  disabled: boolean
  t: Translate
  onChange: (value: string) => void
}): ReactNode {
  const [revealed, setRevealed] = useState<string | undefined>()
  const shown = props.value.length > 0 && revealed === props.value
  return (
    <div className={styles['keyInput']}>
      <input
        id={props.id}
        className={styles['input']}
        type={shown ? 'text' : 'password'}
        autoComplete="new-password"
        value={props.value}
        placeholder={props.configured ? props.t('keyPlaceholderSaved') : props.t('keyPlaceholder')}
        disabled={props.disabled}
        onChange={(event) => { setRevealed(undefined); props.onChange(event.target.value) }}
      />
      {props.value.length === 0 ? null : (
        <button
          type="button"
          className={styles['keyToggle']}
          aria-label={props.t(shown ? 'keyHide' : 'keyReveal')}
          aria-pressed={shown}
          disabled={props.disabled}
          onClick={() => { setRevealed(shown ? undefined : props.value) }}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
            <path d={shown ? EYE_OFF_PATH : EYE_PATH} />
          </svg>
        </button>
      )}
    </div>
  )
}

/** Credential dots and status badges for one key field. */
function KeyBadges(props: { row: LbsPoolRow; t: Translate }): ReactNode {
  const { row, t } = props
  return (
    <div className={styles['badges']} data-lbs-status={row.slot.id}>
      <span
        className={`${styles['credentialDot']} ${row.configured ? styles['credentialDotConfigured'] : styles['credentialDotMissing']}`}
        role="img"
        aria-label={row.configured ? t('credentialConfigured') : t('credentialMissing')}
        title={row.configured ? t('configured') : t('notConfigured')}
      />
      <span data-lbs-active={row.active ? 'true' : 'false'}>
        <Tag tone={row.active ? 'success' : 'quiet'}>{row.active ? t('active') : t('standby')}</Tag>
      </span>
      {!row.enabled ? <Tag tone="quiet">{t('disabled')}</Tag> : null}
      {row.cooling ? <Tag tone="warning">{t('cooling')}</Tag> : <Tag tone="success">{t('healthy')}</Tag>}
      {!row.writable ? <Tag tone="danger">{t('readOnlyKey')}</Tag> : null}
      <span>{`${t('useCount')} ${String(row.useCount)}`}</span>
      {row.failed ? <p className={styles['error']} role="status">{t('rowFailed')}</p> : null}
    </div>
  )
}

/** One key's editor field, with the pool-specific controls inline. */
function KeyField(props: {
  vendor: LbsPoolVendor
  row: LbsPoolRow
  index: number
  total: number
  draft: string
  t: Translate
  disabled: boolean
  onDraft: (value: string) => void
  onRemove: (vendorId: LbsVendorId, slotId: string, ref: string) => void
  face: LbsPoolFace
}): ReactNode {
  const { vendor, row, index, total, draft, t, disabled, onDraft, face } = props
  const inputId = `lbs-key-${vendor.id}-${row.slot.id}`
  return (
    <div className={styles['field']} data-lbs-row={row.slot.id} data-lbs-ref={row.slot.ref}>
      <label className={styles['fieldLabel']} htmlFor={inputId}>
        {`${t('keyLabel')} ${String(index + 1)} · ${row.slot.ref}`}
      </label>
      <ApiKeyInput
        id={inputId}
        value={draft}
        configured={row.configured}
        disabled={disabled}
        t={t}
        onChange={onDraft}
      />
      <p className={styles['hint']}>{t(vendorHintKey(vendor.id))}</p>
      <KeyBadges row={row} t={t} />
      <div className={styles['rowControls']}>
        <Switch
          checked={row.enabled}
          label={t('enableLabel')}
          disabled={disabled}
          onChange={(enabled) => { void face.edit({ kind: 'enable', vendorId: vendor.id, slotId: row.slot.id, enabled }) }}
        />
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled || index === 0}
          onClick={() => { void face.edit({ kind: 'move', vendorId: vendor.id, slotId: row.slot.id, delta: -1 }) }}
        >
          {t('moveUp')}
        </button>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled || index === total - 1}
          onClick={() => { void face.edit({ kind: 'move', vendorId: vendor.id, slotId: row.slot.id, delta: 1 }) }}
        >
          {t('moveDown')}
        </button>
        <button
          type="button"
          className={styles['secondaryButton']}
          disabled={disabled || !row.configured}
          onClick={() => { void face.clear(vendor.id, row.slot.ref) }}
        >
          {t('clear')}
        </button>
        <button
          type="button"
          className={styles['dangerButton']}
          disabled={disabled || !vendor.canRemove}
          onClick={() => { props.onRemove(vendor.id, row.slot.id, row.slot.ref) }}
        >
          {t('remove')}
        </button>
      </div>
    </div>
  )
}

/** Props shared by the vendor editor card and the add card. */
interface EditorProps {
  vendor: LbsPoolVendor
  state: LbsPoolState
  face: LbsPoolFace
  t: Translate
  disabled: boolean
  onClose: () => void
  onSaved: (vendorId: LbsVendorId) => void
  onRemove: (vendorId: LbsVendorId, slotId: string, ref: string) => void
  /** Setup posture renders an emphasized card title. */
  setup?: boolean
}

/** One vendor's editor card: keys, mode, add-button and Apply/Cancel. */
function VendorCard(props: EditorProps): ReactNode {
  const { vendor, state, face, t, disabled, onClose, onSaved, onRemove, setup } = props
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [newKey, setNewKey] = useState('')
  const [addOpen, setAddOpen] = useState(false)
  const [mode, setMode] = useState<LbsKeyMode>(vendor.mode)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | undefined>()
  const idPrefix = useId()
  const apply = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setFailure(undefined)
    const result = await face.applyCard({
      vendorId: vendor.id,
      keys: drafts,
      ...newKey.trim().length > 0 ? { newKey } : {},
      ...mode !== vendor.mode ? { mode } : {},
    })
    setBusy(false)
    if (result.failed.length > 0) {
      setFailure(t('deleteFailure'))
      return
    }
    setDrafts({})
    setNewKey('')
    setAddOpen(false)
    onSaved(vendor.id)
    onClose()
  }
  return (
    <div className={`${styles['rowCard']} ${setup === true ? styles['setupCard'] : ''}`} data-lbs-editor={vendor.id}>
      <div className={styles['rowHead']}>
        <span className={styles['rowIdentity']}>
          <span className={styles['rowName']}>{t(vendorLabelKey(vendor.id))}</span>
          <span className={styles['rowTag']}>{t(modeLabelKey(mode))}</span>
        </span>
      </div>
      <div className={styles['editor']}>
        <div className={styles['editorHeader']}>
          <h3 className={styles['editorTitle']}>{setup === true ? t('setupTitle') : t('title')}</h3>
          <p className={styles['editorRoute']}>{setup === true ? t('setupHint') : t(modeHintKey(mode))}</p>
        </div>
        <div className={styles['field']}>
          <span className={styles['fieldLabel']}>{t('mode.label')}</span>
          <SegmentedControl<LbsKeyMode>
            id={`${idPrefix}-mode-${vendor.id}`}
            label={t('mode.label')}
            value={mode}
            options={state.modes.map(value => ({ value, label: t(modeLabelKey(value)) }))}
            onChange={setMode}
            disabled={disabled || busy}
          />
          <p className={styles['hint']} data-lbs-mode-hint={vendor.id}>{t(modeHintKey(mode))}</p>
        </div>
        {vendor.rows.map((row, index) => (
          <KeyField
            key={row.slot.id}
            vendor={vendor}
            row={row}
            index={index}
            total={vendor.rows.length}
            draft={drafts[row.slot.id] ?? ''}
            t={t}
            disabled={disabled || busy}
            onDraft={(value) => { setDrafts(previous => ({ ...previous, [row.slot.id]: value })) }}
            face={face}
            onRemove={onRemove}
          />
        ))}
        <div className={styles['addBlock']}>
          {addOpen ? (
            <div className={styles['addCard']}>
              <label className={styles['fieldLabel']} htmlFor={`${idPrefix}-new-${vendor.id}`}>{t('apiKeyLabel')}</label>
              <ApiKeyInput
                id={`${idPrefix}-new-${vendor.id}`}
                value={newKey}
                configured={false}
                disabled={disabled || busy}
                t={t}
                onChange={setNewKey}
              />
              <p className={styles['hint']}>{t('addHint')}</p>
              <button type="button" className={styles['secondaryButton']} onClick={() => { setNewKey(''); setAddOpen(false) }}>
                {t('cancel')}
              </button>
            </div>
          ) : (
            <button
              type="button"
              className={styles['addButton']}
              disabled={!vendor.canAdd || busy}
              title={vendor.canAdd ? undefined : t('maxKeys')}
              onClick={() => { setAddOpen(true) }}
            >
              <IconPlusOutlineRegular />
              {t('add')}
            </button>
          )}
        </div>
        {failure === undefined ? null : <p className={styles['error']} role="status">{failure}</p>}
        <div className={styles['editorActions']}>
          <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={styles['primaryButton']} disabled={disabled || busy} onClick={() => { void apply() }}>
            {busy ? t('applying') : t('apply')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Destructive-removal confirmation, as on the Models page. */
function RemoveDialog(props: {
  target: { vendorId: LbsVendorId; slotId: string; ref: string; configured: boolean } | undefined
  t: Translate
  face: LbsPoolFace
  busy: boolean
  setBusy: (busy: boolean) => void
  onClose: () => void
  onRemoved: (vendorId: LbsVendorId) => void
}): ReactNode {
  const { target, t, face, busy, setBusy, onClose, onRemoved } = props
  const [failure, setFailure] = useState<string | undefined>()
  if (target === undefined) return null
  const confirm = async (): Promise<void> => {
    setBusy(true)
    setFailure(undefined)
    try {
      await face.removeSlot(target.vendorId, target.slotId)
      onRemoved(target.vendorId)
      onClose()
    } catch {
      setFailure(t('deleteFailure'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      onClose={onClose}
      closeLabel={t('cancel')}
      title={t('deleteTitle')}
      footer={(
        <div className={styles['modalFooter']}>
          <button type="button" className={styles['secondaryButton']} disabled={busy} onClick={onClose}>{t('cancel')}</button>
          <button type="button" className={styles['dangerButton']} disabled={busy} onClick={() => { void confirm() }}>
            {busy ? t('deleting') : t('deleteConfirm')}
          </button>
        </div>
      )}
    >
      <p className={styles['intro']}>
        {target.configured ? t('deleteDescriptionWithCredential') : t('deleteDescription')}
      </p>
      <p className={styles['hint']}>{target.ref}</p>
      {failure === undefined ? null : <p className={styles['error']} role="status">{failure}</p>}
    </Modal>
  )
}

/**
 * Render the LBS key pool section in the Models page's card language.
 * @param props - locale copy, the section snapshot, and the controller face.
 * @returns the section body.
 */
export function LbsSection(props: LbsSectionProps): ReactNode {
  const { t } = props
  const state = props.useLbs(snapshot => snapshot)
  useEffect(() => { void props.load() }, [props.load])
  const [editing, setEditing] = useState<LbsVendorId | undefined>()
  const [savedVendor, setSavedVendor] = useState<LbsVendorId | undefined>()
  const [removeTarget, setRemoveTarget] = useState<{ vendorId: LbsVendorId; slotId: string; ref: string; configured: boolean } | undefined>()
  const [removing, setRemoving] = useState(false)
  const face: LbsPoolFace = {
    hooks: { lbs: { getSnapshot: () => state, subscribe: () => () => {}, set: () => {}, update: () => {} } },
    load: props.load,
    actions: props.actions,
    clear: props.clear,
    edit: props.edit,
    applyCard: props.applyCard,
    removeSlot: props.removeSlot,
  }
  const readOnly = !state.shell.writable
  const anyConfigured = state.vendors.some(vendor => vendor.configuredCount > 0)
  const firstUnconfigured = state.vendors.find(vendor => vendor.configuredCount === 0)
  const setupVendor = !anyConfigured && editing === undefined ? firstUnconfigured : undefined
  const openCard = (vendorId: LbsVendorId): void => {
    setSavedVendor(undefined)
    setEditing(vendorId)
  }
  return (
    <div className={styles['section']}>
      <h2 className={styles['title']}>{t('title')}</h2>
      <p className={styles['intro']}>{t('intro')}</p>
      {!state.shell.available ? <p className={styles['error']} role="status">{t('loadFailed')}</p> : null}
      {readOnly ? <p className={styles['notice']} role="status">{t('readOnlyNotice')}</p> : null}
      {savedVendor === undefined ? null : (
        <p className={styles['savedNotice']} role="status" aria-live="polite" data-lbs-saved={savedVendor}>
          {t('savedVendor')}
        </p>
      )}
      <ul className={styles['rows']}>
        {state.vendors.map(vendor => {
          if (vendor.id === setupVendor?.id) {
            return (
              <li key={vendor.id}>
                <VendorCard
                  vendor={vendor}
                  state={state}
                  face={face}
                  t={t}
                  disabled={readOnly || state.shell.saving}
                  setup
                  onClose={() => { setEditing(undefined) }}
                  onSaved={(vendorId) => { setSavedVendor(vendorId) }}
                  onRemove={(vendorId, slotId, ref) => { setRemoveTarget({ vendorId, slotId, ref, configured: false }) }}
                />
              </li>
            )
          }
          return (
            <li key={vendor.id} className={styles['rowCard']} data-lbs-vendor={vendor.id}>
              <div className={styles['rowHead']}>
                <span className={styles['rowIdentity']}>
                  <span className={styles['rowName']}>{t(vendorLabelKey(vendor.id))}</span>
                  <span className={styles['rowTag']}>{t(modeLabelKey(vendor.mode))}</span>
                  <span className={styles['dots']} data-lbs-dots={vendor.id}>
                    {vendor.rows.map(row => (
                      <span
                        key={row.slot.id}
                        className={`${styles['credentialDot']} ${row.configured ? styles['credentialDotConfigured'] : styles['credentialDotMissing']}`}
                        role="img"
                        aria-label={row.configured ? t('credentialConfigured') : t('credentialMissing')}
                        title={row.configured ? t('configured') : t('notConfigured')}
                        data-lbs-dot={row.slot.id}
                      />
                    ))}
                  </span>
                  <span data-lbs-summary={vendor.id}>
                    <Tag tone="info">{`${t('configuredSummary')} ${String(vendor.configuredCount)}/${String(vendor.rows.length)}`}</Tag>
                  </span>
                </span>
                <span className={styles['rowActions']} data-lbs-row-actions={vendor.id}>
                  <button
                    type="button"
                    className={styles['secondaryButton']}
                    disabled={state.shell.saving}
                    onClick={() => { openCard(vendor.id) }}
                  >
                    {t('edit')}
                  </button>
                  <button
                    type="button"
                    className={`${styles['addButton']} ${styles['compactAddButton']}`}
                    disabled={state.shell.saving || !vendor.canAdd}
                    onClick={() => { openCard(vendor.id) }}
                  >
                    <IconPlusOutlineRegular />
                    {t('add')}
                  </button>
                </span>
              </div>
              {editing === vendor.id ? (
                <VendorCard
                  vendor={vendor}
                  state={state}
                  face={face}
                  t={t}
                  disabled={readOnly || state.shell.saving}
                  onClose={() => { setEditing(undefined) }}
                  onSaved={(vendorId) => { setSavedVendor(vendorId) }}
                  onRemove={(vendorId, slotId, ref) => {
                    const row = vendor.rows.find(entry => entry.slot.id === slotId)
                    setRemoveTarget({ vendorId, slotId, ref, configured: row?.configured ?? false })
                  }}
                />
              ) : null}
            </li>
          )
        })}
      </ul>
      <RemoveDialog
        target={removeTarget}
        t={t}
        face={face}
        busy={removing}
        setBusy={setRemoving}
        onClose={() => { setRemoveTarget(undefined) }}
        onRemoved={(vendorId) => { setSavedVendor(vendorId) }}
      />
    </div>
  )
}
