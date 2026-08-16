// @vitest-environment jsdom

import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { VersionBadge } from '../src/client/VersionBadge.tsx'
import type { VersionBadgeProps } from '../src/client/VersionBadge.tsx'

describe('VersionBadge', () => {
  it('renders the current Web release', () => {
    render(<VersionBadge {...{} as VersionBadgeProps} />)
    expect(screen.getByText('v0.1.0-rc.5')).toBeTruthy()
  })
})
