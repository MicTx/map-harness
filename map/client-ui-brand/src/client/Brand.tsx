import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { BUILD_ORG_NAME } from './edition-env.ts'
import { BRAND_HEADLINE, editionLine } from './edition.ts'

/**
 * Render the Map Harness mark: a map-pin glyph drawn inline so the overlay
 * carries no binary asset and stays independent of upstream brand art.
 * @param props - Host-supplied mark presentation.
 * @returns the map pin mark.
 */
export function MapHarnessMark({ size }: SidebarBrandMarkOwnerProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M12 2C7.9 2 4.5 5.3 4.5 9.4c0 5.4 6.6 12 7.5 12s7.5-6.6 7.5-12C19.5 5.3 16.1 2 12 2Z"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="9.4" r="2.6" fill="currentColor" />
    </svg>
  )
}

/**
 * Render the brand headline over its edition line (organization or community).
 * @returns the two-line product name.
 */
export function MapHarnessName() {
  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', lineHeight: 1.25 }}>
      <span>{BRAND_HEADLINE}</span>
      <span style={{ fontSize: '0.75em', opacity: 0.7 }}>{editionLine(BUILD_ORG_NAME)}</span>
    </span>
  )
}
