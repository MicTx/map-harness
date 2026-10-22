import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

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
 * Render the Map Harness name without an independently slotted mark.
 * @returns the product name text.
 */
export function MapHarnessName() {
  return <span>Map Harness</span>
}
