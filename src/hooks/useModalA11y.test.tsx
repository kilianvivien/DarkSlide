import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useModalA11y } from './useModalA11y';

function Modal({ label, onClose }: { label: string; onClose: () => void }) {
  const { titleId } = useModalA11y(true, onClose);
  return (
    <div role="dialog" aria-modal="true" aria-labelledby={titleId} data-testid={label}>
      <h2 id={titleId}>{label}</h2>
    </div>
  );
}

describe('useModalA11y', () => {
  it('only the topmost modal closes on Escape', () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    function Fixture() {
      const [innerOpen, setInnerOpen] = useState(true);
      return (
        <>
          <Modal label="outer" onClose={closeOuter} />
          {innerOpen && (
            <Modal
              label="inner"
              onClose={() => {
                closeInner();
                setInnerOpen(false);
              }}
            />
          )}
        </>
      );
    }
    render(<Fixture />);

    // First Escape goes to the topmost (inner) modal only.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeInner).toHaveBeenCalledTimes(1);
    expect(closeOuter).not.toHaveBeenCalled();

    // Inner unmounts, so the next Escape now reaches the outer modal.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(closeOuter).toHaveBeenCalledTimes(1);
  });

  it('generates a stable title id for aria-labelledby', () => {
    render(<Modal label="settings" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy!)?.textContent).toBe('settings');
  });

  it('does not consume Escape when the modal is closed', () => {
    const onClose = vi.fn();
    function ClosedModal() {
      useModalA11y(false, onClose);
      return null;
    }
    render(<ClosedModal />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
