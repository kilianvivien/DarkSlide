import { useEffect, useId } from 'react';

// Stack of currently mounted, open modals. The topmost (last entry) is the
// only one that consumes Escape — this avoids both modals closing when a
// nested confirm is dismissed, and the older "first listener wins" race that
// you get from per-modal window listeners.
const modalStack: symbol[] = [];

function pushModal(token: symbol) {
  modalStack.push(token);
}

function removeModal(token: symbol) {
  const index = modalStack.lastIndexOf(token);
  if (index >= 0) {
    modalStack.splice(index, 1);
  }
}

function isTopmost(token: symbol) {
  return modalStack[modalStack.length - 1] === token;
}

// Wires Escape-to-close for a modal while it is open, with a tiny module-level
// stack so only the topmost modal actually responds to the keypress.
//
// Returns the dialog title id to be used as `aria-labelledby` on the modal
// container and `id` on the modal's <h2> title — generated once per mount so
// nested dialogs don't collide.
export function useModalA11y(isOpen: boolean, onClose: () => void) {
  const titleId = useId();

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const token = Symbol('modal');
    pushModal(token);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) {
        return;
      }
      if (!isTopmost(token)) {
        return;
      }
      event.preventDefault();
      onClose();
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      removeModal(token);
    };
  }, [isOpen, onClose]);

  return { titleId };
}
