import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HistogramData } from '../types';
import { Histogram } from './Histogram';

function createHistogram(): HistogramData {
  const data = {
    r: new Array<number>(256).fill(0),
    g: new Array<number>(256).fill(0),
    b: new Array<number>(256).fill(0),
    l: new Array<number>(256).fill(0),
  };
  data.l[0] = 10;
  data.l[64] = 30;
  data.l[128] = 50;
  data.l[220] = 20;
  data.l[255] = 5;
  data.r[120] = 40;
  data.g[130] = 40;
  data.b[140] = 40;
  return data;
}

describe('Histogram', () => {
  it('shows clipping, tonal percentiles, and selectable channels', () => {
    render(<Histogram data={createHistogram()} blackPoint={8} whitePoint={245} />);

    expect(screen.getByText(/Median 128/)).toBeInTheDocument();
    expect(screen.getByText(/P1 0/)).toBeInTheDocument();
    expect(screen.getByText(/P99 255/)).toBeInTheDocument();
    expect(screen.getByText(/◀ 8.7%/)).toHaveClass('text-red-400');
    expect(screen.getByText(/4.3% ▶/)).toHaveClass('text-red-400');

    const redChannel = screen.getByRole('button', { name: 'Toggle R histogram channel' });
    expect(redChannel).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(redChannel);
    expect(redChannel).toHaveAttribute('aria-pressed', 'false');
  });
});
