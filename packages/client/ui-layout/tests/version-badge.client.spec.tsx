// @vitest-environment jsdom

import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VersionBadge } from '../src/client/VersionBadge.tsx'
import type { VersionBadgeProps } from '../src/client/VersionBadge.tsx'

describe('VersionBadge', () => {
  it('renders the current Web release', () => {
    const view = render(<VersionBadge {...{} as VersionBadgeProps} />)
    expect(view.container.querySelector('span')?.textContent).toBe('v0.1.0-rc.5 · dev')
  })
})
