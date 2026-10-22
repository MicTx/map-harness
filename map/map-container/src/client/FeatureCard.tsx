/**
 * The feature attribute card: a floating panel at the map's top-left that
 * shows one hovered feature's fields as plain text (`inspectionOf`). It
 * stays inside the map container, closes on its button or Escape, and
 * clears the feature highlight on close.
 */
import { useEffect, type ReactNode } from 'react'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { FeatureInspection } from './popup.ts'

/** Card props: the open inspection, the close action, and the locale. */
export interface FeatureCardProps {
  readonly inspection: FeatureInspection
  readonly onClose: () => void
  readonly t: TranslateNS<'mapContainer'>
}

/**
 * Render one feature's attribute card.
 * @param props - the inspection, close action, and locale.
 * @returns the card element.
 */
export function FeatureCard({ inspection, onClose, t }: FeatureCardProps): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const heading = inspection.title ?? inspection.layerName
  return (
    <section data-map-feature-card="" role="dialog" aria-label={t('feature.card', { name: heading })}>
      <header data-map-feature-card-head="">
        <div>
          <h3>{heading}</h3>
          {inspection.title !== null && <p>{inspection.layerName}</p>}
        </div>
        <button type="button" data-map-panel-icon="" aria-label={t('feature.close')} title={t('feature.close')} onClick={onClose}>×</button>
      </header>
      {inspection.fields.length === 0
        ? <p data-map-feature-card-empty="">{t('feature.empty')}</p>
        : (
            <dl>
              {inspection.fields.map(field => (
                <div key={field.name}>
                  <dt title={field.name}>{field.name}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          )}
      {inspection.omitted > 0 && <p data-map-feature-card-more="">{t('feature.omitted', { n: String(inspection.omitted) })}</p>}
    </section>
  )
}
