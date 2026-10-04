import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { buildEmptyHistogram } from '../utils/imagePipeline';
import { Histogram } from './Histogram';

function saturatedRedHistogram() {
  const histogram = buildEmptyHistogram();
  histogram.r[255] = 10;
  histogram.g[0] = 10;
  histogram.b[0] = 10;
  histogram.l[54] = 10;
  for (const channel of ['r', 'g', 'b', 'l'] as const) {
    histogram[channel][128] += 990;
  }
  return histogram;
}

describe('Histogram', () => {
  it('shows an empty state without data', () => {
    render(<Histogram data={null} />);
    expect(screen.getByText('No Data')).toBeInTheDocument();
  });

  it('renders dashes for percentiles of an all-zero histogram', () => {
    render(<Histogram data={buildEmptyHistogram()} />);
    expect(screen.getByText('P1 —')).toBeInTheDocument();
    expect(screen.getByText('Median —')).toBeInTheDocument();
    expect(screen.getByText('P99 —')).toBeInTheDocument();
  });

  it('flags channel clipping even when luminance is not clipped', () => {
    render(<Histogram data={saturatedRedHistogram()} />);
    const highlight = screen.getByTestId('histogram-highlight-clipping');
    expect(highlight).toHaveTextContent('1.0% ▶');
    expect(highlight).toHaveClass('text-red-400');
    expect(highlight.getAttribute('data-tip')).toContain('R 1.0%');
    expect(highlight.getAttribute('data-tip')).toContain('Luminance 0%');
  });

  it('toggles channels but never hides the last visible one', () => {
    render(<Histogram data={saturatedRedHistogram()} />);
    for (const name of ['red', 'green', 'blue']) {
      fireEvent.click(screen.getByRole('button', { name: `Show ${name} histogram` }));
      expect(screen.getByRole('button', { name: `Show ${name} histogram` })).toHaveAttribute('aria-pressed', 'false');
    }
    const luminance = screen.getByRole('button', { name: 'Show luminance histogram' });
    fireEvent.click(luminance);
    expect(luminance).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows only luminance for black-and-white output and recovers when switching back', () => {
    const data = saturatedRedHistogram();
    const { rerender } = render(<Histogram data={data} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show luminance histogram' }));

    rerender(<Histogram data={data} variant="neutral" />);
    expect(screen.queryByRole('button', { name: 'Show red histogram' })).not.toBeInTheDocument();
    // Luminance was hidden in colour mode, but the B&W chart is never empty.
    expect(screen.getByRole('button', { name: 'Show luminance histogram' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('histogram-highlight-clipping')).toHaveTextContent('0% ▶');

    rerender(<Histogram data={data} variant="color" />);
    expect(screen.getByRole('button', { name: 'Show red histogram' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('makes the logarithmic scale explicit', () => {
    render(<Histogram data={saturatedRedHistogram()} />);
    const log = screen.getByRole('button', { name: 'Logarithmic histogram scale' });
    expect(log).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(log);
    expect(log).toHaveAttribute('aria-pressed', 'true');
    expect(log.getAttribute('data-tip')).toMatch(/Logarithmic/);
  });
});
