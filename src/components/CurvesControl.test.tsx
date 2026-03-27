import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CurvesControl } from './CurvesControl';

describe('CurvesControl', () => {
  it('prevents selecting the helper tooltip while dragging the curve UI', () => {
    const { container } = render(
      <CurvesControl
        curves={{
          rgb: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          red: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          green: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
          blue: [{ x: 0, y: 0 }, { x: 255, y: 255 }],
        }}
        onChange={vi.fn()}
        isColor
      />,
    );

    const surface = container.querySelector('.group');
    const tooltip = screen.getByText('Double-click to add point • Right-click to remove');

    expect(surface).toHaveClass('select-none');
    expect(tooltip.parentElement).toHaveClass('pointer-events-none');
    expect(tooltip).toHaveClass('select-none');
  });
});
